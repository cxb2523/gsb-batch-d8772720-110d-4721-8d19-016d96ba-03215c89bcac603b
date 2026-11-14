"""Tests for per-repository failure isolation in the GitHub metadata scanner.

All repositories are local fixture directories; no network access is used.
Clone failures are simulated by an injected clone function.
"""
import json
import os
import shutil

import pytest

from scanners.github_meta_scanner import (
    GithubMetaScanner,
    FailureLog,
    FAILURES_FILENAME,
    STAGE_CLONE,
    STAGE_UPDATE,
    STAGE_GREP,
)
from scanners.scanner import App
from scanners.shizuku_modules_scanner import ShizukuModulesScanner

from .conftest import FakeGitHub, FakeRepo


MARKER = "import rikka.shizuku.Shizuku;\n"


def _make_repo_dir(root, name, content=MARKER):
    path = os.path.join(root, name)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "Example.kt"), "w", encoding="utf-8") as f:
        f.write(content)
    return path


def fake_clone(url, path):
    """Top-level (picklable) clone helper: copies a fixture dir named by the URL.

    A ``FAIL_CLONE`` marker file in the fixture directory simulates a clone
    error for that repository only.
    """
    fixture_root = os.environ["FAKE_REPO_ROOT"]
    source = os.path.join(fixture_root, url.rstrip("/").rsplit("/", 1)[-1])
    if os.path.exists(os.path.join(source, "FAIL_CLONE")):
        raise RuntimeError("simulated clone failure for " + url)
    shutil.copytree(source, path)


class CountingClone:
    """Non-picklable wrapper used to prove a function was / was not called."""

    def __init__(self):
        self.calls = []

    def __call__(self, url, path):
        self.calls.append(url)
        fake_clone(url, path)


@pytest.fixture
def fixture_root(tmp_path, monkeypatch):
    root = tmp_path / "fixtures"
    root.mkdir()
    monkeypatch.setenv("FAKE_REPO_ROOT", str(root))
    return str(root)


def make_scanner(tmp_path, repos, process_count=1, clone_fn=fake_clone, log=None):
    scanner = GithubMetaScanner(
        "test-token",
        exclude=[],
        process_count=process_count,
        failure_log=log,
        clone_fn=clone_fn,
        clones_dir=str(tmp_path / "cache" / "repos"),
    )
    scanner.auth = FakeGitHub(repos)
    return scanner


def app_for(repo):
    return App(repo.name, repo.description, [repo.html_url], "GithubMetaScanner")


def read_failures(scanner):
    with open(scanner.failure_log.path, encoding="utf-8") as f:
        return json.load(f)


def test_normal_repo_is_included_and_no_failure_file_entries(
        tmp_path, fixture_root, monkeypatch):
    _make_repo_dir(fixture_root, "good")
    repo = FakeRepo("org", "good", "https://github.com/org/good")
    scanner = make_scanner(tmp_path, [repo])

    apps = scanner.find_matching_apps()

    assert [a.name for a in apps] == ["good"]
    assert apps[0].urls == ["https://github.com/org/good"]
    # No failures: the file is an empty list (not stale data).
    assert read_failures(scanner) == []
    # The report lives outside the clone cache.
    assert not os.path.exists(os.path.join(scanner.clones_dir, "github_meta_failures.json"))
    assert os.path.isfile(os.path.join(str(tmp_path / "cache"), FAILURES_FILENAME))


def test_repo_without_import_marker_is_not_included(tmp_path, fixture_root):
    _make_repo_dir(fixture_root, "mentions", "class Foo { val s = 'shizuku' }\n")
    repo = FakeRepo("org", "mentions", "https://github.com/org/mentions")
    scanner = make_scanner(tmp_path, [repo])

    assert scanner.find_matching_apps() == []
    assert read_failures(scanner) == []


def test_single_clone_failure_does_not_drop_other_repos(tmp_path, fixture_root, capsys):
    _make_repo_dir(fixture_root, "good1")
    _make_repo_dir(fixture_root, "broken")
    _make_repo_dir(fixture_root, "good2")
    with open(os.path.join(fixture_root, "broken", "FAIL_CLONE"), "w") as f:
        f.write("")
    repos = [
        FakeRepo("org", "good1", "https://github.com/org/good1"),
        FakeRepo("org", "broken", "https://github.com/org/broken"),
        FakeRepo("org", "good2", "https://github.com/org/good2"),
    ]
    scanner = make_scanner(tmp_path, repos)

    apps = scanner.find_matching_apps()

    assert sorted(a.name for a in apps) == ["good1", "good2"]
    failures = read_failures(scanner)
    assert len(failures) == 1
    failure = failures[0]
    assert failure["name"] == "broken"
    assert failure["url"] == "https://github.com/org/broken"
    assert failure["stage"] == STAGE_CLONE
    assert failure["error_type"] == "RuntimeError"
    assert "simulated clone failure" in failure["reason"]
    # The failure is also summarised on the console.
    out = capsys.readouterr().out
    assert "broken" in out and "https://github.com/org/broken" in out
    assert "1 repository check failure" in out


def test_existing_clone_update_failure_is_recorded_and_dir_removed(tmp_path, fixture_root):
    repo = FakeRepo("org", "stale", "https://github.com/org/stale")
    scanner = make_scanner(tmp_path, [repo])
    clone_path = os.path.join(scanner.clones_dir, scanner._repo_id(repo.html_url))
    # A directory that is not a valid git repository makes the fetch fail.
    os.makedirs(clone_path)
    with open(os.path.join(clone_path, "leftover.txt"), "w") as f:
        f.write("x")

    apps = scanner.find_matching_apps()

    assert apps == []
    assert not os.path.exists(clone_path), "failed update must delete the clone dir"
    failures = read_failures(scanner)
    assert len(failures) == 1
    assert failures[0]["stage"] == STAGE_UPDATE
    assert failures[0]["name"] == "stale"
    assert failures[0]["error_type"] == "InvalidGitRepositoryError"


def test_update_failure_does_not_affect_other_repo(tmp_path, fixture_root):
    _make_repo_dir(fixture_root, "fresh")
    fresh = FakeRepo("org", "fresh", "https://github.com/org/fresh")
    stale = FakeRepo("org", "stale", "https://github.com/org/stale")
    scanner = make_scanner(tmp_path, [fresh, stale])
    os.makedirs(os.path.join(scanner.clones_dir, scanner._repo_id(stale.html_url)))

    apps = scanner.find_matching_apps()

    assert [a.name for a in apps] == ["fresh"]
    assert [f["name"] for f in read_failures(scanner)] == ["stale"]


def test_grep_failure_is_recorded_and_isolated(tmp_path, fixture_root):
    _make_repo_dir(fixture_root, "good")

    def clone_without_dir(url, path):
        # Reports success but leaves no directory behind, so grep cannot run.
        if url.endswith("/grepbroken"):
            return
        fake_clone(url, path)

    apps_repos = [
        FakeRepo("org", "good", "https://github.com/org/good"),
        FakeRepo("org", "grepbroken", "https://github.com/org/grepbroken"),
    ]
    scanner = make_scanner(tmp_path, apps_repos, clone_fn=clone_without_dir)

    apps = scanner.find_matching_apps()

    assert [a.name for a in apps] == ["good"]
    failures = read_failures(scanner)
    assert len(failures) == 1
    assert failures[0]["name"] == "grepbroken"
    assert failures[0]["stage"] == STAGE_GREP
    assert failures[0]["url"] == "https://github.com/org/grepbroken"


def test_contributor_check_failure_is_recorded_and_repo_still_included(
        tmp_path, fixture_root):
    _make_repo_dir(fixture_root, "good")
    repo = FakeRepo("user", "good", "https://github.com/user/good", owner_type="User")
    scanner = make_scanner(tmp_path, [repo])

    def boom(url):
        raise RuntimeError("contributor API unavailable")

    scanner._check_original_content = boom

    apps = scanner.find_matching_apps()

    # Inclusion behaviour is unchanged (optimistic default), the failure is visible.
    assert [a.name for a in apps] == ["good"]
    assert apps[0].is_original_content is True
    failures = read_failures(scanner)
    assert len(failures) == 1
    assert failures[0]["stage"] == "contributor"
    assert failures[0]["error_type"] == "RuntimeError"


def test_process_pool_isolates_failures(tmp_path, fixture_root, monkeypatch):
    _make_repo_dir(fixture_root, "poolgood1")
    _make_repo_dir(fixture_root, "poolbroken")
    _make_repo_dir(fixture_root, "poolgood2")
    with open(os.path.join(fixture_root, "poolbroken", "FAIL_CLONE"), "w") as f:
        f.write("")
    repos = [
        FakeRepo("org", "poolgood1", "https://github.com/org/poolgood1"),
        FakeRepo("org", "poolbroken", "https://github.com/org/poolbroken"),
        FakeRepo("org", "poolgood2", "https://github.com/org/poolgood2"),
    ]
    scanner = make_scanner(tmp_path, repos, process_count=2)

    # Confirm the multiprocessing path is actually exercised.
    from scanners import github_meta_scanner as meta
    real_pool = meta.mp.Pool
    pools = []

    def spy_pool(*args, **kwargs):
        pools.append(True)
        return real_pool(*args, **kwargs)

    monkeypatch.setattr(meta.mp, "Pool", spy_pool)

    apps = scanner.find_matching_apps()

    assert pools, "expected the process pool to be used"
    assert sorted(a.name for a in apps) == ["poolgood1", "poolgood2"]
    failures = read_failures(scanner)
    assert [f["name"] for f in failures] == ["poolbroken"]
    assert failures[0]["stage"] == STAGE_CLONE


def test_pool_falls_back_to_sequential_for_unpicklable_helper(
        tmp_path, fixture_root, capsys):
    """An injected helper that cannot cross the process boundary must not abort."""
    _make_repo_dir(fixture_root, "seqgood")
    _make_repo_dir(fixture_root, "seqbroken")
    with open(os.path.join(fixture_root, "seqbroken", "FAIL_CLONE"), "w") as f:
        f.write("")

    def local_clone(url, path):
        # A closure is not picklable, so the pool path cannot be used.
        fake_clone(url, path)

    repos = [
        FakeRepo("org", "seqgood", "https://github.com/org/seqgood"),
        FakeRepo("org", "seqbroken", "https://github.com/org/seqbroken"),
    ]
    scanner = make_scanner(tmp_path, repos, process_count=2, clone_fn=local_clone)

    apps = scanner.find_matching_apps()

    assert [a.name for a in apps] == ["seqgood"]
    failures = read_failures(scanner)
    assert [f["name"] for f in failures] == ["seqbroken"]
    assert failures[0]["stage"] == STAGE_CLONE


def test_shizuku_modules_scanner_still_skips_existing_clone(tmp_path, fixture_root):
    _make_repo_dir(fixture_root, "shared")
    repo = FakeRepo("org", "shared", "https://github.com/org/shared")
    counter = CountingClone()
    scanner = ShizukuModulesScanner(
        "test-token",
        exclude=[],
        process_count=1,
        failure_log=FailureLog(str(tmp_path / "cache" / FAILURES_FILENAME)),
        clone_fn=counter,
        clones_dir=str(tmp_path / "cache" / "repos"),
    )
    scanner.auth = FakeGitHub([repo])
    scanner._fetch_entries = lambda: [
        {"html_url": repo.html_url, "full_name": "org/shared",
         "description": "d", "release": None, "pushed_at": None,
         "stargazers_count": 1},
    ]
    # GithubMetaScanner's clone already exists from earlier in the run.
    os.makedirs(os.path.join(scanner.clones_dir, scanner._repo_id(repo.html_url)))

    apps = scanner.find_matching_apps()

    assert apps == []
    assert counter.calls == []
    assert read_failures(scanner) == []


def test_shizuku_modules_scanner_records_its_own_clone_failure(tmp_path, fixture_root):
    _make_repo_dir(fixture_root, "broken")
    with open(os.path.join(fixture_root, "broken", "FAIL_CLONE"), "w") as f:
        f.write("")
    repo = FakeRepo("org", "broken", "https://github.com/org/broken")
    scanner = ShizukuModulesScanner(
        "test-token",
        exclude=[],
        process_count=1,
        clone_fn=fake_clone,
        clones_dir=str(tmp_path / "cache" / "repos"),
    )
    scanner.auth = FakeGitHub([repo])

    # The modules scanner reads a remote JSON index; feed it offline entries.
    scanner._fetch_entries = lambda: [
        {"html_url": repo.html_url, "full_name": "org/broken",
         "description": "d", "release": None, "pushed_at": None,
         "stargazers_count": 1},
    ]

    assert scanner.find_matching_apps() == []
    failures = read_failures(scanner)
    assert len(failures) == 1
    assert failures[0]["scanner"] == "ShizukuModulesScanner"
    assert failures[0]["stage"] == STAGE_CLONE


def test_round_level_failure_log_aggregates_both_scanners(tmp_path, fixture_root):
    """The same FailureLog instance collects failures across scanners."""
    log = FailureLog(str(tmp_path / "cache" / FAILURES_FILENAME), autosave=False)
    _make_repo_dir(fixture_root, "good")
    _make_repo_dir(fixture_root, "broken")
    with open(os.path.join(fixture_root, "broken", "FAIL_CLONE"), "w") as f:
        f.write("")
    good = FakeRepo("org", "good", "https://github.com/org/good")
    broken = FakeRepo("org", "broken", "https://github.com/org/broken")

    meta = make_scanner(tmp_path, [good, broken], log=log)
    meta.find_matching_apps()
    modules = ShizukuModulesScanner(
        "test-token", exclude=[], process_count=1, failure_log=log,
        clone_fn=fake_clone, clones_dir=str(tmp_path / "cache" / "repos"),
    )
    modules._fetch_entries = lambda: [
        {"html_url": broken.html_url, "full_name": "org/broken",
         "description": "d", "release": None, "pushed_at": None,
         "stargazers_count": 1},
    ]
    modules.find_matching_apps()

    # Nothing is persisted until the round finishes.
    assert not os.path.exists(log.path)
    log.finish()

    with open(log.path, encoding="utf-8") as f:
        failures = json.load(f)
    # The repository is reported once even though both scanners tried it.
    assert len(failures) == 1
    assert failures[0]["scanner"] == "GithubMetaScanner"
    assert failures[0]["stage"] == STAGE_CLONE
    assert failures[0]["url"] == broken.html_url
    assert not os.path.exists(os.path.join(meta.clones_dir, FAILURES_FILENAME))


def test_scan_apps_finishes_its_own_log_when_none_is_given(
        tmp_path, fixture_root, monkeypatch):
    """Standalone scan_apps() persists the report once, not per scanner."""
    import main as main_module
    from scanners import github_meta_scanner as meta

    failures_path = tmp_path / "standalone_failures.json"

    class StubScanner:
        def __init__(self, *args, failure_log=None, **kwargs):
            self.log = failure_log

        def find_matching_apps(self):
            self.log.add([{
                "name": "x", "url": "https://github.com/o/x", "stage": STAGE_CLONE,
                "error_type": "RuntimeError", "reason": "r", "scanner": "Stub",
            }])
            return []

    class EmptyScanner:
        def __init__(self, *args, **kwargs):
            pass

        def find_matching_apps(self):
            return []

    monkeypatch.setattr(main_module, "FDroidScanner", EmptyScanner)
    monkeypatch.setattr(main_module, "GithubCodeScanner", EmptyScanner)
    monkeypatch.setattr(main_module, "GithubMetaScanner", StubScanner)
    monkeypatch.setattr(main_module, "ShizukuModulesScanner", StubScanner)
    monkeypatch.setattr(main_module, "default_failures_path", lambda: str(failures_path))

    assert main_module.scan_apps("token") == []
    assert json.loads(failures_path.read_text(encoding="utf-8"))[0]["name"] == "x"


def test_main_keeps_failures_out_of_summary(tmp_path, fixture_root, monkeypatch, capsys):
    import main as main_module

    _make_repo_dir(fixture_root, "good")
    good = FakeRepo("org", "good", "https://github.com/org/good")
    broken = FakeRepo("org", "failed-repo", "https://github.com/org/failed-repo")

    def fake_scan(github_auth, failure_log):
        log = failure_log
        log.add([{
            "name": broken.name, "url": broken.html_url, "stage": STAGE_CLONE,
            "error_type": "RuntimeError", "reason": "simulated", "scanner": "GithubMetaScanner",
        }])
        return [app_for(good)]

    monkeypatch.setattr(main_module, "scan_apps", fake_scan)
    failures_path = tmp_path / "cache" / FAILURES_FILENAME
    monkeypatch.setattr(main_module, "default_failures_path", lambda: str(failures_path))
    monkeypatch.chdir(tmp_path)
    (tmp_path / "list").mkdir()
    monkeypatch.setattr("sys.argv", ["main.py", str(tmp_path / "list")])
    monkeypatch.setenv("GITHUB_AUTH", "test-token")

    main_module.main()

    summary = (tmp_path / "SUMMARY.md").read_text(encoding="utf-8")
    assert "good" in summary
    assert "failed-repo" not in summary

    assert failures_path.is_file()
    failures = json.loads(failures_path.read_text(encoding="utf-8"))
    assert failures[0]["name"] == "failed-repo"
    out = capsys.readouterr().out
    assert "failed-repo" in out
