#!/usr/bin/env python3
"""test_prism.py — One-call API: prism.Insights analysis facade + analyze entry-point validation (offline)."""
import sqlite3

import pytest

import prism
from framework.adapter import Entity, Item, Metric
from framework.store import Store


def test_insights_lenses(tmp_path):
    """Insights wraps a db connection; collect-rate lens calculates correctly (cross-platform — tested with bilibili data)."""
    db = str(tmp_path / "t.db")
    st = Store(db)
    st.upsert_entity(Entity("bilibili", "u1", "up"))
    st.upsert_item(Item("bilibili", "b1", "u1", "video"))
    st.add_metric(Metric("bilibili", "item", "b1", "like_count", 100))
    st.add_metric(Metric("bilibili", "item", "b1", "collect_count", 80))
    st.close()

    ins = prism.Insights(sqlite3.connect(db), "bilibili")
    r = ins.collect_rate_ranking()
    assert r[0]["item"] == "b1"
    assert abs(r[0]["collect_per_like"] - 0.8) < 1e-6
    ins.close()


def test_analyze_rejects_unknown_platform():
    """Unknown platform raises explicitly — no silent failure."""
    with pytest.raises(ValueError):
        prism.analyze("myspace")
