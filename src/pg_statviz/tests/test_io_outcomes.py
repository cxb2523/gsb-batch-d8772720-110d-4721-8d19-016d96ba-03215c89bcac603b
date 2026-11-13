"""Tests for the auditable I/O collection introduced for the io module.

All fixtures are hand-built local rows; nothing here touches a database.
"""

import logging
import numpy
from datetime import datetime, timedelta
from pg_statviz.tests.util import mock_dictrow
from pg_statviz.modules.io import (IoOutcome, collect_iostats,
                                   log_io_outcomes, normalize_daterange)

START = datetime(2026, 1, 1, 0, 0, 0)
CATEGORY = {"backend_type": "client backend", "object": "relation",
            "context": "normal"}


def io_entry(reads=0, writes=0, **extra):
    entry = dict(CATEGORY)
    entry.update({"reads": reads, "writes": writes})
    entry.update(extra)
    return entry


def snapshot(io_stats, offset, stats_reset=START):
    return mock_dictrow({
        "io_stats": io_stats,
        "stats_reset": stats_reset,
        "snapshot_tstamp": START + timedelta(seconds=offset),
    })


def category(collection):
    found = collection.outcome_for(CATEGORY)
    assert found is not None
    return found


def test_normal_rates_legacy_blocks():
    data = [
        snapshot([io_entry(reads=100, writes=200)], 10),
        snapshot([io_entry(reads=300, writes=600)], 20),
    ]

    collection = collect_iostats(data, block_size=8192)
    result = category(collection)

    assert collection.snapshot_count == 2
    assert result.counter_source == "blocks"
    assert result.result is IoOutcome.OK
    # 200 blocks * 8192 bytes over 10 seconds; writes 400 * 8192 / 10
    assert result.reads == [numpy.nan, 163840.0]
    assert result.writes == [numpy.nan, 327680.0]
    assert all(interval.read is IoOutcome.OK
               and interval.write is IoOutcome.OK
               for interval in result.intervals)


def test_custom_block_size_conversion():
    data = [
        snapshot([io_entry(reads=1, writes=2)], 10),
        snapshot([io_entry(reads=3, writes=6)], 20),
    ]

    collection = collect_iostats(data, block_size=16384)
    result = category(collection)

    assert result.counter_source == "blocks"
    assert result.reads[1] == 2 * 16384 / 10
    assert result.writes[1] == 4 * 16384 / 10


def test_stats_reset_invalidates_rates():
    reset = START + timedelta(seconds=15)
    data = [
        snapshot([io_entry(reads=100000, writes=500000)], 10),
        snapshot([io_entry(reads=10, writes=20)], 20, stats_reset=reset),
    ]

    collection = collect_iostats(data)
    result = category(collection)

    assert result.result is IoOutcome.STATS_RESET
    assert numpy.isnan(result.reads[1])
    assert numpy.isnan(result.writes[1])
    assert result.intervals[0].read is IoOutcome.STATS_RESET
    assert result.intervals[0].write is IoOutcome.STATS_RESET


def test_pg18_byte_fields_are_used_without_block_scaling():
    data = [
        snapshot([io_entry(read_bytes=1000, write_bytes=2000,
                           reads=1, writes=2)], 10),
        snapshot([io_entry(read_bytes=4000, write_bytes=6000,
                           reads=1, writes=2)], 20),
    ]

    collection = collect_iostats(data, block_size=8192)
    result = category(collection)

    assert result.counter_source == "bytes"
    assert result.reads == [numpy.nan, 300.0]
    assert result.writes == [numpy.nan, 400.0]
    assert result.result is IoOutcome.OK


def test_single_snapshot_yields_missing_not_exception():
    data = [snapshot([io_entry(reads=100, writes=200)], 10)]

    collection = collect_iostats(data)
    result = category(collection)

    assert collection.snapshot_count == 1
    assert result.result is IoOutcome.MISSING
    assert result.intervals == []
    assert result.reads == [numpy.nan]
    assert result.writes == [numpy.nan]


def test_category_missing_from_adjacent_snapshot_is_missing():
    other = {"backend_type": "checkpointer", "object": "relation",
             "context": "normal"}
    data = [
        snapshot([io_entry(reads=100, writes=200)], 10),
        snapshot([dict(other, reads=1, writes=1)], 20),
        snapshot([io_entry(reads=400, writes=600)], 30),
    ]

    collection = collect_iostats(data)
    result = category(collection)

    assert result.result is IoOutcome.MISSING
    assert result.intervals[0].read is IoOutcome.MISSING
    assert result.intervals[1].read is IoOutcome.MISSING
    assert "absent" in result.intervals[0].read_detail


def test_zero_counter_is_missing():
    data = [
        snapshot([io_entry(reads=0, writes=10)], 10),
        snapshot([io_entry(reads=100, writes=20)], 20),
    ]

    collection = collect_iostats(data)
    result = category(collection)

    assert result.intervals[0].read is IoOutcome.MISSING
    assert result.intervals[0].write is IoOutcome.OK


def test_input_rows_are_not_mutated():
    data = [
        snapshot([io_entry(reads=100, writes=200)], 10),
        snapshot([io_entry(reads=300, writes=600)], 20),
    ]
    original = [(dict(row["io_stats"][0])) for row in data]

    collect_iostats(data, block_size=8192)

    assert [row["io_stats"][0] for row in data] == original


def test_non_increasing_timestamps_are_missing():
    data = [
        snapshot([io_entry(reads=100, writes=200)], 20),
        snapshot([io_entry(reads=300, writes=600)], 20),
    ]

    collection = collect_iostats(data)
    result = category(collection)

    assert result.intervals[0].read is IoOutcome.MISSING
    assert "timestamps" in result.intervals[0].read_detail


def test_log_io_outcomes_reports_each_skipped_category(caplog):
    reset = START + timedelta(seconds=15)
    other = {"backend_type": "checkpointer", "object": "relation",
             "context": "normal"}
    data = [
        snapshot([io_entry(reads=100, writes=200)], 10),
        snapshot([dict(other, reads=1, writes=1)], 20, stats_reset=reset),
        snapshot([io_entry(reads=400, writes=600),
                  dict(other, reads=5, writes=6)], 30, stats_reset=reset),
    ]
    logger = logging.getLogger("pg_statviz.modules.io.test")

    with caplog.at_level(logging.INFO, logger=logger.name):
        log_io_outcomes(collect_iostats(data), logger)

    messages = [record.getMessage() for record in caplog.records]
    # The client category is invalidated by the reset in interval 0 and
    # absent from snapshot 2 in interval 1 -- both reasons must be itemised.
    client_line = next(m for m in messages
                       if "client backend/normal" in m)
    assert "stats_reset" in client_line
    assert "absent from snapshot 2" in client_line
    # The checkpointer category was only affected by the reset.
    checkpoint_line = next(m for m in messages
                           if "checkpointer/normal" in m)
    assert "stats_reset" in checkpoint_line
    assert any("2 of 2 categories" in m for m in messages)


def test_counter_representation_change_is_missing():
    # e.g. a range spanning a PG17 -> PG18 upgrade: one snapshot has block
    # counts, the next has byte counters.
    data = [
        snapshot([io_entry(reads=100, writes=200)], 10),
        snapshot([io_entry(read_bytes=4000, write_bytes=6000,
                           reads=1, writes=2)], 20),
    ]

    collection = collect_iostats(data)
    result = category(collection)

    assert result.counter_source == "mixed"
    assert result.intervals[0].read is IoOutcome.MISSING
    assert "representation" in result.intervals[0].read_detail
    assert numpy.isnan(result.reads[1])


def test_counter_decrease_without_stats_reset_is_missing():
    data = [
        snapshot([io_entry(reads=1000, writes=2000)], 10),
        snapshot([io_entry(reads=100, writes=200)], 20),
    ]

    collection = collect_iostats(data)
    result = category(collection)

    assert result.intervals[0].read is IoOutcome.MISSING
    assert "decreased" in result.intervals[0].read_detail
    assert numpy.isnan(result.reads[1])


def test_log_io_outcomes_explains_single_snapshot(caplog):
    data = [snapshot([io_entry(reads=100, writes=200)], 10)]
    logger = logging.getLogger("pg_statviz.modules.io.single")

    with caplog.at_level(logging.INFO, logger=logger.name):
        log_io_outcomes(collect_iostats(data), logger)

    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "client backend/normal" in messages
    assert "fewer than two snapshots" in messages


def test_every_category_has_an_outcome_entry():
    other = {"backend_type": "checkpointer", "object": "relation",
             "context": "normal"}
    data = [
        snapshot([io_entry(reads=100, writes=200),
                  dict(other, reads=10, writes=20)], 10),
        snapshot([io_entry(reads=300, writes=600),
                  dict(other, reads=30, writes=60)], 20),
    ]

    collection = collect_iostats(data)
    outcomes = collection.outcomes()

    assert set(outcomes) == {"client backend/normal", "checkpointer/normal"}
    assert all(outcome is IoOutcome.OK for outcome in outcomes.values())
    assert collection.skipped() == []


def test_skipped_marks_categories_with_any_unusable_interval():
    data = [
        snapshot([io_entry(reads=100, writes=200)], 10),
        snapshot([io_entry(reads=300, writes=300)], 20),
        snapshot([io_entry(reads=500, writes=0)], 30),
    ]

    collection = collect_iostats(data)
    category = collection.outcome_for(CATEGORY)

    # Reads were fully usable every interval, but writes dropped to zero on
    # the last one, so the category outcome must not claim a clean OK.
    assert category.read_result is IoOutcome.OK
    assert category.write_result is IoOutcome.MISSING
    assert category.result is IoOutcome.MISSING
    assert collection.skipped() == [category]


def test_outcome_accessor_can_scope_to_one_direction():
    data = [
        snapshot([io_entry(reads=0, writes=10)], 10),
        snapshot([io_entry(reads=100, writes=20)], 20),
    ]

    collection = collect_iostats(data)

    assert collection.outcomes('read')["client backend/normal"] \
        is IoOutcome.MISSING
    assert collection.outcomes('write')["client backend/normal"] \
        is IoOutcome.OK


def test_categories_with_different_objects_do_not_collide():
    wal = {"backend_type": "checkpointer", "object": "wal",
           "context": "normal"}
    rel = {"backend_type": "checkpointer", "object": "relation",
           "context": "normal"}
    data = [
        snapshot([dict(rel, reads=10, writes=20),
                  dict(wal, reads=5, writes=5)], 10),
        snapshot([dict(rel, reads=30, writes=60),
                  dict(wal, reads=15, writes=25)], 20),
    ]

    collection = collect_iostats(data)
    names = [category.name for category in collection.categories]

    assert len(names) == len(set(names)) == 2
    assert "checkpointer/normal" in names
    assert "wal/checkpointer/normal" in names


def test_normalize_daterange_swaps_reversed_order():
    parsed = normalize_daterange(["2026-01-02T00:00", "2026-01-01T00:00"])
    assert parsed[0] < parsed[1]
    assert parsed[0].day == 1 and parsed[1].day == 2


def test_normalize_daterange_empty_uses_open_ended_default():
    assert normalize_daterange([]) == ['-infinity', 'now()']


class _FakeCursor:
    def __init__(self):
        self._result = []

    def execute(self, sql, params=None):
        self._sql = sql

    def fetchall(self):
        return []

    def fetchone(self):
        return {'version_ok': True}


class _FakeConn:
    def cursor(self):
        return _FakeCursor()


def test_no_snapshots_keeps_system_exit():
    import pytest
    from pg_statviz.modules.io import io

    with pytest.raises(SystemExit, match="No pg_statviz snapshots"):
        io(conn=_FakeConn(), info={'hostname': 'example'})
