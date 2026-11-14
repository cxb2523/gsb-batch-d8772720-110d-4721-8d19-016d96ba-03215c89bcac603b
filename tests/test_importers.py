"""Importer tests — the 'bring your own data' path must reach the same tables
the adapters write to, or the claim in the README is empty."""
import csv
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from framework.importers import (  # noqa: E402
    PRESETS,
    FieldMap,
    _num,
    import_csv,
    import_json,
    import_rows,
    read_json,
)
from framework.store import Store  # noqa: E402

# Column names here are MediaCrawler's, taken from store/xhs/_store_impl.py.
_MC_ROWS = [
    {"note_id": "n1", "type": "normal", "title": "Rice cooker guide", "desc": "body text",
     "time": "1700000000", "nickname": "someone", "creator_hash": "abc123",
     "liked_count": "820", "collected_count": "1490", "comment_count": "93",
     "share_count": "210", "note_url": "https://x/n1", "tag_list": "kitchen",
     "source_keyword": "rice cooker", "video_url": ""},
    {"note_id": "n2", "type": "video", "title": "Cat vs printer", "desc": "",
     "time": "1700086400", "nickname": "other", "creator_hash": "def456",
     "liked_count": "1.5万", "collected_count": "910", "comment_count": "1840",
     "share_count": "620", "note_url": "https://x/n2", "tag_list": "pets",
     "source_keyword": "", "video_url": "https://v/n2"},
]


@pytest.fixture
def store():
    path = tempfile.mktemp(suffix=".db")
    s = Store(path)
    yield s
    s.close()
    os.path.exists(path) and os.remove(path)


def test_preset_import_reaches_all_tables(store):
    tally = import_rows(store, _MC_ROWS, platform="xhs", preset="mediacrawler_xhs")
    assert tally["items"] == 2
    assert tally["entities"] == 2
    assert tally["metrics"] == 8          # 4 metrics x 2 rows
    assert tally["texts"] == 1            # only n1 has a desc
    assert tally["skipped"] == 0

    counts = store.counts()
    assert counts["items"] == 2
    assert counts["metrics"] == 8


def test_imported_data_flows_into_the_analysis_layer(store):
    """The whole point: analysis code must work on imported rows unchanged."""
    from framework.analysis.xhs_insights import collect_rate_ranking
    import_rows(store, _MC_ROWS, platform="xhs", preset="mediacrawler_xhs")

    ranked = collect_rate_ranking(store.con, "xhs", top=5)
    assert [r["item"] for r in ranked] == ["n1", "n2"]      # guide outranks the cat
    assert ranked[0]["collect_per_like"] == pytest.approx(1490 / 820, abs=0.01)
    assert ranked[0]["title"] == "Rice cooker guide"


def test_chinese_unit_counts_are_parsed(store):
    import_rows(store, _MC_ROWS, platform="xhs", preset="mediacrawler_xhs")
    row = store.con.execute(
        "SELECT metric_value FROM metrics WHERE ref_id='n2' AND metric_name='like_count'"
    ).fetchone()
    assert row[0] == 15000.0        # '1.5万'


def test_author_ids_are_anonymized(store):
    import_rows(store, _MC_ROWS, platform="xhs", preset="mediacrawler_xhs")
    ids = [r[0] for r in store.con.execute("SELECT entity_id FROM entities").fetchall()]
    assert "abc123" not in ids and "def456" not in ids
    assert all(len(i) > 0 for i in ids)
    # the nickname must not have leaked anywhere either
    dump = str(store.con.execute("SELECT * FROM entities").fetchall())
    assert "someone" not in dump


def test_rows_without_an_id_are_skipped_not_invented(store):
    rows = _MC_ROWS + [{"note_id": "", "title": "orphan"}, {"title": "no id at all"}]
    tally = import_rows(store, rows, platform="xhs", preset="mediacrawler_xhs")
    assert tally["items"] == 2
    assert tally["skipped"] == 2


def test_custom_mapping_for_an_unknown_format(store):
    rows = [{"post_id": "p1", "headline": "Hello", "likes": 10, "saves": 25}]
    tally = import_rows(store, rows, platform="custom", mapping=FieldMap(
        item_id="post_id", title="headline",
        metrics={"like_count": "likes", "collect_count": "saves"}))
    assert tally["items"] == 1 and tally["metrics"] == 2
    title = store.con.execute("SELECT title FROM items WHERE item_id='p1'").fetchone()[0]
    assert title == "Hello"


def test_missing_mapping_and_preset_is_an_error(store):
    with pytest.raises(ValueError, match="mapping=|preset="):
        import_rows(store, [], platform="x")
    with pytest.raises(ValueError, match="unknown preset"):
        import_rows(store, [], platform="x", preset="nope")


def test_csv_roundtrip(store, tmp_path):
    p = tmp_path / "notes.csv"
    with open(p, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(_MC_ROWS[0]))
        w.writeheader()
        w.writerows(_MC_ROWS)
    tally = import_csv(store, p, platform="xhs", preset="mediacrawler_xhs")
    assert tally["items"] == 2


def test_json_roundtrip_and_wrapped_payload(store, tmp_path):
    p = tmp_path / "notes.json"
    p.write_text(json.dumps(_MC_ROWS), encoding="utf-8")
    assert import_json(store, p, platform="xhs", preset="mediacrawler_xhs")["items"] == 2

    wrapped = tmp_path / "wrapped.json"
    wrapped.write_text(json.dumps({"data": _MC_ROWS}), encoding="utf-8")
    assert len(read_json(wrapped)) == 2

    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"nothing": "here"}), encoding="utf-8")
    with pytest.raises(ValueError, match="expected a JSON list"):
        read_json(bad)


@pytest.mark.parametrize("raw,expected", [
    (1234, 1234.0), ("1234", 1234.0), ("1,234", 1234.0), ("1.2万", 12000.0),
    ("1.2亿", 1.2e8), ("999+", 999.0), ("3.5k", 3500.0),
    ("", None), ("暂无", None), (None, None), (True, None),
])
def test_num_coercion(raw, expected):
    assert _num(raw) == expected


def test_presets_are_self_consistent():
    """A preset that maps nothing to a metric would silently import zero signal."""
    for name, fm in PRESETS.items():
        assert fm.item_id, f"{name} has no item_id column"
        assert fm.metrics, f"{name} maps no metrics"
