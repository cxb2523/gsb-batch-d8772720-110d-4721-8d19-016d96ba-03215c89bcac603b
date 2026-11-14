from types import SimpleNamespace

import pytest

import util


class FakeReleaseList:
    def get_page(self, index):
        return []


class FakeRepo:
    """Minimal stand-in for a PyGithub Repository object."""

    def __init__(self, owner, name, url, description="A test repository",
                 owner_type="Organization"):
        self.owner = SimpleNamespace(type=owner_type, login=owner)
        self.name = name
        self.full_name = f"{owner}/{name}"
        self.html_url = url
        self.description = description
        self.pushed_at = None
        self.stargazers_count = 7

    def get_releases(self):
        return FakeReleaseList()


class FakeSearchResults:
    def __init__(self, repos):
        self._repos = list(repos)
        self.totalCount = len(self._repos)

    def __iter__(self):
        return iter(self._repos)


class FakeGitHub:
    """Offline replacement for both the search API and the contributor check.

    Repositories report their owner as an organization, so the contributor
    check short-circuits without any network access unless a test overrides it.
    """

    def __init__(self, repos=()):
        self.repos = list(repos)

    def search_repositories(self, *args, **kwargs):
        return FakeSearchResults(self.repos)

    def get_repo(self, full_name, lazy=False):
        for repo in self.repos:
            if repo.full_name == full_name:
                return repo
        return FakeRepo("org", full_name.split("/")[-1], "https://github.com/" + full_name)


@pytest.fixture(autouse=True)
def _reset_readme_paths():
    # util.filter_known_apps reads this module-level list; keep tests hermetic.
    original = util.readme_paths
    util.readme_paths = []
    try:
        yield
    finally:
        util.readme_paths = original
