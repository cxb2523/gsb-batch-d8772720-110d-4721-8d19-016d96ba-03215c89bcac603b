#!/usr/bin/env python3
"""test_analysis.py — Analysis layer tests (collect-rate ranking / distribution / grouping / topics). Uses the real store for writes then analyses. Offline."""
from framework.adapter import Entity, Item, Metric
from framework.analysis import quant, xhs_insights
from framework.store import Store


def _sample(tmp_path):
    """Write 3 xhs notes + like/collect/view metrics, return (con, store)."""
    st = Store(str(tmp_path / "t.db"))
    st.upsert_entity(Entity("xhs", "u1", "author"))
    # (id, note_type, tags, like, collect, view) — collect-rate = collect/like
    specs = [
        ("i1", "normal", ["美食", "探店"], 100, 50, 1000),   # collect-rate 0.5
        ("i2", "video", ["旅游", "风景"], 200, 80, 140),     # collect-rate 0.4
        ("i3", "normal", ["美食", "教程"], 150, 90, 500),    # collect-rate 0.6 — highest
    ]
    for iid, ntype, tags, like, collect, view in specs:
        st.upsert_item(Item("xhs", iid, "u1", "note", meta={"note_type": ntype, "tags": tags}))
        st.add_metric(Metric("xhs", "item", iid, "like_count", like), "2026-01-01T00:00:00+00:00")
        st.add_metric(Metric("xhs", "item", iid, "collect_count", collect), "2026-01-01T00:00:00+00:00")
        st.add_metric(Metric("xhs", "item", iid, "view_count", view), "2026-01-01T00:00:00+00:00")
    return st.con, st


def test_collect_rate_ranking_order_and_value(tmp_path):
    """Collect-rate ranking is in descending order and collect_per_like is calculated correctly (core signal)."""
    con, st = _sample(tmp_path)
    r = xhs_insights.collect_rate_ranking(con, top=10)
    assert [x["item"] for x in r] == ["i3", "i1", "i2"]      # 0.6 > 0.5 > 0.4
    assert abs(r[0]["collect_per_like"] - 0.6) < 1e-6
    assert r[0]["collect"] == 90 and r[0]["like"] == 150
    st.close()


def test_collect_rate_ranking_uses_latest_complete_snapshot(tmp_path):
    """A second capture must not cross-pair old likes with new saves."""
    con, st = _sample(tmp_path)
    st.add_metric(Metric("xhs", "item", "i1", "like_count", 100), "2026-01-02T00:00:00+00:00")
    st.add_metric(Metric("xhs", "item", "i1", "collect_count", 80), "2026-01-02T00:00:00+00:00")
    r = xhs_insights.collect_rate_ranking(con, top=10)
    assert r[0] == {"item": "i1", "collect": 80, "like": 100,
                    "collect_per_like": 0.8, "title": ""}
    assert len([x for x in r if x["item"] == "i1"]) == 1
    st.close()


def test_distribution_n_and_median(tmp_path):
    """Percentile distribution: n and median are correct."""
    con, st = _sample(tmp_path)
    d = quant.distribution(con, "xhs", "view_count", "item")
    assert d is not None
    assert d["n"] == 3
    assert d["median"] == 500   # sorted [140, 500, 1000] → median 500
    st.close()


def test_distribution_none_when_empty(tmp_path):
    """Empty data returns None (not a crash or an empty dict)."""
    st = Store(str(tmp_path / "t.db"))
    assert quant.distribution(st.con, "xhs", "view_count", "item") is None
    st.close()


def test_note_type_compare_groups(tmp_path):
    """Average saves grouped by meta.note_type — fields type/n/avg_collect."""
    con, st = _sample(tmp_path)
    rows = {r["type"]: r for r in xhs_insights.note_type_compare(con, "xhs")}
    assert rows["normal"]["n"] == 2 and rows["normal"]["avg_collect"] == 70   # (50+90)/2
    assert rows["video"]["n"] == 1 and rows["video"]["avg_collect"] == 80
    st.close()


def test_note_type_compare_uses_latest_collect_snapshot(tmp_path):
    """Averages must use one latest collect value per note, not historical rows."""
    con, st = _sample(tmp_path)
    st.add_metric(Metric("xhs", "item", "i1", "collect_count", 150), "2026-01-02T00:00:00+00:00")
    rows = {r["type"]: r for r in xhs_insights.note_type_compare(con, "xhs")}
    assert rows["normal"] == {"type": "normal", "n": 2, "avg_collect": 120}
    st.close()


def test_topic_frequency(tmp_path):
    """Hashtag frequency count (from meta.tags)."""
    con, st = _sample(tmp_path)
    freq = dict(xhs_insights.topic_frequency(con, "xhs"))
    assert freq["美食"] == 2    # appears in i1 + i3
    st.close()
