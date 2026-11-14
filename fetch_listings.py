"""Step 1 of 2: pull every listing for your hunt from Facebook Marketplace and Gumtree, via Apify.

Reads config.json. Needs your Apify token in a file called .env (APIFY_TOKEN=...).
No Facebook login is used, ever: Apify's official Marketplace scraper reads public listings.

Spend safety (please don't remove these):
  * It works out the worst-case cost BEFORE starting and refuses to run if that's over budget_usd.
  * Every run is started with a hard spend cap that Apify itself enforces (maxTotalChargeUsd).
  * It prints the real cost at the end.

Run:  python fetch_listings.py           (asks before spending)
      python fetch_listings.py --yes     (no question)
Writes raw/fb.json and raw/gt.json.
"""
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


def token():
    env = HERE / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("APIFY_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"')
    if os.environ.get("APIFY_TOKEN"):
        return os.environ["APIFY_TOKEN"]
    sys.exit("No Apify token. Make a file called .env in this folder containing:  APIFY_TOKEN=your_token_here")


def start(actor, run_input, cap_usd, tok):
    r = requests.post(f"{API}/acts/{actor}/runs", params={"token": tok, "maxTotalChargeUsd": round(cap_usd, 2)},
                      json=run_input, timeout=60)
    r.raise_for_status()
    return r.json()["data"]


def wait(run, tok, label):
    while True:
        d = requests.get(f"{API}/actor-runs/{run['id']}", params={"token": tok}, timeout=60).json()["data"]
        if d["status"] in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            items = requests.get(f"{API}/datasets/{d['defaultDatasetId']}/items", params={"token": tok, "clean": 1}, timeout=120).json()
            cost = d.get("usageTotalUsd") or 0
            print(f"  {label}: {d['status']}, {len(items)} listings, US${cost:.2f}")
            return items, cost
        time.sleep(10)


def main():
    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    tok = token()
    fb, gt = cfg["facebook"], cfg["gumtree"]
    fb_n = fb["results_per_query"] * len(fb["queries"])
    gt_n = gt["max_items"] if gt.get("enabled") else 0
    worst = fb_n * FB_PER_ITEM + gt_n * GT_PER_ITEM
    print(f"Worst case: {fb_n} Facebook + {gt_n} Gumtree listings = about US${worst:.2f} (your budget: US${cfg['budget_usd']:.2f})")
    if worst > cfg["budget_usd"]:
        sys.exit("Over budget. Lower results_per_query / max_items in config.json, or raise budget_usd.")
    if "--yes" not in sys.argv and input("Go ahead? (y/n) ").strip().lower() != "y":
        sys.exit("Stopped, nothing spent.")

    (HERE / "raw").mkdir(exist_ok=True)
    total = 0.0
    fb_items = []
    for q in fb["queries"]:
        url = (f"https://www.facebook.com/marketplace/{fb['city_slug']}/search/?minPrice={cfg['price_min']}"
               f"&maxPrice={cfg['price_max']}&exact=false&query={urllib.parse.quote(q)}")
        run = start(FB_ACTOR, {"startUrls": [{"url": url}], "resultsLimit": fb["results_per_query"], "includeListingDetails": False},
                    fb["results_per_query"] * FB_PER_ITEM * 1.2 + 0.05, tok)
        items, cost = wait(run, tok, f"Facebook '{q}'")
        fb_items += items
        total += cost
    (HERE / "raw" / "fb.json").write_text(json.dumps(fb_items, ensure_ascii=False), encoding="utf-8")

    gt_items = []
    if gt.get("enabled"):
        run = start(GT_ACTOR, {"gumtreeSearchRegion": gt["region"], "gumtreeSearchCategoryId": gt["category_id"],
                               "gumtreeSearchLocationId": gt["location_id"], "gumtreeSearchKeywords": gt["keywords"],
                               "gumtreeSearchMinPrice": cfg["price_min"], "gumtreeSearchMaxPrice": cfg["price_max"],
                               "maxItems": gt["max_items"], "includeListingDetails": True, "includePhoneDetails": False,
                               "enrichEmails": False, "gumtreeSearchSort": "most_recent"},
                    gt["max_items"] * GT_PER_ITEM * 1.2 + 0.05, tok)
        gt_items, cost = wait(run, tok, "Gumtree")
        total += cost
    (HERE / "raw" / "gt.json").write_text(json.dumps(gt_items, ensure_ascii=False), encoding="utf-8")
    print(f"Done. {len(fb_items)} Facebook + {len(gt_items)} Gumtree listings saved to raw/. Real cost: US${total:.2f}")
    print("Next:  python build_data.py")


if __name__ == "__main__":
    main()
