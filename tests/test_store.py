#!/usr/bin/env python3
"""test_store.py — Storage layer tests (upsert overwrite / metric append / None skip / table counts). Offline."""
from dataclasses import replace

from framework.adapter import Entity, Item, Metric, Text
from framework.store import Store


def _store(tmp_path):
    return Store(str(tmp_path / "t.db"))


def test_upsert_entity_overwrites(tmp_path):
    """Duplicate upsert on the same primary key (platform, entity_id) overwrites — does not add a row."""
    st = _store(tmp_path)
    e = Entity("xhs", "u1", "author", name="old")
    st.upsert_entity(e)
    st.upsert_entity(replace(e, name="new"))
    assert st.counts()["entities"] == 1
    assert st.con.execute("SELECT name FROM entities WHERE entity_id='u1'").fetchone()[0] == "new"
    st.close()


def test_add_metric_appends(tmp_path):
    """metrics is a log table: writing the same ref_id twice yields two rows (enables time-series)."""
    st = _store(tmp_path)
    st.add_metric(Metric("xhs", "item", "i1", "like_count", 100))
    st.add_metric(Metric("xhs", "item", "i1", "like_count", 200))
    assert st.counts()["metrics"] == 2
    vals = [r[0] for r in st.con.execute(
        "SELECT metric_value FROM metrics WHERE ref_id='i1' ORDER BY id")]
    assert vals == [100.0, 200.0]
    st.close()


def test_add_metric_skips_none(tmp_path):
    """metric_value=None must not write an empty row (unavailable metrics are skipped)."""
    st = _store(tmp_path)
    st.add_metric(Metric("xhs", "item", "i1", "like_count", None))
    assert st.counts()["metrics"] == 0
    st.close()


def test_counts_all_tables(tmp_path):
    """Row counts across all 5 tables are correct."""
    st = _store(tmp_path)
    st.upsert_entity(Entity("xhs", "u1", "author"))
    st.upsert_item(Item("xhs", "i1", "u1", "note", title="t"))
    st.add_metric(Metric("xhs", "item", "i1", "like_count", 10))
    st.add_text(Text("xhs", "item", "i1", "desc", "hello"))
    assert st.counts() == {"entities": 1, "items": 1, "metrics": 1, "texts": 1, "features": 0}
    st.close()
