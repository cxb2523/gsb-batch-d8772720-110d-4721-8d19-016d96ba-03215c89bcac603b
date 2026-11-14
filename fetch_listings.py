"""Step 1 of 2: pull every listing for your hunt from Facebook Marketplace and Gumtree, via Apify.

Reads config.json. Needs your Apify token in a file called .env (APIFY_TOKEN=...).
No Facebook login is used, ever: Apify's official Marketplace scraper reads public listings.

Facebook is fetched one keyword at a time and every keyword's fate is written to
raw/fb_manifest.json as it happens, so a failed keyword never stops the others and
a crash halfway through loses nothing. Re-running the script only fetches the
keywords that didn't succeed last time (--force re-fetches everything).
raw/fb.json is rebuilt from the manifest each run and holds exactly the successful
keywords' listings, so resuming never doubles anything up.

Spend safety (please don't remove these):
  * It works out the worst-case cost BEFORE starting and refuses to run if that's over budget_usd.
  * Every run is started with a hard spend cap that Apify itself enforces (maxTotalChargeUsd).
  * If the budget left can't cover the next keyword's capped worst cost, that keyword is
    marked "budget-skipped" in the manifest and the summary, never silently dropped.
  * It prints the real cost at the end.

Run:  python fetch_listings.py            (asks before spending)
      python fetch_listings.py --yes      (no question)
      python fetch_listings.py --force    (re-fetch every keyword, even ones that succeeded)
Writes raw/fb.json, raw/fb_manifest.json and raw/gt.json.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
API = "https://api.apify.com/v2"
FB_ACTOR = "apify~facebook-marketplace-scraper"   # official Apify actor, pay per listing
GT_ACTOR = "memo23~gumtree-cheerio"               # Gumtree AU/UK/SA, pay per result
FB_PER_ITEM = 0.0062                              # US$ per listing on the free plan (check the actor's Pricing tab)
GT_PER_ITEM = 0.00175                             # US$ per result

# Per-keyword outcomes recorded in raw/fb_manifest.json
SUCCESS = "success"
FAILED = "failed"
TIMED_OUT = "timed-out"
ABORTED = "aborted"
BUDGET_SKIPPED = "budget-skipped"
TERMINAL = {"SUCCEEDED": SUCCESS, "FAILED": FAILED, "TIMED-OUT": TIMED_OUT, "ABORTED": ABORTED}


def token(base=HERE):
    env = base / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("APIFY_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"')
    if os.environ.get("APIFY_TOKEN"):
        return os.environ["APIFY_TOKEN"]
    sys.exit("No Apify token. Make a file called .env in this folder containing:  APIFY_TOKEN=your_token_here")


def fb_cap(fb):
    """Most one Facebook keyword run can possibly charge (the cap we set on the run)."""
    return fb["results_per_query"] * FB_PER_ITEM * 1.2 + 0.05


def gt_cap(gt):
    return gt["max_items"] * GT_PER_ITEM * 1.2 + 0.05


def start(actor, run_input, cap_usd, tok):
    r = requests.post(f"{API}/acts/{actor}/runs", params={"token": tok, "maxTotalChargeUsd": round(cap_usd, 2)},
                      json=run_input, timeout=60)
    r.raise_for_status()
    return r.json()["data"]


def wait(run, tok, label):
    """Poll a run to the end. Returns (status, items, cost); items are kept only on success."""
    while True:
        d = requests.get(f"{API}/actor-runs/{run['id']}", params={"token": tok}, timeout=60).json()["data"]
        if d["status"] in TERMINAL:
            cost = d.get("usageTotalUsd") or 0
            items = []
            if d["status"] == "SUCCEEDED":
                items = requests.get(f"{API}/datasets/{d['defaultDatasetId']}/items",
                                     params={"token": tok, "clean": 1}, timeout=120).json()
            print(f"  {label}: {d['status']}, {len(items)} listings, US${cost:.2f}")
            return TERMINAL[d["status"]], items, cost
        time.sleep(10)


def load_manifest(raw_dir):
    p = raw_dir / "fb_manifest.json"
    if p.exists():
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(m, dict) and isinstance(m.get("keywords"), dict):
                return m
        except (ValueError, OSError):
            pass
    return {"version": 1, "keywords": {}}


def save_manifest(raw_dir, manifest):
    (raw_dir / "fb_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")


def write_fb_json(raw_dir, manifest, queries):
    """raw/fb.json = the successful keywords' listings, in config order. Rebuilt, never appended to."""
    items = []
    for q in queries:
        rec = manifest["keywords"].get(q)
        if rec and rec["status"] == SUCCESS:
            items += rec.get("items", [])
    (raw_dir / "fb.json").write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    return len(items)


def run_facebook(cfg, tok, raw_dir, force, budget):
    """Fetch each Facebook keyword on its own. One keyword failing never stops the rest."""
    fb = cfg["facebook"]
    manifest = load_manifest(raw_dir)
    rows, spent = [], 0.0
    for q in fb["queries"]:
        old = manifest["keywords"].get(q)
        if not force and old and old["status"] == SUCCESS:
            print(f"  Facebook '{q}': already have {old['count']} listings from an earlier run, skipping "
                  f"(use --force to re-fetch)")
            rows.append({"query": q, "status": SUCCESS, "count": old["count"],
                         "cost": old["cost_usd"], "note": "kept from earlier run"})
            continue
        cap = fb_cap(fb)
        if budget - spent < cap:
            print(f"  Facebook '{q}': budget-skipped, US${budget - spent:.2f} left can't cover its "
                  f"worst case US${cap:.2f}")
            manifest["keywords"][q] = {"status": BUDGET_SKIPPED, "count": 0, "cost_usd": 0.0, "items": []}
            save_manifest(raw_dir, manifest)
            write_fb_json(raw_dir, manifest, fb["queries"])
            rows.append({"query": q, "status": BUDGET_SKIPPED, "count": 0, "cost": 0.0,
                         "note": "not enough budget left"})
            continue
        url = (f"https://www.facebook.com/marketplace/{fb['city_slug']}/search/?minPrice={cfg['price_min']}"
               f"&maxPrice={cfg['price_max']}&exact=false&query={urllib.parse.quote(q)}")
        try:
            run = start(FB_ACTOR, {"startUrls": [{"url": url}], "resultsLimit": fb["results_per_query"],
                                   "includeListingDetails": False}, cap, tok)
            status, items, cost = wait(run, tok, f"Facebook '{q}'")
            note = "" if status == SUCCESS else f"Apify run {status}"
        except Exception as exc:
            status, items, cost, note = FAILED, [], 0.0, str(exc)
            print(f"  Facebook '{q}': failed to start or poll ({exc}), moving on")
        spent += cost
        manifest["keywords"][q] = {"status": status, "count": len(items),
                                   "cost_usd": round(cost, 4), "items": items}
        save_manifest(raw_dir, manifest)
        write_fb_json(raw_dir, manifest, fb["queries"])
        rows.append({"query": q, "status": status, "count": len(items), "cost": cost, "note": note})
    return rows, spent


def run_gumtree(cfg, tok, raw_dir, budget_left):
    """One Gumtree run, as before. Its failure is reported but never touches the saved Facebook data."""
    gt = cfg["gumtree"]
    if not gt.get("enabled"):
        return {"label": "Gumtree", "status": "off", "count": 0, "cost": 0.0, "note": "disabled in config"}, 0.0
    cap = gt_cap(gt)
    if budget_left < cap:
        print(f"  Gumtree: budget-skipped, US${budget_left:.2f} left can't cover its worst case US${cap:.2f}")
        return {"label": "Gumtree", "status": BUDGET_SKIPPED, "count": 0, "cost": 0.0,
                "note": "not enough budget left"}, 0.0
    try:
        run = start(GT_ACTOR, {"gumtreeSearchRegion": gt["region"], "gumtreeSearchCategoryId": gt["category_id"],
                               "gumtreeSearchLocationId": gt["location_id"], "gumtreeSearchKeywords": gt["keywords"],
                               "gumtreeSearchMinPrice": cfg["price_min"], "gumtreeSearchMaxPrice": cfg["price_max"],
                               "maxItems": gt["max_items"], "includeListingDetails": True, "includePhoneDetails": False,
                               "enrichEmails": False, "gumtreeSearchSort": "most_recent"}, cap, tok)
        status, items, cost = wait(run, tok, "Gumtree")
        note = "" if status == SUCCESS else f"Apify run {status}"
    except Exception as exc:
        status, items, cost, note = FAILED, [], 0.0, str(exc)
        print(f"  Gumtree: failed to start or poll ({exc})")
    if status == SUCCESS:
        (raw_dir / "gt.json").write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    else:
        print("  Gumtree: keeping any existing raw/gt.json untouched")
    return {"label": "Gumtree", "status": status, "count": len(items), "cost": cost, "note": note}, cost


def print_summary(fb_rows, gt_row, fb_total, spent_this_run):
    print("\n--- Run summary ---")
    for r in fb_rows:
        note = f"  ({r['note']})" if r["note"] else ""
        print(f"  {r['query']:<28} {r['status']:<15} {r['count']:>4} listings  US${r['cost']:.2f}{note}")
    note = f"  ({gt_row['note']})" if gt_row["note"] else ""
    print(f"  {gt_row['label']:<28} {gt_row['status']:<15} {gt_row['count']:>4} listings  US${gt_row['cost']:.2f}{note}")
    print(f"  TOTAL: {fb_total} Facebook + {gt_row['count']} Gumtree listings in raw/. "
          f"Spent this run: US${spent_this_run:.2f}")
    unfinished = [r["query"] for r in fb_rows if r["status"] != SUCCESS]
    if unfinished:
        print("  Not done: " + ", ".join(f"'{q}'" for q in unfinished) +
              " — just run the script again to retry only these.")


def main(argv=None, base=HERE):
    args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    args.add_argument("--yes", action="store_true", help="don't ask before spending")
    args.add_argument("--force", action="store_true", help="re-fetch every keyword, even ones that succeeded")
    args = args.parse_args(argv)

    cfg = json.loads((base / "config.json").read_text(encoding="utf-8"))
    tok = token(base)
    raw_dir = base / "raw"
    fb, gt = cfg["facebook"], cfg["gumtree"]

    manifest = load_manifest(raw_dir)
    pending = [q for q in fb["queries"]
               if args.force or manifest["keywords"].get(q, {}).get("status") != SUCCESS]
    fb_n = fb["results_per_query"] * len(pending)
    gt_n = gt["max_items"] if gt.get("enabled") else 0
    worst = fb_n * FB_PER_ITEM + gt_n * GT_PER_ITEM
    kept = len(fb["queries"]) - len(pending)
    reuse = f" (reusing {kept} keyword(s) already fetched, fetching {len(pending)})" if kept and not args.force else ""
    print(f"Worst case this run: {fb_n} Facebook + {gt_n} Gumtree listings = about US${worst:.2f} "
          f"(your budget: US${cfg['budget_usd']:.2f}){reuse}")
    if worst > cfg["budget_usd"]:
        sys.exit("Over budget. Lower results_per_query / max_items in config.json, or raise budget_usd.")
    if not args.yes and input("Go ahead? (y/n) ").strip().lower() != "y":
        sys.exit("Stopped, nothing spent.")

    raw_dir.mkdir(exist_ok=True)
    fb_rows, fb_spent = run_facebook(cfg, tok, raw_dir, args.force, cfg["budget_usd"])
    gt_row, gt_spent = run_gumtree(cfg, tok, raw_dir, cfg["budget_usd"] - fb_spent)
    fb_total = write_fb_json(raw_dir, load_manifest(raw_dir), fb["queries"])
    print_summary(fb_rows, gt_row, fb_total, fb_spent + gt_spent)
    print("Next:  python build_data.py")


if __name__ == "__main__":
    main()
