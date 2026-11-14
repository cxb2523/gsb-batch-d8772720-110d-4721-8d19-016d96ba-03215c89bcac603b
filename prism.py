#!/usr/bin/env python3
"""
prism — high-level one-call API.

    import prism
    ins = prism.analyze("bilibili", limit=15)          # fetch → store → analyze, one call
    ins.collect_rate_ranking(top=5)                    # ranked by save-rate
    ins.distribution("collect_count")                  # quant distribution

    ins = prism.analyze("xhs", chrome_profile="Default", limit=10)   # XHS needs login cookies

Wraps the adapter → store → analysis pipeline so casual users never touch the internals.
Power users can still drop down to framework.adapters / framework.analysis directly.
"""
from __future__ import annotations

import sqlite3

from framework.analysis import quant, xhs_insights
from framework.store import Store

# platform → (import path, adapter class attr, default fetch method)
_ADAPTERS = {
    "xhs": ("framework.adapters.xhs", "XHSAdapter", "fetch_feed"),
    "bilibili": ("framework.adapters.bilibili", "BilibiliAdapter", "fetch_popular"),
    "douyin": ("framework.adapters.douyin", "DouyinAdapter", "fetch_feed"),
    "kuaishou": ("framework.adapters.kuaishou", "KuaishouAdapter", "fetch_by_ids"),
}


def analyze(platform: str, *, limit: int = 20, db: str = "prism.db", **adapter_opts) -> Insights:
    """One call: pick the adapter, fetch `limit` items, store to the 5 tables, return Insights.

    platform     : 'xhs' | 'bilibili' | 'douyin' | 'kuaishou'.
    adapter_opts : forwarded to the adapter constructor / fetch method.
                   douyin → category_keywords=[...] (filter the feed by keyword)
                   kuaishou → ids=[vid,...] (seed-ID mode; guest discovery is blocked)
    """
    if platform not in _ADAPTERS:
        raise ValueError(f"unknown platform '{platform}'; available: {list(_ADAPTERS)}")
    # Split constructor kwargs from fetch kwargs: ids/category_keywords go to fetch; the rest to the constructor
    ctor_opts = {k: v for k, v in adapter_opts.items()
                 if k not in ("ids", "category_keywords")}
    fetch_opts: dict = {}
    if "ids" in adapter_opts:
        fetch_opts["ids"] = adapter_opts["ids"]
    if "category_keywords" in adapter_opts:
        ctor_opts["category_keywords"] = adapter_opts["category_keywords"]
    mod_path, cls_name, fetch_name = _ADAPTERS[platform]
    mod = __import__(mod_path, fromlist=[cls_name])
    adapter = getattr(mod, cls_name)(**ctor_opts)

    if fetch_name == "fetch_by_ids":
        records = getattr(adapter, fetch_name)(**fetch_opts)
    else:
        records = getattr(adapter, fetch_name)(limit=limit, **fetch_opts)

    store = Store(db)
    n = 0
    for entity, item, metrics, texts in records:
        store.upsert_entity(entity)
        store.upsert_item(item)
        store.add_metrics(metrics)
        for t in texts:
            store.add_text(t)
        n += 1
    store.close()
    print(f"  → stored {n} items ({platform})")
    return Insights(sqlite3.connect(db), platform)


class Insights:
    """Thin wrapper over a populated DB connection — the analysis lenses, scoped to one platform."""

    def __init__(self, con: sqlite3.Connection, platform: str):
        self.con = con
        self.platform = platform

    def collect_rate_ranking(self, top: int = 10):
        """Save-rate ranking (collect/like) — Prism's core content-value signal."""
        return xhs_insights.collect_rate_ranking(self.con, self.platform, top)

    def note_type_compare(self):
        """Average saves by content type (image vs. video, etc.)."""
        return xhs_insights.note_type_compare(self.con, self.platform)

    def topic_frequency(self, top: int = 10):
        """Most frequent topic tags."""
        return xhs_insights.topic_frequency(self.con, self.platform, top)

    def distribution(self, metric: str = "collect_count"):
        """Quantile distribution of a metric (head extremity / long-tail length)."""
        return quant.distribution(self.con, self.platform, metric, "item")

    def concentration(self, metric: str = "collect_count"):
        """Market concentration (HHI + head/mid/tail tiers) of a metric."""
        return quant.concentration(self.con, self.platform, metric, "item")

    def close(self):
        self.con.close()


# ============================================================
# CLI — `prism demo` (offline) / `prism analyze <platform>` (live)
# ============================================================

def _print_report(ins: Insights) -> None:
    print("① Collect-rate ranking (save/like — Prism's core signal):")
    for r in ins.collect_rate_ranking(top=5):
        raw = r.get("title") or ""
        title = raw if len(raw) <= 46 else raw[:45] + "…"
        print(f"   {r['collect_per_like']:>5}  save {r['collect']:>6} / like {r['like']:>6}   {title}")
    nt = ins.note_type_compare()
    if nt:
        print("\n② By content type (avg saves):")
        for r in nt:
            print(f"   {str(r['type'] or '-'):8} n={r['n']:<4} avg_save={r['avg_collect']}")
    d = ins.distribution("collect_count")
    if d:
        print(f"\n③ Save distribution: n={d['n']} median={d['median']:.0f} "
              f"p90={d['p90']:.0f} max={d['max']:.0f}")
    c = ins.concentration("collect_count")
    if c:
        print(f"④ Save concentration: HHI={c['HHI']} top3-share={c['top3_share']}")


def main(argv: list[str] | None = None) -> None:
    import argparse
    import os

    p = argparse.ArgumentParser(prog="prism", description="Prism — platform-agnostic content research")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("demo", help="run the lenses on the bundled anonymized demo.db (offline, instant)")
    pa = sub.add_parser("analyze", help="fetch a live platform and analyze")
    pa.add_argument("platform", choices=list(_ADAPTERS))
    pa.add_argument("--limit", type=int, default=15)
    pa.add_argument("--profile", default=None, help="Chrome profile for cookie auto-read (xhs)")
    pa.add_argument("--ids", default=None, help="comma-separated video IDs for kuaishou seed mode")
    pa.add_argument("--cats", default=None,
                    help="comma-separated keywords to filter the douyin feed. Keywords are matched against Chinese captions, e.g. 火锅,探店 (hotpot, food review)")

    args = p.parse_args(argv)
    if args.cmd == "demo":
        demo_db = os.path.join(os.path.dirname(os.path.abspath(__file__)), "framework", "demo.db")
        print("Prism demo · bundled anonymized data\n")
        ins = Insights(sqlite3.connect(demo_db), "xhs")
        _print_report(ins)
        ins.close()
        print("\n✓ offline demo data. Live: prism analyze bilibili --limit 15")
    elif args.cmd == "analyze":
        opts: dict = {"chrome_profile": args.profile} if args.profile else {}
        if args.cats:
            opts["category_keywords"] = [c.strip() for c in args.cats.split(",") if c.strip()]
        if args.ids:
            opts["ids"] = [i.strip() for i in args.ids.split(",") if i.strip()]
        print(f"Fetching {args.platform} (limit={args.limit}) …\n")
        try:
            ins = analyze(args.platform, limit=args.limit, **opts)
        except Exception as e:
            print(f"✗ {args.platform} fetch failed: {e}")
            return
        _print_report(ins)
        ins.close()
    else:
        p.print_help()


if __name__ == "__main__":
    main()
