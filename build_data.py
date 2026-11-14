"""Step 2 of 2: turn the raw listings into your Deal Radar dashboard.

Reads config.json + raw/fb.json + raw/gt.json (from fetch_listings.py). For every listing it works out:
  year, model, km, price, distance from your home, a fair market price (fitted on THIS data: price vs
  year + km, per model), the value of the aftermarket accessories, red flags from the fine print,
  a score out of 10, and Claude's top picks. Photos are saved locally because Facebook photo links expire.

Run:  python build_data.py      then open index.html in your browser.
Free: no paid APIs. (Distance for some Facebook listings uses OpenStreetMap's free geocoder, slowly, politely.)
"""
import io
import json
import math
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
RAW = HERE / "raw"
THUMBS = HERE / "thumbs"
HOME = (CFG["home"]["lat"], CFG["home"]["lng"])
MAX_KM_AWAY = CFG["radius_km"]

EXTRAS = [  # (regex, label, est. used value AUD) — rough resale value of the add-on, Claude's estimate
    (r"\barb\b[^.\n]{0,20}bar|bull ?bar|roo ?bar|bullbar", "Bull bar", 1200),
    (r"winch", "Winch", 600),
    (r"\buhf\b|gme", "UHF radio", 250),
    (r"dual batter|battery isolator|redarc|dc-?dc", "Dual battery", 700),
    (r"roof ?rack|roof ?racks|rhino rack|platform rack", "Roof rack", 500),
    (r"awning", "Awning", 300),
    (r"roof ?top tent|rooftop tent|rtt\b", "Rooftop tent", 1500),
    (r"canopy", "Canopy", 2000),
    (r"\btray\b|tray back|alloy tray", "Tray", 1200),
    (r"\blift\b|lifted|suspension|pedders|old man emu|\bome\b|airbags", "Suspension", 1000),
    (r"\ba/?t\b|all ?terrain|mud ?terrain|\bm/?t\b|bfg|duelers?|nitto|kumho|\btoyo\b|open country", "A/T tyres", 800),
    (r"tow ?bar|towbar|tow hitch", "Towbar", 400),
    (r"spot ?lights?|light ?bar|driving lights", "Lights", 350),
    (r"drawers|drawer system", "Drawers", 800),
    (r"fridge|engel|waeco|dometic", "Fridge", 500),
    (r"snorkel", "Snorkel", 250),
    (r"carplay|android auto|head ?unit", "CarPlay", 300),
    (r"brake controller|trailer brake", "Brake controller", 200),
    (r"cargo barrier", "Cargo barrier", 150),
]
FLAGS = [  # (regex, short label, severity 1-3)
    (r"ex[- ]?min(e|ing)|mine site|mine auction|minesite|ex[- ]?driller|driller", "Ex-mine", 3),
    (r"\bfleet\b", "Ex-fleet", 2),
    (r"needs? (a )?(new )?(engine|motor|gearbox)|blown|piston|seized|won'?t start|not running|engine knock", "Engine trouble", 3),
    (r"egr delete|dpf delete|dpf removed|delete kit|tuned?\b|remap", "Deleted / tuned", 2),
    (r"written off|wovr|repairable|statutory", "Written off", 3),
    (r"unregistered|no rego|unrego|deregistered", "No rego", 2),
    (r"\brust\b|rusty", "Rust", 2),
    (r"engine light|check engine|limp mode", "Warning light", 2),
    (r"\bparts\b|project|as is|mechanic special", "Project car", 3),
    (r"\bswap\b|swaps|trade for", "Swap ad", 1),
    (r"needs (new )?tyres|needs tires|needs work|needs tlc|minor repairs", "Needs work", 1),
]
GOOD = [(r"full service history|fsh\b|log ?books?|logbook|service history|toyota serviced", "Service history"),
        (r"one owner|1 owner|single owner", "One owner"),
        (r"timing belt (done|replaced|changed)|new timing belt|cambelt (done|replaced)", "Belt done"),
        (r"warranty", "Warranty")]
EXCLUDE = CFG.get("exclude") or r"$^"


def hav(a, b):
    r = 6371
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * r * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def km_from(text):
    t = text.lower().replace(",", "")
    m = re.search(r"(\d{2,3})(?:\.(\d))?\s?k\s?(?:kms?|kilometres|kilometers|klms?)?\b(?!g)", t)
    best = None
    for m in re.finditer(r"(\d{4,6})\s?(?:kms?|kilometres|kilometers|klms?|ks)\b", t):
        v = int(m.group(1))
        if 20000 <= v <= 700000:
            best = v
            break
    if best is None:
        for m in re.finditer(r"\b(\d{2,3})(?:\.\d)?\s?k\s?(?:kms?|klms?|kilometres|on the clock|\b)", t):
            v = int(m.group(1)) * 1000
            if 20000 <= v <= 700000:
                best = v
                break
    return best


def model_of(text):
    t = text.lower()
    for m in CFG["models"]:
        if re.search(m["match"], t):
            return m["name"]
    return None


def year_of(text):
    m = re.search(r"\b(200[5-9]|201\d|202[0-6])\b", text)
    return int(m.group(1)) if m else None


def norm_fb(x):
    if not x.get("listingTitle") and x.get("marketplace_listing_title"):   # search-results schema
        sub = " ".join(d.get("subtitle", "") for d in (x.get("custom_sub_titles_with_rendering_flags") or []))
        rg = ((x.get("location") or {}).get("reverse_geocode") or {})
        title = x.get("marketplace_listing_title") or ""
        km = None
        m = re.search(r"([\d.]+)\s*K\s*km", sub, re.I)
        if m:
            km = int(float(m.group(1)) * 1000)
        return dict(id="fb_" + str(x["id"]), src="fb", title=title.strip(), desc="", price=float((x.get("listing_price") or {}).get("amount") or 0),
                    lat=None, lng=None, suburb=rg.get("city") or "", img=((x.get("primary_listing_photo") or {}).get("photo_image_url")),
                    url=x.get("listingUrl"), seller="Private", gb="?", fuel=None, km=km, sold=x.get("is_sold"))
    title = x.get("listingTitle") or x.get("customTitle") or ""
    desc = (x.get("description") or {}).get("text") or ""
    loc = x.get("location") or {}
    photos = x.get("listingPhotos") or []
    img = ((photos[0] or {}).get("image") or {}).get("uri") if photos else None
    txt = f"{title}\n{desc}"
    gb = "Auto" if re.search(r"\bauto(matic)?\b", txt, re.I) else "Manual" if re.search(r"\bmanual\b|\b\d ?sp(eed)? man", txt, re.I) else "?"
    return dict(id="fb_" + str(x["id"]), src="fb", title=title.strip(), desc=desc.strip(), price=float((x.get("listingPrice") or {}).get("amount") or 0),
                lat=loc.get("latitude"), lng=loc.get("longitude"), suburb=((x.get("locationText") or {}).get("text") or "").replace(", WA", ""),
                img=img, url=x.get("itemUrl"), seller="Private", gb=gb, fuel=None, km=None, sold=x.get("isSold"))


GEO_CACHE = HERE / "geo_cache.json"


def geocode(city):
    cache = json.loads(GEO_CACHE.read_text()) if GEO_CACHE.exists() else {}
    if city in cache:
        return cache[city]
    import time
    time.sleep(1.1)
    r = requests.get("https://nominatim.openstreetmap.org/search", params={"q": f"{city}, Australia", "format": "json", "limit": 1},
                     headers={"User-Agent": "deal-radar-starter/1.0 (personal car search)"}, timeout=30).json()
    cache[city] = [float(r[0]["lat"]), float(r[0]["lon"])] if r else None
    GEO_CACHE.write_text(json.dumps(cache, indent=1))
    return cache[city]


def norm_gt(x):
    s = {d["name"]: d["value"] for d in (x.get("summaryInfo") or [])}
    loc = x.get("adLocationData") or {}
    imgs = x.get("images") or []
    odo = re.sub(r"[^\d]", "", s.get("Odometer", "")) or None
    st = s.get("Seller Type", "")
    return dict(id="gt_" + str(x["id"]), src="gt", title=(x.get("title") or "").strip(), desc=(x.get("description") or "").strip(),
                price=float((x.get("adPriceData") or {}).get("amount") or 0), lat=loc.get("latitude"), lng=loc.get("longitude"),
                suburb=loc.get("suburb") or "", img=(imgs[0].get("large") if imgs else None), url=x.get("shareLink"),
                seller="Dealer" if "dealer" in st.lower() else "Private", gb={"Automatic": "Auto", "Manual": "Manual"}.get(s.get("Transmission"), "?"),
                fuel=s.get("Fuel Type"), km=int(odo) if odo else None, sold=False)


def main():
    fb = json.load(open(RAW / "fb.json", encoding="utf-8"))
    gt = json.load(open(RAW / "gt.json", encoding="utf-8"))
    rows, seen = [], set()
    fbn = sorted((norm_fb(r) for r in fb), key=lambda r: r["desc"] == "")
    for x in fbn + [norm_gt(r) for r in gt]:
        if x["id"] in seen or x["sold"]:
            continue
        seen.add(x["id"])
        if x["lat"] is None and x["suburb"]:
            ll = geocode(x["suburb"])
            if ll:
                x["lat"], x["lng"] = ll
        txt = f"{x['title']}\n{x['desc']}"
        x["model"], x["year"] = model_of(txt), year_of(x["title"]) or year_of(x["desc"])
        if not x["model"] or not x["year"] or not x["price"] or not x["lat"] or not x["img"]:
            continue
        if re.search(EXCLUDE, txt, re.I):
            continue
        mc = next(m for m in CFG["models"] if m["name"] == x["model"])
        if not (mc.get("min_year", 1900) <= x["year"] <= mc.get("max_year", 2100)):
            continue
        if CFG.get("require_any") and not re.search(CFG["require_any"], txt, re.I):
            continue
        if x["km"] is None:
            x["km"] = km_from(txt)
        if not x["km"] or not (CFG["price_min"] * 0.5 <= x["price"] <= CFG["price_max"] * 1.2):
            continue
        if x["km"] < 40000 and x["year"] < 2021:      # "2K km" on a 2012: a typo, not a real odometer
            continue
        x["dist"] = round(hav(HOME, (x["lat"], x["lng"])))
        if x["dist"] > MAX_KM_AWAY:
            continue
        low = txt.lower()
        x["extras"] = [(lab, v) for rx, lab, v in EXTRAS if re.search(rx, low)]
        def hit(rx):
            for m in re.finditer(rx, low):
                pre, post = low[max(0, m.start() - 14):m.start()], low[m.end():m.end() + 8]
                if re.search(r"(no|zero|nil|without|free of|not)\W+(\w+\W+)?$", pre) or re.search(r"^\W*(free|-free)", post):
                    continue
                return True
            return False
        x["flags"] = [(lab, sev) for rx, lab, sev in FLAGS if hit(rx)]
        x["good"] = [lab for rx, lab in GOOD if re.search(rx, low)]
        rows.append(x)

    # fair price per model: price ~ year + km (fitted on clean rows only)
    for m in [mc["name"] for mc in CFG["models"]]:
        sub = [r for r in rows if r["model"] == m and not any(s >= 3 for _, s in r["flags"])]
        if len(sub) < 6:
            continue
        A = np.array([[1, r["year"], r["km"] / 10000] for r in sub])
        y = np.array([r["price"] for r in sub])
        coef, *_ = np.linalg.lstsq(A, y, rcond=None)
        for r in rows:
            if r["model"] == m:
                r["fair"] = int(round((coef[0] + coef[1] * r["year"] + coef[2] * r["km"] / 10000) / 100) * 100)
        print(f"{m}: fair price fitted on {len(sub)} listings. Each year newer adds about ${coef[1]:,.0f}, each extra 10,000 km costs about ${-coef[2]:,.0f}")
    rows = [r for r in rows if r.get("fair") and r["fair"] > 3000]

    for r in rows:
        r["extrasValue"] = min(sum(v for _, v in r["extras"]), 6000)
        r["delta"] = r["fair"] - r["price"]
        sev = sum(s for _, s in r["flags"])
        value = max(-1, min(1, r["delta"] / max(r["fair"], 1) / 0.2))      # +-20% of fair = full swing
        s = 6 + value * 2.2 + min(r["extrasValue"], 4000) / 4000 * 0.8 + 0.4 * len(r["good"]) - 0.9 * sev
        s -= max(0, (r["km"] - 250000) / 100000) * 0.8
        s -= 0.6 if r["gb"] == "Manual" else 0
        r["score"] = round(max(1, min(9.8, s)), 1)
        r["risk"] = "hi" if sev >= 3 else "md" if sev >= 1 or r["km"] > 300000 else "lo"

    rows.sort(key=lambda r: -r["score"])
    for r in rows:
        if r["price"] < 0.65 * r["fair"]:
            r["flags"].append(("Too cheap, ask why", 2))
            r["risk"] = "md"
    picks = [r for r in rows if r["risk"] == "lo" and r["delta"] > 0 and r["km"] < 320000][:8]
    for r in rows:
        r["pick"] = r in picks
        why = []
        if r["delta"] > 500:
            why.append(f"${r['delta']:,.0f} under market")
        if r["good"]:
            why.append(r["good"][0].lower())
        if r["extrasValue"] >= 1500:
            why.append(f"${r['extrasValue']:,} of extras")
        if r["dist"] <= 25:
            why.append(f"{r['dist']} km away")
        r["why"] = ", ".join(why[:3])

    THUMBS.mkdir(exist_ok=True)

    def grab(r):
        out = THUMBS / f"{r['id']}.jpg"
        if out.exists():
            return True
        try:
            import subprocess
            b = subprocess.run(["curl", "-s", "-L", "--max-time", "30", "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                                "-e", "https://www.gumtree.com.au/" if r["src"] == "gt" else "https://www.facebook.com/", r["img"]], capture_output=True).stdout
            im = Image.open(io.BytesIO(b)).convert("RGB")
            im.thumbnail((480, 480))
            im.save(out, "JPEG", quality=78, optimize=True)
            return True
        except Exception:
            return False

    with ThreadPoolExecutor(12) as ex:
        ok = list(ex.map(grab, rows))
    rows = [r for r, k in zip(rows, ok) if k]

    out = [dict(id=r["id"], src=r["src"], year=r["year"], model=r["model"], title=r["title"][:70], price=int(r["price"]), km=r["km"],
                fair=r["fair"], delta=r["delta"], dist=r["dist"], suburb=r["suburb"], gb=r["gb"], seller=r["seller"],
                extras=[e for e, _ in r["extras"]], extrasValue=r["extrasValue"], flags=[f for f, _ in r["flags"]], good=r["good"],
                score=r["score"], risk=r["risk"], pick=r["pick"], why=r["why"], url=r["url"]) for r in rows]
    meta = dict(title=CFG.get("title", "Deal Radar"), home=CFG["home"]["name"], radius=CFG["radius_km"],
                models=[m["name"] for m in CFG["models"]])
    js = ("// Generated by build_data.py. Re-run it after fetch_listings.py to refresh."+"\n"
          + "window.META = " + json.dumps(meta, ensure_ascii=False) + ";\n"
          + "window.CARS = " + json.dumps(out, ensure_ascii=False) + ";\n")
    (HERE / "data.js").write_text(js, encoding="utf-8")
    print(f"{len(out)} listings on your dashboard ({sum(r['src'] == 'fb' for r in out)} Facebook, {sum(r['src'] == 'gt' for r in out)} Gumtree), {sum(r['pick'] for r in out)} picks. Open index.html")


if __name__ == "__main__":
    main()
