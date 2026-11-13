from __future__ import annotations

import asyncio
import time

import pytest

from camouflare.pool import (
    BrowserPool,
    LeaseOutcome,
    PersistentCapacityError,
    PoolAcquireTimeout,
    RequestDeadlineExceeded,
)
from tests.fakes import FakeBrowser, FakeBrowserFactory


def _pool(**overrides: object) -> BrowserPool:
    kwargs: dict[str, object] = {
        "browser_factory": FakeBrowserFactory(),
        "min_browsers": 1,
        "max_browsers": 1,
        "max_contexts_per_browser": 1,
        "acquire_timeout_seconds": 1,
    }
    kwargs.update(overrides)
    return BrowserPool(**kwargs)  # type: ignore[arg-type]


@pytest.mark.anyio
async def test_successful_lease_records_acquired_outcome_with_fields() -> None:
    pool = _pool()
    await pool.start()

    async with pool.lease_context():
        pass

    outcomes = await pool.lease_outcomes()
    assert len(outcomes) == 1
    record = outcomes[0]
    assert isinstance(record, LeaseOutcome)
    assert record.lease_id == 1
    assert record.outcome == "acquired"
    assert record.from_session is False
    assert record.failure_reason is None
    assert record.browser_id == 1
    assert record.wait_ms >= 0
    assert isinstance(record.lease_started_at, float)
    # Wall-clock timestamp is a plausible epoch second, not a monotonic clock.
    assert record.lease_started_at > 1_700_000_000

    await pool.close()


@pytest.mark.anyio
async def test_snapshot_is_read_only_and_does_not_mutate_pool_state() -> None:
    pool = _pool()
    await pool.start()

    async with pool.lease_context():
        pass

    before = pool.snapshot()
    first = await pool.lease_outcomes()
    second = await pool.lease_outcomes()
    after = pool.snapshot()

    assert first == second
    assert before == after
    assert after.active_contexts == 0

    await pool.close()


@pytest.mark.anyio
async def test_persistent_capacity_rejection_records_pool_unavailable_with_zero_wait() -> None:
    # One browser, two contexts, one reserved for transient work -> only one
    # persistent context may exist.
    pool = _pool(max_contexts_per_browser=2, reserved_transient_contexts=1)
    await pool.start()

    first = await pool.create_persistent_context()

    with pytest.raises(PersistentCapacityError):
        await pool.create_persistent_context()

    outcomes = await pool.lease_outcomes()
    assert len(outcomes) == 2
    acquired, rejected = outcomes
    assert acquired.outcome == "acquired"
    assert acquired.from_session is True
    assert rejected.outcome == "pool_unavailable"
    assert rejected.from_session is True
    assert rejected.wait_ms == 0
    assert rejected.browser_id is None
    assert rejected.lease_started_at is None
    assert rejected.failure_reason is not None and "persistent-context" in rejected.failure_reason
    # Records stay ordered by lease id, oldest first.
    assert [record.lease_id for record in outcomes] == [1, 2]

    await first.close()
    await pool.close()


@pytest.mark.anyio
async def test_acquire_timeout_records_pool_unavailable() -> None:
    pool = _pool(acquire_timeout_seconds=0.1)
    await pool.start()

    async with pool.lease_context():
        with pytest.raises(PoolAcquireTimeout):
            async with pool.lease_context():
                pass

    outcomes = await pool.lease_outcomes()
    assert [record.outcome for record in outcomes] == ["acquired", "pool_unavailable"]
    timeout_record = outcomes[1]
    assert timeout_record.from_session is False
    assert timeout_record.wait_ms >= 90
    assert timeout_record.browser_id is None
    assert timeout_record.lease_started_at is None
    assert timeout_record.failure_reason is not None

    await pool.close()


@pytest.mark.anyio
async def test_request_deadline_records_request_timeout_before_pool_timeout() -> None:
    # Pool would happily wait a full second; the caller's deadline fires first.
    # The deadline stays well above the platform timer granularity so the pool's
    # own wait deterministically observes it rather than racing the scheduler.
    pool = _pool(acquire_timeout_seconds=1)
    await pool.start()

    async with pool.lease_context():
        deadline = time.monotonic() + 0.1
        with pytest.raises(RequestDeadlineExceeded):
            async with pool.lease_context(request_deadline=deadline):
                pass

    outcomes = await pool.lease_outcomes()
    assert [record.outcome for record in outcomes] == ["acquired", "request_timeout"]
    deadline_record = outcomes[1]
    assert deadline_record.wait_ms >= 90
    assert deadline_record.browser_id is None
    assert deadline_record.failure_reason is not None
    assert "maxTimeout" in deadline_record.failure_reason

    await pool.close()


@pytest.mark.anyio
async def test_cancelled_wait_records_cancelled_and_frees_the_slot() -> None:
    pool = _pool(acquire_timeout_seconds=5)
    await pool.start()

    async with pool.lease_context():
        async def wait_for_lease() -> None:
            async with pool.lease_context():
                pass

        waiting = asyncio.create_task(wait_for_lease())
        # Let the task enter the pool condition wait.
        await asyncio.sleep(0.02)
        assert waiting.done() is False

        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting

    outcomes = await pool.lease_outcomes()
    assert [record.outcome for record in outcomes] == ["acquired", "cancelled"]
    cancelled = outcomes[1]
    assert cancelled.from_session is False
    assert cancelled.browser_id is None
    assert cancelled.failure_reason is not None and "cancel" in cancelled.failure_reason.lower()

    # The cancelled wait must not have leaked a waiter or pinned capacity: the
    # very next acquisition succeeds once the holder releases its context.
    async with pool.lease_context() as lease:
        assert lease.context is not None

    outcomes = await pool.lease_outcomes()
    assert outcomes[-1].outcome == "acquired"
    assert pool.snapshot().active_contexts == 0

    await pool.close()


@pytest.mark.anyio
async def test_history_is_bounded_to_the_most_recent_records() -> None:
    pool = _pool(lease_outcome_history=3)
    await pool.start()

    for _ in range(5):
        async with pool.lease_context():
            pass

    outcomes = await pool.lease_outcomes()
    assert len(outcomes) == 3
    # Only the newest three lease ids survive, still oldest-to-newest.
    assert [record.lease_id for record in outcomes] == [3, 4, 5]
    assert all(record.outcome == "acquired" for record in outcomes)

    await pool.close()


@pytest.mark.anyio
async def test_default_history_limit_is_64() -> None:
    pool = _pool(lease_outcome_history=64)
    await pool.start()

    for _ in range(70):
        async with pool.lease_context():
            pass

    outcomes = await pool.lease_outcomes()
    assert len(outcomes) == 64
    assert outcomes[0].lease_id == 7
    assert outcomes[-1].lease_id == 70

    await pool.close()


@pytest.mark.anyio
async def test_session_and_transient_records_are_distinguished() -> None:
    pool = _pool(max_contexts_per_browser=2)
    await pool.start()

    persistent = await pool.create_persistent_context()
    async with pool.lease_context():
        pass

    outcomes = await pool.lease_outcomes()
    assert [record.from_session for record in outcomes] == [True, False]

    await persistent.close()
    await pool.close()


@pytest.mark.anyio
async def test_cancelled_persistent_wait_records_cancelled_and_stays_rentable() -> None:
    pool = _pool(acquire_timeout_seconds=5)
    await pool.start()

    # Hold the only slot so the session request must wait for capacity.
    async with pool.lease_context():
        waiting = asyncio.create_task(pool.create_persistent_context())
        await asyncio.sleep(0.02)
        assert waiting.done() is False

        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting

    outcomes = await pool.lease_outcomes()
    assert [record.outcome for record in outcomes] == ["acquired", "cancelled"]
    cancelled = outcomes[1]
    assert cancelled.from_session is True
    assert cancelled.browser_id is None

    # Neither the persistent reservation nor a waiter may survive cancellation.
    snapshot = pool.snapshot()
    assert snapshot.persistent_contexts == 0
    assert snapshot.waiting_requests == 0
    assert snapshot.active_contexts == 0

    # The slot is rentable again for both kinds of traffic.
    async with pool.lease_context() as lease:
        assert lease.context is not None
    persistent = await pool.create_persistent_context()
    await persistent.close()

    assert [record.outcome for record in (await pool.lease_outcomes())[-2:]] == [
        "acquired",
        "acquired",
    ]
    await pool.close()


@pytest.mark.anyio
async def test_eviction_keeps_newest_records_across_mixed_outcomes() -> None:
    pool = _pool(acquire_timeout_seconds=0.1, lease_outcome_history=2)
    await pool.start()

    async with pool.lease_context():
        with pytest.raises(PoolAcquireTimeout):
            async with pool.lease_context():
                pass
    # Holder released; a fresh lease appends a third record and evicts the first.
    async with pool.lease_context():
        pass

    outcomes = await pool.lease_outcomes()
    assert len(outcomes) == 2
    # The first acquired record was evicted; timeout + latest acquired remain,
    # still in lease-id order.
    assert [record.outcome for record in outcomes] == [
        "pool_unavailable",
        "acquired",
    ]
    assert outcomes[0].lease_id < outcomes[1].lease_id

    await pool.close()


@pytest.mark.anyio
async def test_browser_launch_failure_records_pool_unavailable_and_keeps_error() -> None:
    class FailingFactory(FakeBrowserFactory):
        async def __call__(self) -> FakeBrowser:  # type: ignore[override]
            raise RuntimeError("launch exploded")

    # No warm browsers: the first acquisition triggers a launch that fails.
    pool = BrowserPool(
        browser_factory=FailingFactory(),
        min_browsers=0,
        max_browsers=1,
        max_contexts_per_browser=1,
        acquire_timeout_seconds=1,
    )
    await pool.start()

    # The original exception must propagate, never be swallowed.
    with pytest.raises(RuntimeError, match="launch exploded"):
        async with pool.lease_context():
            pass

    outcomes = await pool.lease_outcomes()
    assert len(outcomes) == 1
    record = outcomes[0]
    assert record.outcome == "pool_unavailable"
    assert record.from_session is False
    assert record.browser_id is None
    assert record.lease_started_at is None
    assert record.failure_reason is not None
    assert "RuntimeError" in record.failure_reason
    assert "launch exploded" in record.failure_reason

    await pool.close()
