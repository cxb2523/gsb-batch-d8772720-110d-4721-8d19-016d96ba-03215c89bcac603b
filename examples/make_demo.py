#!/usr/bin/env python3
"""
make_demo.py — Generate an anonymized demo database

Lets anyone clone the repo and run the full analysis pipeline **without cookies or scraping**
(the "5-minute-to-run" requirement for reviewers).
All data is synthetic and anonymized; it flows through the real adapter→store pipeline into demo.db.

Usage: python3 examples/make_demo.py  →  generates demo.db (safe to commit; already in .gitignore allowlist)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from framework.adapters.xhs import note_to_records  # noqa: E402
from framework.store import Store  # noqa: E402

# Synthetic notes. The numbers are fabricated but the *pattern* is real: guides and
# tutorials get saved more than they get liked, while emotional/aesthetic posts collect
# likes and almost no saves. That gap is the whole point of ranking by collect-rate.
_SPECS = [
    # (title, tag, kind, likes, saves, comments, shares)
    ("How to pick a rice cooker without overpaying", "kitchen", "guide",     820,  1490,  93,  210),
    ("12 museums in the city that are free on Sundays", "citylife", "guide", 1240,  1980, 141,  330),
    ("Beginner sourdough: the whole schedule on one page", "baking", "guide", 2100, 2610, 268,  455),
    ("Every visa document I needed, in order", "paperwork", "guide",          640,  1520,  88,  190),
    ("Reading a rental contract line by line", "housing", "guide",            910,  1655, 122,  240),
    ("Cheap knife sharpening that actually works", "kitchen", "guide",        780,   940,  61,  105),
    ("Weeknight dinners I rotate through", "cooking", "mixed",               3050,  1830, 402,  260),
    ("What I pack for a 3-day trip", "travel", "mixed",                      2680,  1470, 351,  198),
    ("Desk setup after four rebuilds", "workspace", "mixed",                 4100,  2050, 512,  305),
    ("Coffee gear I stopped using", "coffee", "mixed",                       2240,  1120, 289,  144),
    ("Small apartment storage that survived a year", "housing", "mixed",     3320,  1660, 377,  221),
    ("Grocery run, no plan, mild regret", "cooking", "mixed",                1980,   790, 233,   96),
    ("My cat discovered the printer", "pets", "emotional",                  15200,   910, 1840,  620),
    ("Sunset from the window I complain about", "citylife", "emotional",      8700,   430,  902,  310),
    ("Six months of gym, one photo", "fitness", "emotional",                 11400,   680, 1355,  480),
    ("The dog waits at the same spot every day", "pets", "emotional",         9600,   520, 1010,  360),
    ("Rain on the last day of the trip", "travel", "emotional",              7300,   395,  815,  268),
    ("Finally finished the sweater", "craft", "emotional",                    6100,   740,  690,  212),
    ("Morning light in an empty cafe", "coffee", "emotional",                 5400,   310,  588,  175),
    ("A very ordinary Tuesday", "citylife", "emotional",                      4200,   260,  455,  140),
]

DEMO_NOTES = [
    {"noteId": f"demo{i:02d}",
     # guides skew to image posts (easier to re-read); emotional posts skew to video
     "type": "image" if kind == "guide" else ("video" if kind == "emotional" else ["image", "video"][i % 2]),
     "title": title,
     "desc": f"{title} #{tag}[话题]#",
     "time": 1700000000 + i * 86400,
     "user": {"userId": f"u{i % 5}", "nickname": f"creator{i % 5}", "fans": 1000 * (i % 5 + 1)},
     "interactInfo": {"likedCount": str(likes), "collectedCount": str(saves),
                      "commentCount": str(comments), "shareCount": str(shares)},
     "imageList": [{"urlDefault": f"http://demo.local/cover{i}.jpg"}],
     "tagList": [{"name": tag}, {"name": kind}]}
    for i, (title, tag, kind, likes, saves, comments, shares) in enumerate(_SPECS)
]


def main():
    db = os.path.join(os.path.dirname(__file__), "..", "framework", "demo.db")
    if os.path.exists(db):
        os.remove(db)
    store = Store(db)
    for note in DEMO_NOTES:
        e, it, mets, txts = note_to_records(note, segment="zh", category="lifestyle")
        store.upsert_entity(e)
        store.upsert_item(it)
        store.add_metrics(mets)
        for t in txts:
            store.add_text(t)
    print("✓ demo.db generated:", store.counts())
    # Quick demo: top notes by collect-rate (RED's core signal)
    rows = store.con.execute("""
        SELECT lk.ref_id, ck.metric_value*1.0/lk.metric_value AS collect_per_like
        FROM metrics lk JOIN metrics ck ON lk.ref_id=ck.ref_id
        WHERE lk.metric_name='like_count' AND ck.metric_name='collect_count'
        ORDER BY collect_per_like DESC LIMIT 3""").fetchall()
    print("  collect-rate (saves/likes) top3:", [(r[0], round(r[1], 2)) for r in rows])
    store.close()


if __name__ == "__main__":
    main()
