#!/usr/bin/env python3
"""
xhs_insights.py — Xiaohongshu (RED) platform-specific analysis (Phase 2)

Operates on the 5-table schema. Wraps analysis angles unique to Xiaohongshu:
- collect_rate_ranking: collect-rate ranking (saves/likes) ⭐ RED's core signal — finds high-value content
- note_type_compare:    average saves for image posts vs videos
- topic_frequency:      top hashtags by frequency

Develop and verify against demo.db (anonymized synthetic data); swap con for your own
database path once you have real cookies.
Usage: python3 -m framework.analysis.xhs_insights   (runs demo.db demo)
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from pathlib import Path


def collect_rate_ranking(con, platform="xhs", top=10):
    """Collect-rate ranking (saves/likes). RED's core signal: high collect-rate = "useful / worth revisiting" = long-tail value."""
    rows = con.execute("""
        WITH paired_snapshots AS (
            SELECT lk.ref_id,
                   ck.metric_value AS collect,
                   lk.metric_value AS likes,
                   lk.captured_at,
                   lk.id AS like_metric_id,
                   ck.id AS collect_metric_id
            FROM metrics lk
            JOIN metrics ck
              ON lk.platform=ck.platform
             AND lk.ref_id=ck.ref_id
             AND lk.scope=ck.scope
             AND lk.captured_at=ck.captured_at
            WHERE lk.platform=?
              AND lk.scope='item'
              AND lk.metric_name='like_count'
              AND ck.metric_name='collect_count'
              AND lk.metric_value>0
        ), latest_paired AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY ref_id
                ORDER BY captured_at DESC, like_metric_id DESC, collect_metric_id DESC
            ) AS rn
            FROM paired_snapshots
        )
        SELECT p.ref_id, p.collect, p.likes,
               p.collect*1.0/p.likes AS collect_per_like, it.title
        FROM latest_paired p
        LEFT JOIN items it ON it.platform=? AND it.item_id=p.ref_id
        WHERE p.rn=1
        ORDER BY collect_per_like DESC LIMIT ?""", (platform, platform, top)).fetchall()
    return [{"item": r[0], "collect": int(r[1]), "like": int(r[2]),
             "collect_per_like": round(r[3], 2), "title": r[4] or ""} for r in rows]


def note_type_compare(con, platform="xhs"):
    """Image post vs video: average saves by note type (the two types follow different distribution logic)."""
    rows = con.execute("""
        WITH latest_collect AS (
            SELECT ref_id, metric_value,
                   ROW_NUMBER() OVER (
                       PARTITION BY ref_id ORDER BY captured_at DESC, id DESC
                   ) AS rn
            FROM metrics
            WHERE platform=? AND scope='item' AND metric_name='collect_count'
        )
        SELECT json_extract(i.meta_json,'$.note_type') AS ntype,
               COUNT(*) AS n, AVG(c.metric_value) AS avg_collect
        FROM items i
        JOIN latest_collect c
          ON c.ref_id=i.item_id AND c.rn=1
        WHERE i.platform=?
        GROUP BY ntype""", (platform, platform)).fetchall()
    return [{"type": r[0], "n": r[1], "avg_collect": round(r[2] or 0)} for r in rows]


def topic_frequency(con, platform="xhs", top=10):
    """Top hashtags by frequency (from items.meta_json.tags)."""
    c = Counter()
    for (meta,) in con.execute("SELECT meta_json FROM items WHERE platform=?", (platform,)):
        for t in (json.loads(meta or '{}').get('tags') or []):
            c[t] += 1
    return c.most_common(top)


if __name__ == "__main__":
    db = Path(__file__).resolve().parent.parent / "demo.db"
    con = sqlite3.connect(str(db))
    print("=== Xiaohongshu platform-specific analysis (demo.db demo) ===")
    print("\n① Collect-rate ranking top5 (saves/likes · RED core signal):")
    for r in collect_rate_ranking(con, top=5):
        print(f"   {r['item']}: saves {r['collect']} / likes {r['like']} = {r['collect_per_like']}")
    print("\n② Image post vs video (average saves):")
    for r in note_type_compare(con):
        print(f"   {r['type']}: n={r['n']}, avg_saves={r['avg_collect']}")
    print("\n③ Top hashtags top5:")
    for tag, n in topic_frequency(con, top=5):
        print(f"   #{tag}: {n} posts")

    # the generic analysis layer works on xhs too — same 5-table schema
    from framework.analysis import quant
    print("\n④ Generic quant lens (cross-platform reuse):")
    d = quant.distribution(con, "xhs", "collect_count", "item")
    c = quant.concentration(con, "xhs", "collect_count", "item")
    if d and c:
        print(f"   saves distribution: median {d['median']:.0f} / p90 {d['p90']:.0f} / max {d['max']:.0f}")
        print(f"   saves concentration: HHI={c['HHI']} top3_share={c['top3_share']}")

    con.close()
    print("\n✓ Platform-specific analysis (collect-rate / type / topic) + generic quant all working (demo.db verified)")
