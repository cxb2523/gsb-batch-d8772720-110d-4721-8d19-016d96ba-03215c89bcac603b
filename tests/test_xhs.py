"""Offline unit tests — no cookies or network required. Tests parser mapping and compliance using mock data.
Usage: pytest tests/  or  python3 -m pytest tests/
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import compliance
from framework.adapters import xhs


def test_parse_and_extract():
    html = '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"x":{"note":{"noteId":"x"}}}}}</script>'
    assert xhs.extract_note(xhs.parse_initial_state(html))["noteId"] == "x"


def test_num_units():
    assert xhs._num("1.2万") == 12000
    assert xhs._num("1.2亿") == 1.2e8
    assert xhs._num("999+") == 999
    assert xhs._num("1,234") == 1234
    assert xhs._num("abc") is None


def test_extract_picks_current_note():
    """When noteDetailMap contains recommended notes, currentNoteId correctly selects the current note."""
    state = {"note": {"currentNoteId": "target", "noteDetailMap": {
        "rec": {"note": {"noteId": "rec"}}, "target": {"note": {"noteId": "target"}}}}}
    assert xhs.extract_note(state)["noteId"] == "target"


def test_note_to_records_desensitize_and_metrics():
    note = {"noteId": "a", "user": {"userId": "u", "nickname": "张三", "red_id": "x"},
            "interactInfo": {"collectedCount": "3456", "likedCount": "1.2万"},
            "desc": "正文 #美食[话题]#"}
    e, it, mets, txts = xhs.note_to_records(note)
    assert e.entity_id.startswith("xhs_")               # anonymized anon_id
    assert "张三" not in str(e.profile)                  # nickname must not leak
    md = {m.metric_name: m.metric_value for m in mets}
    assert md["collect_count"] == 3456 and md["like_count"] == 12000   # saves as primary signal
    assert "#美食" in txts[0].content and "[话题]" not in txts[0].content  # topic bracket stripped


def test_note_to_records_robust_empty():
    """Empty / malformed note must not raise."""
    e, it, mets, txts = xhs.note_to_records({"tagList": [None, "x"], "imageList": [None]})
    assert it.meta["tags"] == [] and it.meta["cover"] is None


def test_compliance_scrub_user():
    u = compliance.scrub_user({"user_id": "123", "nickname": "李四", "ip": "1.1.1.1", "fans": 99})
    assert "user_id" not in u and "nickname" not in u and "ip" not in u
    assert u["anon_id"].startswith("xhs_") and u["fans"] == 99


def test_ratelimiter_daily_cap():
    rl = compliance.RateLimiter(lo=0, hi=0, daily_limit=2)
    rl.wait()
    rl.wait()
    with pytest.raises(RuntimeError):
        rl.wait()


def test_config_driven():
    """Changing the config field mapping takes effect without touching code."""
    note = {"noteId": "a", "interactInfo": {"collectedCount": "10"}}
    custom = dict(xhs._CFG)
    custom["metrics"] = {"fav": "collectedCount"}
    mets = xhs.note_to_records(note, cfg=custom)[2]
    assert {m.metric_name: m.metric_value for m in mets} == {"fav": 10}
