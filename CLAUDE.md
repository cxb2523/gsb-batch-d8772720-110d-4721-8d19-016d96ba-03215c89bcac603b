# Deal Radar: instructions for Claude

You're helping someone who is NOT a programmer buy something second-hand without getting ripped off. They will talk to
you in plain English. You do the technical work, explain what you did in one or two plain sentences, and always ask
before spending money.

## What this project does

1. `fetch_listings.py` pulls listings from Facebook Marketplace and Gumtree using two Apify scrapers (paid per listing,
   usually covered by Apify's free US$5 a month). It reads `config.json` and writes `raw/fb.json` + `raw/gt.json`.
2. `build_data.py` turns those into `data.js`: fair market price per model (fitted on the listings themselves: price vs
   year + km), distance from home, value of aftermarket accessories, red flags, a score out of 10, and the top 8 picks.
3. `index.html` is the dashboard. Open it in a browser. No server needed.

## First conversation: set up their hunt

Ask, one at a time, only for what's missing:
- What they're buying (make + model, or 2-3 models). Year range. Budget (min and max).
- Their suburb (for distance). Look up its latitude and longitude yourself.
- How far they'd drive (radius in km).
- Must-haves and deal-breakers (e.g. "auto only", "diesel only", "no 2WD"). Turn deal-breakers into the `exclude` regex
  and must-haves into `require_any`.

Then edit `config.json`:
- `models`: one entry per model, with a lower-case regex in `match` (e.g. "prado", "hilux|hi-lux") and the year range.
- `facebook.city_slug`: the city name as it appears in a Facebook Marketplace URL, e.g. perth, melbourne, sydney,
  brisbane, adelaide, gold-coast. If unsure, ask them to open Marketplace in a browser and copy the URL.
- `facebook.queries`: what they'd type into Marketplace search, one per model.
- `gumtree`: `location_id` is Gumtree's region id (3008303 = Perth). For other cities, look it up from a Gumtree
  search URL, or set `"enabled": false` to skip Gumtree.
- Keep `budget_usd` at 4 unless they say otherwise.

## Spending money: the rules

- **Always tell them the worst-case cost before `fetch_listings.py` runs** (the script prints it) and wait for a yes.
- Never raise `budget_usd`, `results_per_query` or `max_items` without asking.
- Never remove the spend cap (`maxTotalChargeUsd`) from `fetch_listings.py`.
- Never ask for or use their Facebook login, cookies or password. The scraper reads public listings and doesn't need one.
- Never put their Apify token in any file except `.env`, and never print it.

## After building

Open `index.html` for them (or tell them to double-click it). Then walk them through the dashboard:
- Each card: price, the green-to-red bar (where the price sits against the market, white tick = market price),
  km from home, accessories value, red flags.
- The orange cards are the picks. Click any card to open it and see the accessories, the good signs and the red flags.

Offer to:
- Write a pre-purchase inspection checklist for their exact model: known failures, what receipts to ask for, what to
  check on a cold start, the $2 PPSR check (Australia) or the local equivalent.
- Draft a polite message to a seller asking the 3 questions that matter for that listing.
- Re-run the whole thing next week to catch new listings.

## Something other than a car?

It works for anything second-hand. Help them adapt it:
- `models` becomes the items (e.g. "sony a7 iii", "trek fuel ex", "quintrex 420").
- In `build_data.py`, swap the `EXTRAS` list (car accessories) for that item's add-ons (lenses, upgraded forks, outboard
  motor) and adjust the `FLAGS` list. Replace "km" with the item's wear measure (shutter count, hours, nothing) or drop it.
- Check the Gumtree `category_id` matches (18320 is cars). Or switch Gumtree off.

## Style

Plain English, short answers, no jargon. When something errors, read it, fix it, and tell them in one sentence what was
wrong. Don't make them paste code.
