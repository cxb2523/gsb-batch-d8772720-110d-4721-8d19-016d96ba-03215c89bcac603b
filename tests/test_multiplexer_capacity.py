"""Regressions for the capacity ratchet found by the 2.0.1 audit.

Eighteen agents each opened a browser, worked, and called close_browser exactly
as instructed. The twelfth onwards were refused a browser for the rest of the
session: close_browser deliberately keeps the name (its profile and flags have to
survive), but nothing ever gave the name back, and the cleanup call itself ran
through the get-or-create path — so closing a name that was never opened answered
with the *creation* cap error.

Like test_multiplexer_races, these use a stub worker: every one is about the
registry's bookkeeping, not about a real Chrome.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from nodriver_mcp import multiplexer as mux


class _StubWorker:
    """A worker whose Chrome state and idleness the test controls directly."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.session = object()
        self.error = None
        self.task = None
        self.started_at = 0.0
        self.last_used = 0.0  # ancient by default: idle long enough to reap
        self.calls = 0
        self.last_tool = None
        self.retired = False
        self.shutdown_called = False
        self.started = False
        self.chrome_running = True

    @property
    def alive(self) -> bool:
        return not self.retired and self.started and self.error is None

    async def start(self) -> None:
        self.started = True

    async def shutdown(self) -> None:
        self.retired = True
        self.shutdown_called = True


@pytest.fixture(autouse=True)
def clean_registry(monkeypatch):
    monkeypatch.setattr(mux, "_workers", {})
    monkeypatch.setattr(mux, "_name_locks", {})
    monkeypatch.setattr(mux, "_Worker", _StubWorker)
    monkeypatch.setattr(mux, "_responsive", _true_if_alive)

    async def _status(name: str):
        if name == mux.DEFAULT_BROWSER:
            return {"browser": name, "runs_in": "the server process"}
        worker = mux._workers.get(name)
        if worker is None:
            return None
        return {
            "browser": name,
            "worker": "running",
            "chrome_running": worker.chrome_running,
        }

    monkeypatch.setattr(mux, "_status", _status)
    yield
    mux._workers.clear()


async def _true_if_alive(worker):
    return worker.alive


def test_closing_a_browser_that_was_never_opened_is_a_no_op():
    """Regression: it answered with the 12-browser *creation* error.

    A teardown call must work when the server is at capacity — that is precisely
    when an agent needs it — and must never spawn a subprocess to discover there
    is nothing to close. A single typo in `browser` used to burn a slot for the
    life of the server.
    """

    async def scenario():
        result = await mux.call_tool("close_browser", {"browser": "never-opened"})
        text = mux._text(result)

        assert "Refusing to open" not in text, text
        assert "nothing to close" in text
        assert not result.isError, "cleanup reported as an error"
        assert "never-opened" not in mux._workers, "teardown created a browser"

    asyncio.run(scenario())


def test_a_browser_with_no_chrome_is_reclaimed_at_the_cap():
    """Regression: the cap counted registered names and nothing ever released one.

    close_browser leaves a live registration with a dead Chrome behind. Once
    twelve of those existed the server refused every new name forever, even
    though no Chrome was running at all.
    """

    async def scenario():
        for i in range(mux._MAX_BROWSERS - 1):
            worker = await mux._ensure_worker(f"b{i}")
            worker.chrome_running = False  # what close_browser leaves behind

        assert mux._live_count() >= mux._MAX_BROWSERS

        fresh = await mux._ensure_worker("late-arrival")
        assert fresh.name == "late-arrival"
        assert mux._live_count() <= mux._MAX_BROWSERS

    asyncio.run(scenario())


def test_a_browser_still_running_chrome_is_never_reclaimed():
    """The reaper must not collect a browser another agent is using.

    Reclaiming is destructive, so "still has a Chrome" outranks "has not been
    called in a while" — an agent parked on a loaded page is idle by every
    measure this layer can see.
    """

    async def scenario():
        for i in range(mux._MAX_BROWSERS - 1):
            await mux._ensure_worker(f"busy{i}")  # chrome_running stays True

        collected = await mux._reap_idle("test")
        assert collected == [], f"reaped a browser that still had Chrome: {collected}"

        with pytest.raises(RuntimeError) as excinfo:
            await mux._ensure_worker("one-too-many")
        assert "none could be reclaimed" in str(excinfo.value)
        # The error has to name the call that actually frees a slot.
        assert "shutdown_browser" in str(excinfo.value)

    asyncio.run(scenario())


def test_a_worker_whose_age_is_unknown_is_left_alone():
    """Reaping is destructive, so an unknown idle time must mean "do not touch"."""

    async def scenario():
        worker = await mux._ensure_worker("ageless")
        worker.chrome_running = False
        del worker.last_used

        assert await mux._reap_idle("test") == []
        assert "ageless" in mux._workers

    asyncio.run(scenario())


def test_setting_the_ttl_to_zero_disables_every_sweep():
    """TTL 0 means sweeping is off, including the on-demand sweep at the cap.

    The periodic _reaper exits on its own check, but _reap_idle is also called
    from _ensure_worker when the registry is full. Without the guard living in
    _reap_idle itself, an operator who asked to keep idle names forever still
    had them destroyed the moment a thirteenth browser arrived.
    """

    async def scenario():
        for i in range(mux._MAX_BROWSERS - 1):
            worker = await mux._ensure_worker(f"b{i}")
            worker.chrome_running = False

        original_ttl = mux._IDLE_TTL_S
        mux._IDLE_TTL_S = 0
        try:
            # The direct sweep collects nothing...
            assert await mux._reap_idle("test") == []
            assert len(mux._workers) == mux._MAX_BROWSERS - 1
            # ...and the capacity path refuses rather than reclaiming.
            with pytest.raises(RuntimeError, match="none could be reclaimed"):
                await mux._ensure_worker("late-arrival")
            assert len(mux._workers) == mux._MAX_BROWSERS - 1
        finally:
            mux._IDLE_TTL_S = original_ttl

    asyncio.run(scenario())


def test_the_periodic_reaper_runs_its_sweep_and_can_be_switched_off():
    """The background task is what makes collection automatic, not on-demand."""

    async def scenario():
        sweeps: list[str] = []

        async def record(reason: str):
            sweeps.append(reason)
            return []

        original_reap, original_interval, original_ttl = (
            mux._reap_idle,
            mux._REAP_INTERVAL_S,
            mux._IDLE_TTL_S,
        )
        mux._reap_idle = record
        mux._REAP_INTERVAL_S = 0.01
        try:
            task = asyncio.create_task(mux._reaper())
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert sweeps, "the background reaper never swept"
            assert all(s == "idle sweep" for s in sweeps)

            # With the TTL at 0 the task returns immediately instead of looping.
            mux._IDLE_TTL_S = 0
            disabled = asyncio.create_task(mux._reaper())
            await asyncio.wait_for(disabled, timeout=1.0)
            assert disabled.done()
        finally:
            mux._reap_idle = original_reap
            mux._REAP_INTERVAL_S = original_interval
            mux._IDLE_TTL_S = original_ttl

    asyncio.run(scenario())


def test_a_stopped_or_unresponsive_worker_is_reclaimable_even_with_chrome():
    """A worker that cannot answer cannot serve anyone, so its slot is dead weight.

    The status call reports this independently of chrome_running, which the
    worker may never have had a chance to set honestly before it hung.
    """

    async def scenario():
        worker = await mux._ensure_worker("zombie")
        worker.last_used = 0.0  # ancient
        for worker_state in ("stopped", "unresponsive"):
            assert mux._reclaimable(
                worker, {"chrome_running": True, "worker": worker_state}
            ), worker_state
        # A responsive worker with a live Chrome is never collectible, however idle.
        assert not mux._reclaimable(
            worker, {"chrome_running": True, "worker": "running"}
        )
        # An alive worker whose status could not be obtained is given the benefit
        # of the doubt; only a corpse (alive=False) is collectible with no status.
        assert not mux._reclaimable(worker, None)

    asyncio.run(scenario())


def test_a_locked_name_is_skipped_without_waiting_for_its_lock():
    """The sweep must never block on a name another call holds.

    _reap_idle runs from _ensure_worker while that call already holds its own
    name's lock; waiting here would let two spawns deadlock the whole server.
    """

    async def scenario():
        worker = await mux._ensure_worker("busy-lock")
        worker.chrome_running = False
        worker.last_used = 0.0
        lock = await mux._name_lock("busy-lock")
        async with lock:
            collected = await asyncio.wait_for(
                mux._reap_idle("test"), timeout=5
            )
        assert collected == []
        assert "busy-lock" in mux._workers

    asyncio.run(scenario())


def test_a_name_that_is_still_starting_is_never_reaped():
    """A slot claimed before the slow spawn must not look like a dead browser.

    The startup holds the name's lock for its whole duration, so the sweep
    skips the name rather than collecting a Chrome that is still coming up.
    """

    async def scenario():
        real_worker_cls = mux._Worker

        class SlowStart(real_worker_cls):
            async def start(self):
                await asyncio.sleep(0.15)
                await super().start()

        mux._Worker = SlowStart
        try:
            spawn = asyncio.create_task(mux._ensure_worker("booting"))
            await asyncio.sleep(0.05)  # mid-spawn: slot claimed, lock held
            assert await mux._reap_idle("test") == []
            assert "booting" in mux._workers
            await asyncio.wait_for(spawn, timeout=5)
            assert "booting" in mux._workers
        finally:
            mux._Worker = real_worker_cls

    asyncio.run(scenario())


def test_reclaim_is_rechecked_under_the_lock():
    """State seen during the status scan may have changed by the time we lock.

    A call that arrived in between can relaunch Chrome; collecting anyway would
    tear a live browser out from under that caller.
    """

    async def scenario():
        worker = await mux._ensure_worker("revived")
        worker.chrome_running = False
        worker.last_used = 0.0
        original = mux._reclaimable
        decisions = iter([True, False])  # passes the scan, fails under the lock
        mux._reclaimable = lambda w, status: next(decisions)
        try:
            assert await mux._reap_idle("test") == []
            assert "revived" in mux._workers
        finally:
            mux._reclaimable = original

    asyncio.run(scenario())


def test_list_browsers_names_the_reclaimable_names_at_capacity():
    """The caller refused a slot must be told exactly which names free themselves.

    It has to say both that collection is automatic and that shutdown_browser
    releases one immediately, while keeping every field the report already had.
    """

    async def scenario():
        for i in range(mux._MAX_BROWSERS - 1):
            worker = await mux._ensure_worker(f"b{i}")
            worker.chrome_running = False

        result = await mux.call_tool("list_browsers", {})
        report = json.loads(mux._text(result))

        assert report["open"] == report["max"]
        assert report["slots_free"] == 0
        assert "At capacity" in report["hint"]
        assert "collected automatically" in report["hint"]
        assert "shutdown_browser" in report["hint"]
        # Every reclaimable name is spelled out.
        for i in range(mux._MAX_BROWSERS - 1):
            assert f"b{i}" in report["hint"]
        # The existing shape is untouched.
        assert {"browsers", "open", "max", "slots_free", "hint"} <= set(report)
        assert all("browser" in entry for entry in report["browsers"])

    asyncio.run(scenario())


def test_list_browsers_with_no_reclaimable_name_says_to_release_your_own():
    """At capacity with every Chrome still up, there is nothing to promise away."""

    async def scenario():
        for i in range(mux._MAX_BROWSERS - 1):
            await mux._ensure_worker(f"busy{i}")  # chrome_running stays True

        report = json.loads(
            mux._text(await mux.call_tool("list_browsers", {}))
        )
        assert report["open"] == report["max"]
        assert "collected automatically" not in report["hint"]
        assert "shutdown_browser" in report["hint"]

    asyncio.run(scenario())


def test_list_browsers_does_not_promise_room_it_does_not_have():
    """Regression: the hint said "pass a new name" while open == max.

    An agent reading that at capacity retries forever against a server that has
    already refused it.
    """

    async def scenario():
        for i in range(mux._MAX_BROWSERS - 1):
            worker = await mux._ensure_worker(f"b{i}")
            worker.chrome_running = False

        result = await mux.call_tool("list_browsers", {})
        import json

        report = json.loads(mux._text(result))

        assert report["open"] == report["max"]
        assert report["slots_free"] == 0
        assert "Nothing needs to be created first" not in report["hint"]
        assert "At capacity" in report["hint"]

    asyncio.run(scenario())


def test_two_spawns_racing_at_the_cap_do_not_deadlock():
    """The reclaim sweep runs from inside _ensure_worker, which already holds the
    lock for its own name. If the sweep then WAITED for another name's lock, two
    concurrent spawns each trying to reclaim the other's slot would hold one lock
    and block on the other forever — the whole server, not just the two calls.
    """

    async def scenario():
        for i in range(mux._MAX_BROWSERS - 1):
            worker = await mux._ensure_worker(f"b{i}")
            worker.chrome_running = False

        # Both arrive at the cap together and both try to make room.
        results = await asyncio.wait_for(
            asyncio.gather(
                mux._ensure_worker("racer-one"),
                mux._ensure_worker("racer-two"),
                return_exceptions=True,
            ),
            timeout=10,
        )
        # Whether both get in or one is refused depends on how much was
        # reclaimable; deadlocking is the only unacceptable outcome.
        assert all(
            not isinstance(r, BaseException) or isinstance(r, RuntimeError)
            for r in results
        ), results

    asyncio.run(scenario())


def test_an_unknown_argument_is_refused_rather_than_dropped():
    """Regression: pydantic ignores unknown fields, so a misspelled argument
    vanished and the tool ran with its defaults.

    block_resources(resource_types=[...]) — the plausible spelling, and the one an
    agent reaches for — answered "Resource blocking disabled (all resources
    allowed)": a success message for a call that asked for the opposite. This is
    the same class of defect as a tool reporting success while doing nothing, one
    layer up.
    """

    async def scenario():
        result = await mux.call_tool("block_resources", {"resource_types": ["image"]})
        text = mux._text(result)

        assert result.isError, f"a malformed call was reported as success:\n{text}"
        assert "resource_types" in text, text
        # It has to name the argument that does exist, or the agent guesses again.
        assert "types" in text, text
        assert "Resource blocking disabled" not in text

    asyncio.run(scenario())


def test_a_correct_call_is_untouched():
    """The check must not become a new way for valid calls to fail."""

    async def scenario():
        for args in ({}, {"browser": "default"}):
            result = await mux.call_tool("list_browsers", dict(args))
            assert not result.isError, mux._text(result)

    asyncio.run(scenario())


def test_a_failing_tool_is_marked_as_an_error():
    """Regression: a tool that failed returned its message as an ordinary result.

    MCP has `isError` for exactly this, and without it a failure was
    indistinguishable from page data — a client could not tell "the element is
    covered, nothing was clicked" from the text of a page that happens to say so.
    The message still reaches the model in full; the flag is what was missing.
    """

    async def scenario():
        # A preset that does not exist: an honest "I could not", not a bad
        # argument. It is refused before a browser is ever needed, which is what
        # lets this run on a CI box with no Chrome — the browser-level version of
        # this assertion lives in test_browser_behaviour.
        result = await mux.call_tool("emulate_device", {"device": "nokia_3310"})
        text = mux._text(result)

        assert result.isError, f"a failed call was reported as success:\n{text}"
        # And the reason still has to be readable, not swallowed by the flag.
        assert "nokia_3310" in text, text
        assert "pixel_7" in text, "the failure must name the presets that do exist"

    asyncio.run(scenario())


def test_a_succeeding_tool_is_not_marked_as_an_error():
    """The flag has to mean something: setting it on ordinary results would make
    it noise, and page text containing the word "Error" must never trip it."""

    async def scenario():
        result = await mux.call_tool("list_browsers", {})
        assert not result.isError, mux._text(result)

    asyncio.run(scenario())
