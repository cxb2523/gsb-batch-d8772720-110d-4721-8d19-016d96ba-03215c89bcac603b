import hashlib
import json
import multiprocessing as mp
import os
import pickle
import shutil
import subprocess

from git import Repo
from github import Github, Auth
from tqdm import tqdm

import util
from .scanner import Scanner, App


# Failures of individual repositories are reported to this file, which lives
# next to the clone cache (cache/) but outside the clone cache itself
# (cache/repos/), so it never mixes with application entries in SUMMARY.md.
FAILURES_FILENAME = "github_meta_failures.json"

# Stages reported for a failed repository check.
STAGE_CLONE = "clone"
STAGE_UPDATE = "update"
STAGE_GREP = "grep"
STAGE_CONTRIBUTOR = "contributor"
# Catch-all for an unexpected exception that nobody else classified.
STAGE_CHECK = "check"

_SHIZUKU_IMPORT_GREP = 'grep -m 1 -rnw "import rikka.shizuku.Shizuku"'
_MAX_REASON_LENGTH = 300


def default_cache_dir() -> str:
    repo_root = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    return os.path.join(repo_root, 'cache')


def default_failures_path() -> str:
    return os.path.join(default_cache_dir(), FAILURES_FILENAME)


def _failure_entry(name: str, url: str, stage: str, error: BaseException,
                   scanner_name: str) -> dict:
    """Build a JSON-serialisable description of one failed repo check."""
    error_type = type(error).__name__
    try:
        reason = str(error)
    except Exception:
        reason = "<unprintable exception>"
    # Keep the reason on a single line and bounded so the file stays readable.
    reason = " ".join(reason.split())
    if len(reason) > _MAX_REASON_LENGTH:
        reason = reason[:_MAX_REASON_LENGTH] + "..."
    return {
        "name": name,
        "url": url,
        "stage": stage,
        "error_type": error_type,
        "reason": reason,
        "scanner": scanner_name,
    }


def _failure_key(entry: dict) -> tuple:
    # The scanner name is deliberately excluded: the same repository is tried by
    # both meta scanners, and the round report should list it once.
    return (
        entry.get("name"),
        entry.get("url"),
        entry.get("stage"),
        entry.get("error_type"),
        entry.get("reason"),
    )


def _unwrap(error: BaseException) -> BaseException:
    """Return the underlying exception for a wrapper raised by _ensure_clone."""
    cause = getattr(error, "cause", None)
    return cause if isinstance(cause, BaseException) else error


class FailureLog:
    """Collects per-repository check failures for one crawler round.

    A log is shared by the GitHub meta scanners so that the round-level file
    contains every failure, and it is also usable standalone by a single
    scanner. ``autosave`` is disabled when the caller (main.py) wants to print
    and persist the aggregated result exactly once at the end of the round.
    """

    def __init__(self, path: str = None, autosave: bool = True):
        self.path = path or default_failures_path()
        self.autosave = autosave
        self.entries = []

    def add(self, entries) -> None:
        seen = {_failure_key(e) for e in self.entries}
        for entry in entries:
            key = _failure_key(entry)
            if key not in seen:
                seen.add(key)
                self.entries.append(entry)

    def write(self) -> None:
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            # An empty list (not a missing file) is written when nothing failed,
            # so a stale failure list can never survive a successful round.
            json.dump(self.entries, f, indent=2, ensure_ascii=False)
            f.write("\n")

    def print_summary(self, log_prefix: str = "github_meta") -> None:
        if not self.entries:
            print(f"{log_prefix}: no repository check failures this round")
            return
        print(f"{log_prefix}: {len(self.entries)} repository check failure(s) this round:")
        for entry in self.entries:
            print(f"  - {entry['name']} ({entry['url']}) [{entry['stage']}] "
                  f"{entry['error_type']}: {entry['reason']}")

    def finish(self, log_prefix: str = "github_meta") -> None:
        """Print the summary and persist the failure list (overwriting stale data)."""
        self.print_summary(log_prefix)
        self.write()


class RepoFetchError(Exception):
    """Clone/update failure that carries the pipeline stage and the root cause."""

    def __init__(self, stage: str, url: str, cause: BaseException):
        super().__init__(f"{type(cause).__name__}: {cause}")
        self.stage = stage
        self.url = url
        self.cause = cause


def _check_one_repo(task):
    """Pool entry point: never raises, so one failing repo cannot stop the map.

    Returns ``(apps, failures)`` because the failures recorded by ``check_repo``
    inside a worker process would otherwise be lost when results come back to
    the parent.
    """
    scanner, args = task
    before = len(scanner.failures)
    try:
        apps = scanner.check_repo(args)
        return list(apps or []), list(scanner.failures[before:])
    except Exception as e:
        url = args.urls[0] if getattr(args, "urls", None) else ""
        entry = _failure_entry(args.name, url, STAGE_CHECK, _unwrap(e),
                               type(scanner).__name__)
        # Keep anything the check managed to record before it blew up.
        return [], list(scanner.failures[before:]) + [entry]


class GithubMetaScanner(Scanner):
    log_prefix = "github_meta"

    def __init__(self, auth_token, exclude: list[App], process_count=1,
                 failure_log: FailureLog = None, clone_fn=None, clones_dir: str = None):
        self.auth = Github(auth=Auth.Token(auth_token))
        self.exclude = exclude
        self.process_count = process_count
        # Optional injection point for tests: callable(url, path) creating a clone.
        # Resolved lazily so monkeypatching Repo.clone_from still works.
        self.clone_fn = clone_fn
        # directory where cached repo clones will be stored
        if clones_dir is None:
            repo_root = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
            clones_dir = os.path.join(repo_root, 'cache', 'repos')
        self.clones_dir = clones_dir
        os.makedirs(self.clones_dir, exist_ok=True)
        # Keep the failure report next to (but outside) the clone cache.
        self.failures_path = os.path.join(os.path.dirname(self.clones_dir),
                                          FAILURES_FILENAME)
        self.failure_log = failure_log if failure_log is not None else FailureLog(self.failures_path)
        # Failures recorded by the current find_matching_apps() invocation.
        self.failures = []

    def _repo_id(self, url: str) -> str:
        # create a filesystem-safe id for the repo based on its URL
        h = hashlib.sha1(url.encode('utf-8')).hexdigest()
        return h

    def _clone_repo(self, url: str, path: str):
        """Create the shallow clone. Overridable/injectable for tests."""
        if self.clone_fn is not None:
            return self.clone_fn(url, path)
        return Repo.clone_from(url, path, depth=1)

    def _ensure_clone(self, url: str) -> str:
        """Return path to a local clone for the given URL. Create a shallow clone if missing."""
        rid = self._repo_id(url)
        path = os.path.join(self.clones_dir, rid)
        if os.path.exists(path):
            # already exists; attempt a shallow fetch to update
            try:
                repo = Repo(path)
                # fetch latest from origin without pulling full history
                repo.remote().fetch(prune=True)
            except Exception as e:
                # Existing clones are not re-cloned automatically: drop the
                # directory and report the failure for this repository only.
                try:
                    shutil.rmtree(path)
                except Exception:
                    pass
                raise RepoFetchError(STAGE_UPDATE, url, e) from e
        if not os.path.exists(path):
            try:
                self._clone_repo(url, path)
            except Exception as e:
                # In case of failure, ensure no partial dir remains
                if os.path.exists(path):
                    try:
                        shutil.rmtree(path)
                    except Exception:
                        pass
                raise RepoFetchError(STAGE_CLONE, url, e) from e
        return path

    def _check_original_content(self, url: str) -> bool:
        """Check if repo owner is in the contributor list using GitHub API.

        Errors are intentionally *not* swallowed here: ``check_repo`` records
        them as contributor-check failures and falls back to True, preserving
        the previous inclusion behaviour for that one repository.
        """
        # Extract repo owner and name from URL (format: https://github.com/owner/repo)
        parts = url.split('/')
        repo_owner = parts[-2].lower()

        # Get the repository object from GitHub API
        repo_full_name = f"{parts[-2]}/{parts[-1]}"
        repo = self.auth.get_repo(repo_full_name, lazy=True)
        if repo.owner.type == "Organization":
            return True

        # Get contributors from the repository
        contributors = repo.get_contributors()
        contributor_logins = {c.login.lower() for c in contributors}

        # Check if repo owner is in the contributor list
        return repo_owner in contributor_logins

    def _repo_contains_shizuku_import(self, repo_path: str) -> bool:
        """Grep the clone for the strict Shizuku import marker.

        Raises on grep failures (missing directory, broken shell/grep, grep
        status >= 2) so ``check_repo`` can report them instead of silently
        treating the repository as unmatched.
        """
        result = subprocess.Popen(_SHIZUKU_IMPORT_GREP,
                                  cwd=repo_path,
                                  shell=True,
                                  stdout=subprocess.DEVNULL,
                                  stderr=subprocess.STDOUT)
        result.communicate()
        return_code = result.returncode

        if return_code == 0:
            return True
        if return_code == 1:
            # grep found no match: a normal, non-failing outcome.
            return False
        raise RuntimeError(f"grep exited with status {return_code}")

    def _record_failure(self, name: str, url: str, stage: str, error: BaseException) -> None:
        cause = _unwrap(error)
        entry = _failure_entry(name, url, stage, cause, type(self).__name__)
        self.failures.append(entry)
        print(f"{self.log_prefix}: {stage} check failed for {name} ({url}): "
              f"{entry['error_type']}: {entry['reason']}")

    def check_repo(self, args: App):
        # Use cached clone if available to avoid full re-clone
        name = args.name
        desc = args.desc
        url = args.urls[0]

        print(f"{self.log_prefix}: checking " + args.name + "...")
        app = []

        clone_path = os.path.join(self.clones_dir, self._repo_id(url))
        existed_before = os.path.exists(clone_path)
        try:
            repo_path = self._ensure_clone(url)
        except Exception as e:
            # Wrapped errors carry their stage; a bare exception (e.g. from an
            # injected/overridden clone helper) is classified by whether a clone
            # already existed before the attempt.
            stage = getattr(e, "stage", None)
            if not isinstance(stage, str) or not stage:
                stage = STAGE_UPDATE if existed_before else STAGE_CLONE
            self._record_failure(name, url, stage, e)
            return app

        # search for the target import string inside the repository
        try:
            has_marker = self._repo_contains_shizuku_import(repo_path)
        except Exception as e:
            self._record_failure(name, url, STAGE_GREP, e)
            return app

        if has_marker:
            try:
                is_original = self._check_original_content(url)
            except Exception as e:
                # Keep the repo (with the previous optimistic default) but leave
                # a visible record that its contributor check failed.
                self._record_failure(name, url, STAGE_CONTRIBUTOR, e)
                is_original = True
            app.append(App(
                name,
                desc,
                [url],
                type(self).__name__,
                args.has_downloads,
                args.last_updated,
                is_original_content=is_original,
                popularity=args.popularity,
            ))

        return app

    def _check_with_pool(self, tasks):
        """Check tasks in a process pool, isolating any single-task failure."""
        outcomes = [None] * len(tasks)
        pool_tasks = []
        for index, task in enumerate(tasks):
            try:
                # Verify the task can cross the process boundary first; an
                # unpicklable injected helper would otherwise be lost silently
                # (or hang) inside a worker queue.
                pickle.dumps(task)
                pool_tasks.append(index)
            except Exception:
                outcomes[index] = _check_one_repo(task)

        if pool_tasks:
            pool = None
            try:
                pool = mp.Pool(self.process_count, maxtasksperchild=1)
                results = pool.map(_check_one_repo, [tasks[i] for i in pool_tasks])
                for index, result in zip(pool_tasks, results):
                    outcomes[index] = result
            except Exception as e:
                # A pool-level failure (e.g. a worker dying) must not lose the
                # round: redo the unfinished checks in-process.
                print(f"{self.log_prefix}: repository check pool failed ({e}); "
                      f"falling back to sequential checks")
                if pool is not None:
                    try:
                        pool.terminate()
                    except Exception:
                        pass
                for index in pool_tasks:
                    if outcomes[index] is None:
                        outcomes[index] = _check_one_repo(tasks[index])
            finally:
                if pool is not None:
                    try:
                        pool.close()
                    except Exception:
                        pass
                    try:
                        pool.join()
                    except Exception:
                        pass

        return outcomes

    def _check_candidates(self, candidates: list[App]) -> list[App]:
        """Check every candidate, collecting per-repo failures without aborting.

        A failure in one repository (clone, update, grep or contributor check)
        yields no app for that repository but never interrupts the pool or the
        remaining candidates.
        """
        self.failures = []
        tasks = [(self, args) for args in candidates]

        if tasks and self.process_count and self.process_count > 1:
            outcomes = self._check_with_pool(tasks)
        else:
            outcomes = [_check_one_repo(task) for task in tasks]

        apps = []
        collected = []
        for repo_apps, repo_failures in outcomes:
            apps.extend(repo_apps)
            collected.extend(repo_failures)

        # In-process checks also append directly to self.failures; keep this
        # single authoritative list so nothing is duplicated or lost.
        self.failures = collected
        self.failure_log.add(collected)
        if self.failure_log.autosave:
            # Standalone use (outside main.py) reports its own round.
            self.failure_log.finish(self.log_prefix)

        return apps

    def _cleanup_stale_clones(self, desired_urls):
        """Remove cached clone directories that are not in desired_urls."""
        desired_ids = {self._repo_id(u) for u in desired_urls}
        try:
            for name in os.listdir(self.clones_dir):
                path = os.path.join(self.clones_dir, name)
                if not os.path.isdir(path):
                    continue
                if name not in desired_ids:
                    try:
                        print(f"{self.log_prefix}: removing stale cached clone {name}")
                        shutil.rmtree(path)
                    except Exception as e:
                        print(f"{self.log_prefix}: failed to remove {path}: {e}")
        except FileNotFoundError:
            return

    def find_matching_apps(self):
        results = self.auth.search_repositories('(shizuku AND NOT RepainterServicePriv) in:readme in:topics in:description language:Dart '
                                                'language:Kotlin language:Java', 'stars', 'desc')

        # print results
        print(f'{self.log_prefix}: found {results.totalCount} repos')

        full_results = []
        for repo in tqdm(results, total=results.totalCount):
            if (repo.html_url in util.flatten([x.urls for x in self.exclude]) or
                    util.is_known_app(repo.name, [repo.html_url]) or
                    util.is_ignored(repo.name) or util.is_ignored(repo.html_url)):
                continue

            full_results.append(App(repo.name, repo.description, [repo.html_url], type(self).__name__,
                                    len(repo.get_releases().get_page(0)) > 0, repo.pushed_at,
                                    is_original_content=True, popularity=repo.stargazers_count))

        filtered_results = util.filter_known_apps(full_results, self.exclude)

        # Cleanup stale clones that are not present in this run
        desired_urls = [a.urls[0] for a in filtered_results]
        self._cleanup_stale_clones(desired_urls)

        return self._check_candidates(filtered_results)
