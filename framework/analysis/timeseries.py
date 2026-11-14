#!/usr/bin/env python3
"""
timeseries.py — Time-series analysis lens (the "time" dimension)

The time dimension is the fourth axis. The first three dimensions (data / analysis / decisions)
are snapshots at a single moment T. This lens chains snapshots into a film: growth curves,
growth-rate leaderboards, and inflection detection.

⭐ The foundation was laid early: captured_at in the metrics table is the time axis.
   Each re-scrape appends a new row with a new captured_at; multiple rows per
   (ref_id, metric_name) form a time series. No schema changes needed.

Honest boundary (against "fake completion"): real time-series insights require ≥2 snapshot
   timestamps per object. snapshot_count() diagnoses readiness first; if data is insufficient,
   it says so explicitly — it does not pretend to compute.

Usage: import as a library — functions operate on the 5-table schema, called by xhs analysis
       and user scripts.
"""
from __future__ import annotations

from pathlib import Path

DB = Path(__file__).resolve().parent.parent.parent / "demo.db"


def snapshot_count(con, platform, metric="subs", scope="entity") -> dict:
    """Diagnose: how many objects have ≥2 snapshots (enough for time-series) and the data time span.
    Note: counts objects that can have growth computed — not a global timestamp dedup
    (different objects are collected at different times, so dedup would inflate the count)."""
    objs = con.execute(
        "SELECT COUNT(*) FROM (SELECT ref_id FROM metrics "
        "WHERE platform=? AND scope=? AND metric_name=? "
        "GROUP BY ref_id HAVING COUNT(DISTINCT captured_at) >= 2)",
        (platform, scope, metric)).fetchone()[0]
    span = con.execute(
        "SELECT MIN(captured_at), MAX(captured_at) FROM metrics "
        "WHERE platform=? AND scope=? AND metric_name=?",
        (platform, scope, metric)).fetchone()
    return {"objects_with_timeseries": objs, "earliest": span[0], "latest": span[1]}


def series(con, platform, scope, ref_id, metric) -> list[tuple[str, float]]:
    """Fetch the full time series for one object and metric: [(captured_at, value), ...] ordered by time."""
    return con.execute(
        "SELECT captured_at, metric_value FROM metrics "
        "WHERE platform=? AND scope=? AND ref_id=? AND metric_name=? "
        "ORDER BY captured_at", (platform, scope, ref_id, metric)).fetchall()


def growth(con, platform, scope, ref_id, metric) -> dict | None:
    """Growth between the first and last snapshot (absolute + relative). Requires ≥2 snapshots; returns None otherwise."""
    rows = series(con, platform, scope, ref_id, metric)
    if len(rows) < 2:
        return None
    (t0, v0), (t1, v1) = rows[0], rows[-1]
    abs_g = (v1 or 0) - (v0 or 0)
    rel_g = (abs_g / v0) if v0 else None
    return {"ref_id": ref_id, "from": t0, "to": t1, "v0": v0, "v1": v1,
            "abs_growth": abs_g, "rel_growth": rel_g, "snapshots": len(rows)}


def growth_leaderboard(con, platform, scope, metric, top=10) -> list[dict]:
    """Growth-rate leaderboard: rank objects with ≥2 snapshots by relative growth."""
    ids = [r[0] for r in con.execute(
        "SELECT ref_id FROM metrics WHERE platform=? AND scope=? AND metric_name=? "
        "GROUP BY ref_id HAVING COUNT(DISTINCT captured_at) >= 2",
        (platform, scope, metric)).fetchall()]
    out = []
    for rid in ids:
        g = growth(con, platform, scope, rid, metric)
        if g and g["rel_growth"] is not None:
            out.append(g)
    return sorted(out, key=lambda d: d["rel_growth"], reverse=True)[:top]


def inflection(values: list[float]) -> int | None:
    """Simple inflection detection: index where the first-difference changes sign (growth-to-decline or vice versa). Requires ≥3 points."""
    if len(values) < 3:
        return None
    diffs = [values[i + 1] - values[i] for i in range(len(values) - 1)]
    for i in range(1, len(diffs)):
        if diffs[i - 1] * diffs[i] < 0:
            return i
    return None
