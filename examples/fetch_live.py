#!/usr/bin/env python3
"""
fetch_live.py — End-to-end live fetch demo (macOS: auto-reads cookies from the Chrome profile
                where Xiaohongshu is already signed in)

Flow: decrypt cookies → fetch homepage feed → pull saves from each detail page → write to 5-table schema → run platform-specific analysis.
Usage: python3 examples/fetch_live.py

⚠️ This script uses chrome_profile='Default' (the macOS Chrome profile with an active Xiaohongshu session) — convenience demo only.
   For other environments (other machines / CI) use XHSAdapter(cookies_path='cookies.json') instead.
   Your database research.db is .gitignore-listed and will not be committed accidentally.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from framework.adapters.xhs import XHSAdapter  # noqa: E402
from framework.analysis import xhs_insights  # noqa: E402
from framework.store import Store  # noqa: E402

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(_ROOT, "research.db")


def main(limit: int = 10):
    print("=== Xiaohongshu end-to-end live fetch (Chrome profile with active session, fully automatic) ===")
    ad = XHSAdapter(chrome_profile="Default")
    print(f"Fetching homepage feed + pulling saves from each detail page (rate-limited 3-6s/item, ~{limit*5}s)...")
    records = ad.fetch_feed(segment="首页推荐", category="综合", limit=limit)
    print(f"✓ Fetched {len(records)} complete notes (including saves)")
    if not records:
        print("✗ Nothing fetched — check the Xiaohongshu login state in the local Chrome profile")
        return

    st = Store(DB)
    for ent, item, metrics, texts in records:
        st.upsert_entity(ent)
        st.upsert_item(item)
        st.add_metrics(metrics)
        for t in texts:
            st.add_text(t)
    print("5-table counts:", st.counts())
    st.close()

    con = sqlite3.connect(DB)
    print("\n① Collect-rate ranking top5 (saves/likes · RED core signal):")
    for r in xhs_insights.collect_rate_ranking(con, top=5):
        row = con.execute("SELECT title FROM items WHERE item_id=?", (r["item"],)).fetchone()
        title = (row[0] if row else "")[:18]
        print(f"   saves{r['collect']:>5}/likes{r['like']:>6} = {r['collect_per_like']:>5}  {title}")
    print("\n② Image post vs video (average saves):")
    for r in xhs_insights.note_type_compare(con):
        print(f"   {str(r['type']):6}: n={r['n']}, avg_saves={r['avg_collect']}")
    print("\n③ Top hashtags top5:")
    topics = xhs_insights.topic_frequency(con, top=5)
    if topics:
        for tag, n in topics:
            print(f"   #{tag}: {n} posts")
    else:
        print("   (most notes in this feed batch have no explicit hashtags)")
    con.close()
    print("\n✓ End-to-end live data pipeline working: Chrome cookies auto-read → fetch → 5-table → platform analysis")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10)
