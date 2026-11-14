#!/usr/bin/env python3
"""
quant.py — Quantitative analysis lens (platform-agnostic statistical view)

Large-sample metadata statistics: distribution, concentration, and cross-segment comparison.

Three core analyses, all operating on the generic metrics table (works across all platforms):
    concentration  — market concentration HHI + head/mid/tail tiers
    distribution   — metric percentiles (how top-heavy / how long the tail)
    cross_segment  — cross-segment comparison (control-group mindset: a single segment tells you nothing)

⭐ Uses MAX(captured_at) to fetch each object's latest snapshot — naturally compatible with
   future multi-snapshot time-series data without schema changes.

Usage: import as a library — functions operate on the 5-table schema, called by xhs analysis
       and user scripts.
"""
from __future__ import annotations

import sqlite3
import statistics
from pathlib import Path

DB = Path(__file__).resolve().parent.parent.parent / "demo.db"


def _latest(con: sqlite3.Connection, platform: str, scope: str,
            metric_name: str, only_ok: bool = True) -> list[tuple[str, float]]:
    """Fetch each ref_id's most recent snapshot value for a metric. only_ok filters out entities with status=error."""
    join_filter = ""
    if only_ok and scope == "entity":
        join_filter = ("JOIN entities e ON e.platform=m.platform AND e.entity_id=m.ref_id "
                       "AND e.status='ok'")
    elif only_ok and scope == "item":
        join_filter = ("JOIN items it ON it.platform=m.platform AND it.item_id=m.ref_id "
                       "AND it.status='ok'")
    sql = f"""
        SELECT m.ref_id, m.metric_value FROM metrics m
        {join_filter}
        JOIN (SELECT ref_id, MAX(captured_at) mx FROM metrics
              WHERE platform=? AND scope=? AND metric_name=? GROUP BY ref_id) t
          ON m.ref_id=t.ref_id AND m.captured_at=t.mx
        WHERE m.platform=? AND m.scope=? AND m.metric_name=?
    """
    args = (platform, scope, metric_name, platform, scope, metric_name)
    return con.execute(sql, args).fetchall()


def concentration(con, platform, metric_name="subs", scope="entity") -> dict | None:
    """Market concentration: HHI (0–10000) + top3/top10 share + head/mid/tail tier breakdown."""
    vals = [v for _, v in _latest(con, platform, scope, metric_name) if v and v > 0]
    if not vals:
        return None
    total = sum(vals)
    shares = sorted((v / total for v in vals), reverse=True)
    hhi = round(sum(s * s for s in shares) * 10000)
    tiers = {"head(>300k)": 0, "mid(30k-300k)": 0, "tail(<30k)": 0}
    for v in vals:
        if v > 300_000:
            tiers["head(>300k)"] += 1
        elif v >= 30_000:
            tiers["mid(30k-300k)"] += 1
        else:
            tiers["tail(<30k)"] += 1
    return {"n": len(vals), "HHI": hhi,
            "top3_share": round(sum(shares[:3]), 3),
            "top10_share": round(sum(shares[:10]), 3),
            "median": round(statistics.median(vals)),
            "mean": round(statistics.mean(vals)), "tiers": tiers}


def distribution(con, platform, metric_name="view_count", scope="item") -> dict | None:
    """Metric distribution: percentiles. Shows how extreme the top end is and how long the tail extends."""
    vals = sorted(v for _, v in _latest(con, platform, scope, metric_name) if v is not None)
    if not vals:
        return None
    def q(p):
        return vals[int(p * (len(vals) - 1))]
    return {"n": len(vals), "min": vals[0], "p25": q(.25), "median": q(.5),
            "p75": q(.75), "p90": q(.9), "p99": q(.99), "max": vals[-1]}


def cross_segment(con, platform, metric_name="view_count", scope="item") -> list[dict]:
    """Cross-segment comparison (control-group mindset). Returns n / mean / median / max per segment."""
    tbl = "items" if scope == "item" else "entities"
    idcol = "item_id" if scope == "item" else "entity_id"
    rows = con.execute(f"""
        SELECT x.segment, m.metric_value
        FROM metrics m
        JOIN {tbl} x ON x.platform=m.platform AND x.{idcol}=m.ref_id AND x.status='ok'
        JOIN (SELECT ref_id, MAX(captured_at) mx FROM metrics
              WHERE platform=? AND scope=? AND metric_name=? GROUP BY ref_id) t
          ON m.ref_id=t.ref_id AND m.captured_at=t.mx
        WHERE m.platform=? AND m.scope=? AND m.metric_name=?
    """, (platform, scope, metric_name, platform, scope, metric_name)).fetchall()
    by_seg: dict[str, list[float]] = {}
    for seg, val in rows:
        if val is None:
            continue
        by_seg.setdefault(seg or "(none)", []).append(val)
    out = []
    for seg, vals in by_seg.items():
        out.append({"segment": seg, "n": len(vals),
                    "mean": round(statistics.mean(vals)),
                    "median": round(statistics.median(vals)),
                    "max": round(max(vals))})
    return sorted(out, key=lambda d: d["mean"], reverse=True)
