"""Offline in full: no network, no credentials, no gateway.

The allocator is file state plus the template's own validation, so every case
here runs against ``tmp_path`` and a hand-built ``Proxy``. The concurrency case
is made deterministic by driving the re-read-under-lock directly, not by
racing real processes and hoping.
"""

from __future__ import annotations

import json

import pytest

from nodemaven import ParamError, Provider, Proxy
from nodemaven.allocator import (
    CONFLICT,
    CREATED,
    FAILED,
    REUSED,
    SessionAllocator,
)
import nodemaven.allocator as allocator_mod

CREDS = {"login": "acct", "password": "pw", "host": "gate.example.com", "port": 8080}


@pytest.fixture(autouse=True)
def no_gateway_env(monkeypatch):
    """A test that reached for real credentials would spend real traffic."""
    for name in ("LOGIN", "PASSWORD", "HOST", "PORT"):
        monkeypatch.delenv(f"NODEMAVEN_{name}", raising=False)


def template(**params):
    return Proxy(country="us", **CREDS, **params)


def read_state(path):
    return json.loads(path.read_text(encoding="utf-8"))


class TestFirstRun:
    def test_every_worker_is_created_with_a_distinct_session(self, tmp_path):
        assignments = SessionAllocator(template(), tmp_path / "s.json").assign(
            ["w1", "w2", "w3"]
        )
        assert [a.status for a in assignments] == [CREATED, CREATED, CREATED]
        sids = [a.session_id for a in assignments]
        assert len(set(sids)) == 3
        # The id went through Proxy.sessions, so it is separator-free hex and
        # the returned proxy is the template pinned to it.
        for a in assignments:
            assert "-" not in a.session_id
            assert a.proxy.params["sid"] == a.session_id
            assert a.proxy.params["country"] == "us"

    def test_the_state_file_records_workers_and_no_password(self, tmp_path):
        path = tmp_path / "s.json"
        SessionAllocator(template(), path).assign(["w1", "w2"])
        state = read_state(path)
        assert set(state["workers"]) == {"w1", "w2"}
        for entry in state["workers"].values():
            assert set(entry) == {"sid", "params"}
            assert entry["params"] == {"country": "us"}
        raw = path.read_text(encoding="utf-8")
        assert "pw" not in raw
        assert "acct" not in raw


class TestSecondRun:
    def test_recorded_workers_are_reused_and_nothing_is_drawn(
        self, tmp_path, monkeypatch
    ):
        path = tmp_path / "s.json"
        first = SessionAllocator(template(), path).assign(["w1", "w2"])

        def no_draws(*args, **kwargs):
            raise AssertionError("a session id was drawn on a reuse-only run")

        # Reuse must not touch the entropy source at all: the ids come from
        # the file, not from a fresh batch.
        monkeypatch.setattr("nodemaven.proxy.secrets.choice", no_draws)
        second = SessionAllocator(template(), path).assign(["w1", "w2"])
        assert [a.status for a in second] == [REUSED, REUSED]
        assert [a.session_id for a in second] == [a.session_id for a in first]
        assert [a.proxy.username for a in second] == [
            a.proxy.username for a in first
        ]

    def test_only_new_workers_are_given_new_sessions(self, tmp_path):
        path = tmp_path / "s.json"
        first = SessionAllocator(template(), path).assign(["w1"])
        second = SessionAllocator(template(), path).assign(["w1", "w2"])
        assert second[0].status == REUSED
        assert second[0].session_id == first[0].session_id
        assert second[1].status == CREATED
        assert second[1].session_id != first[0].session_id
        # And the file holds exactly the two of them.
        assert set(read_state(path)["workers"]) == {"w1", "w2"}


class TestFailuresArePerWorker:
    def test_a_template_without_a_session_parameter_fails_every_worker(
        self, tmp_path
    ):
        provider = Provider(
            id="nosession",
            label="NoSession",
            known_params=frozenset({"country"}),
            host="gate.example.com",
            port=8080,
        )
        proxy = Proxy(login="acct", password="pw", provider=provider, country="us")
        assignments = SessionAllocator(proxy, tmp_path / "s.json").assign(
            ["w1", "w2"]
        )
        assert [a.status for a in assignments] == [FAILED, FAILED]
        assert all("no session parameter" in a.reason for a in assignments)
        assert all(a.proxy is None for a in assignments)

    def test_a_recorded_id_the_gateway_would_cut_fails_that_worker_only(
        self, tmp_path
    ):
        # "ab-cd" carries the separator: the gateway would read it as sid=ab
        # plus a parameter named cd. The refusal comes from Proxy.session,
        # the same check that refuses it anywhere else.
        path = tmp_path / "s.json"
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "template": {"provider": "nodemaven", "params": {"country": "us"}},
                    "workers": {
                        "w1": {"sid": "ab-cd", "params": {"country": "us"}}
                    },
                }
            ),
            encoding="utf-8",
        )
        assignments = SessionAllocator(template(), path).assign(["w1", "w2"])
        assert assignments[0].status == FAILED
        assert "separate parameters" in assignments[0].reason
        assert assignments[1].status == CREATED
        # The bad entry is reported, not silently rewritten.
        assert read_state(path)["workers"]["w1"]["sid"] == "ab-cd"

    def test_worker_names_are_checked(self, tmp_path):
        allocator = SessionAllocator(template(), tmp_path / "s.json")
        with pytest.raises(ParamError, match="non-empty strings"):
            allocator.assign(["w1", ""])
        with pytest.raises(ParamError, match="more than once"):
            allocator.assign(["w1", "w1"])


class TestCorruptStateFile:
    def test_unparseable_json_raises_naming_the_path(self, tmp_path):
        path = tmp_path / "s.json"
        path.write_text("{ not json", encoding="utf-8")
        with pytest.raises(ParamError, match="s.json"):
            SessionAllocator(template(), path).assign(["w1"])

    @pytest.mark.parametrize(
        "content",
        [
            "[1, 2]",  # not an object at all
            '{"version": 2, "workers": {}}',  # a structure from another day
            '{"version": 1, "workers": {"w1": "abc"}}',  # entry not an object
            '{"version": 1, "workers": {"w1": {"sid": "", "params": {}}}}',
            '{"version": 1, "workers": {"w1": {"sid": "abc"}}}',  # no params
        ],
    )
    def test_a_structure_this_module_did_not_write_raises(
        self, tmp_path, content
    ):
        path = tmp_path / "s.json"
        path.write_text(content, encoding="utf-8")
        with pytest.raises(ParamError, match="s.json"):
            SessionAllocator(template(), path).assign(["w1"])

    def test_a_corrupt_file_is_left_untouched(self, tmp_path):
        path = tmp_path / "s.json"
        path.write_text("{ not json", encoding="utf-8")
        with pytest.raises(ParamError):
            SessionAllocator(template(), path).assign(["w1"])
        assert path.read_text(encoding="utf-8") == "{ not json"


class TestConcurrentWriters:
    def test_a_later_writer_never_erases_an_earlier_registration(
        self, tmp_path, monkeypatch
    ):
        """Process B reads an empty file, plans its own ids, and by the time
        it takes the lock process A has committed w1 and w9 of its own.

        Driven deterministically: the second read of the state file is the
        one taken under the lock, so the foreign commit is written just
        before it. The merge, not luck, is what is being asserted.
        """
        path = tmp_path / "s.json"
        foreign = {
            "version": 1,
            "template": {"provider": "nodemaven", "params": {"country": "us"}},
            "workers": {
                "w1": {"sid": "aaaa1111bbbb", "params": {"country": "us"}},
                "w9": {"sid": "ffff9999eeee", "params": {"country": "us"}},
            },
        }
        real_read = allocator_mod._read_state
        reads = 0

        def racing_read(p):
            nonlocal reads
            reads += 1
            if reads == 2:
                # A committed while B waited for the lock.
                p.write_text(json.dumps(foreign), encoding="utf-8")
            return real_read(p)

        monkeypatch.setattr(allocator_mod, "_read_state", racing_read)

        assignments = SessionAllocator(template(), path).assign(["w1", "w2"])
        by_worker = {a.worker: a for a in assignments}

        # B's own plan for w1 loses to the registration already on disk, and
        # the result says so instead of handing B a second id for one worker.
        assert by_worker["w1"].status == CONFLICT
        assert by_worker["w1"].session_id == "aaaa1111bbbb"
        assert "another writer" in by_worker["w1"].reason
        assert by_worker["w2"].status == CREATED

        # The file keeps A's registrations - including w9, which B never
        # heard of - and adds only what B genuinely owns.
        workers = read_state(path)["workers"]
        assert workers["w1"]["sid"] == "aaaa1111bbbb"
        assert workers["w9"]["sid"] == "ffff9999eeee"
        assert workers["w2"]["sid"] == by_worker["w2"].session_id

    def test_two_sequential_writers_keep_each_others_workers(self, tmp_path):
        # The same guarantee without the race harness: a writer only ever
        # merges into the file, so workers it was not asked about survive.
        path = tmp_path / "s.json"
        SessionAllocator(template(), path).assign(["w1"])
        SessionAllocator(template(), path).assign(["w2"])
        assert set(read_state(path)["workers"]) == {"w1", "w2"}


class TestTemplateChangedUnderARecordedWorker:
    def test_a_parameter_change_is_a_conflict_not_a_silent_move(self, tmp_path):
        # The sticky key is the whole parameter set, so country=us, sid=X and
        # country=gb, sid=X are two sessions. Reusing the id under new
        # parameters would report a reuse of a session that does not exist.
        path = tmp_path / "s.json"
        SessionAllocator(Proxy(country="us", **CREDS), path).assign(["w1"])
        assignments = SessionAllocator(Proxy(country="gb", **CREDS), path).assign(
            ["w1"]
        )
        assert assignments[0].status == CONFLICT
        assert "whole parameter set" in assignments[0].reason
        # The file still holds the original registration.
        assert read_state(path)["workers"]["w1"]["params"] == {"country": "us"}
