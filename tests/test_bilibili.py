#!/usr/bin/env python3
"""test_bilibili.py — Bilibili adapter: parser layer + fetch-layer error handling (offline, no network)."""
import pytest

import framework.adapters.bilibili as bm
from framework.adapters.bilibili import BilibiliAdapter, video_to_records


def _video():
    return {
        "bvid": "BV1xx411c7", "title": "测试视频", "desc": "视频简介", "pubdate": 1700000000,
        "pic": "https://x.jpg", "tname": "游戏", "duration": 100,
        "owner": {"mid": 12345, "name": "测试up主"},
        "stat": {"view": 1000, "like": 100, "coin": 50, "favorite": 80,
                 "share": 10, "reply": 20, "danmaku": 30},
    }


def test_video_to_records_fields():
    """Bilibili video → 5-table schema contract: field mapping correct, including Bilibili-specific coin/danmaku."""
    _, item, mets, txts = video_to_records(_video(), "热门", "综合")
    assert item.platform == "bilibili"
    assert item.item_id == "BV1xx411c7"
    assert item.url == "https://www.bilibili.com/video/BV1xx411c7"
    m = {x.metric_name: x.metric_value for x in mets}
    assert m["view_count"] == 1000
    assert m["collect_count"] == 80    # favorite → collect_count (same metric name as Xiaohongshu, core signal)
    assert m["coin_count"] == 50       # Bilibili-specific: coin (stronger signal than like — costs hard currency)
    assert m["danmaku_count"] == 30    # Bilibili-specific: danmaku (live comments)
    assert len(txts) == 1              # desc


def test_video_to_records_anonymizes_owner():
    """Owner is anonymized before storage: raw mid must not appear — only the irreversible anon_id is stored."""
    ent, _, _, _ = video_to_records(_video())
    assert ent.entity_id                       # anon_id is present
    assert "12345" not in ent.entity_id        # the raw mid never appears
    assert ent.entity_type == "up"


def test_fetch_json_raises_on_bili_error_code(monkeypatch):
    """Bilibili API code!=0 (rate-limit -412, etc.) must raise RuntimeError — not silently return empty."""
    ad = BilibiliAdapter.__new__(BilibiliAdapter)
    ad.rl = type("_RL", (), {"wait": lambda self: None})()

    class _Resp:
        def read(self):
            return b'{"code":-412,"message":"rate-limited"}'

    monkeypatch.setattr(bm.urllib.request, "urlopen", lambda *a, **k: _Resp())
    with pytest.raises(RuntimeError):
        ad._fetch_json("https://api.bilibili.com/x")
