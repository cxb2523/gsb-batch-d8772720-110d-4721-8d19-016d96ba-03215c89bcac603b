# Prism

<p align="center">
  <img src="docs/assets/social-preview.png" alt="Prism — the analysis layer for social content. Ranks by save-rate, not likes." width="840">
</p>


> **One content stream in, multidimensional insights out.**

![Python](https://img.shields.io/badge/python-3.10%2B-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/millennialdreamer/prism/actions/workflows/ci.yml/badge.svg)](https://github.com/millennialdreamer/prism/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-25%20passing-brightgreen)

**Prism** is a platform-agnostic framework for **social-content research**. Point it at a
platform and it turns raw posts into structured, comparable insight — engagement quant,
sentiment, time-series, and virality forecasts — all on one unified schema.

**Four adapters ship today: Xiaohongshu (RED), Bilibili, Douyin, and Kuaishou.** Adding a
platform means writing *one adapter*, not a new tool — and it's proven: the same
`collect_rate_ranking` analysis runs across all of them unchanged.

### Where Prism fits

Open source already has excellent **scrapers**. What's missing is the layer *above* them —
turning raw pulls into structured, comparable, exportable insight. Prism is that analysis layer.

- **Built for** technical operators, indie developers and small data teams who want to *own*
  their data, not rent a black-box dashboard.
- **Bring your own data.** Prism speaks a universal 5-table schema — use the built-in adapters,
  a [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) export, or any source you like
  ([see below](#bring-your-own-data)).
- **Why not a SaaS tool?** Listening suites are closed, siloed per platform and priced for
  brands. Prism is open, cross-platform under *one* schema, and fully self-hostable.

> 🇨🇳 中文文档见 [README_zh.md](./README_zh.md)

---

## Why Prism?

A crawler hands you 100k posts. Prism tells you **which 3 kinds are worth your time**.

|                                              | MediaCrawler | Scrapy | **Prism** |
| -------------------------------------------- | :----------: | :----: | :-------: |
| Scrapes content                              |      ✓       |  DIY   |     ✓     |
| Unified cross-platform schema                |      ✗       |   ✗    |   **✓**   |
| Built-in analysis (quant/sentiment/forecast) |      ✗       |   ✗    |   **✓**   |
| Compliance (anonymize + rate-limit) default  |      ✗       |   ✗    |   **✓**   |

## The collect-rate signal

On Xiaohongshu, **a save is worth more than a like** — a like means *"nice"*, a save means
*"I'll come back to this"*. So Prism ranks content by **collect-rate** (`collect / like`),
not likes.

For example, a note with **1,500 saves on 1,000 likes → collect-rate 1.5** (illustrative). More
people *saved* it than *liked* it — exactly the high re-reference value worth modeling.

## Quickstart

```bash
git clone https://github.com/millennialdreamer/prism.git
cd prism
pip install -e ".[forecast]"
prism demo                                     # analysis lenses on bundled anonymized data — instant
```

Which prints, in about a second:

<p align="center">
  <img src="docs/assets/demo.svg" alt="Terminal recording of prism demo: a collect-rate ranking where every top result is a guide, followed by content-type, distribution and concentration breakdowns." width="782">
</p>

<details>
<summary>Same output as copyable text</summary>

```
① Collect-rate ranking (save/like — Prism's core signal):
    2.38  save   1520 / like    640   Every visa document I needed, in order
    1.82  save   1655 / like    910   Reading a rental contract line by line
    1.82  save   1490 / like    820   How to pick a rice cooker without overpaying
     1.6  save   1980 / like   1240   12 museums in the city that are free on Sunda…
    1.24  save   2610 / like   2100   Beginner sourdough: the whole schedule on one…

② By content type (avg saves):
   image    n=9    avg_save=1748
   video    n=11   avg_save=693

③ Save distribution: n=20 median=940 p90=1980 max=2610
④ Save concentration: HHI=657 top3-share=0.284
```

</details>

Every post at the top of that ranking is a *guide*. Sort the same rows by likes instead and
you get cat photos and sunsets — different list, different conclusions. That gap is the
reason Prism ranks the way it does.

Or the **one-call API** on a live platform:

```python
import prism
ins = prism.analyze("bilibili", limit=15)     # zero-login; or analyze("xhs", chrome_profile="Default")
ins.collect_rate_ranking(top=5)               # ranked by save-rate — the core signal
```

> `pip install prism-insights` — coming to PyPI.

## Bring your own data

The adapters are one way to fill the schema, not the only one. If you already have
rows — a MediaCrawler export, a CSV from a colleague, your own scraper's output —
import them and the entire analysis layer works on them unchanged:

```python
from framework.store import Store
from framework.importers import import_csv

store = Store("research.db")
import_csv(store, "xhs_notes.csv", platform="xhs", preset="mediacrawler_xhs")
# {'items': 1204, 'metrics': 4816, 'texts': 1180, 'entities': 87, 'skipped': 0}
```

Presets ship for MediaCrawler's Xiaohongshu and Bilibili exports. For anything else,
describe your columns once:

```python
from framework.importers import import_rows, FieldMap

import_rows(store, rows, platform="my_platform", mapping=FieldMap(
    item_id="post_id", title="headline", author_id="user",
    metrics={"like_count": "likes", "collect_count": "saves"}))
```

Author IDs are salt-hashed on the way in, the same as the adapters do it — importing
isn't a side door around the anonymization.

## Architecture

```
 data source  ──adapter──▶  unified 5 tables   ──analysis──▶  insight
 (XHS, …)      (translate)   entities · items     (4 lenses)
                             metrics · texts · features
```

- **5 universal tables** — `entities` / `items` / `metrics` (EAV long table, time-series
  ready) / `texts` / `features`. Cross-platform comparable.
- **Adapter abstraction** — a pure-function parse layer + a fetch layer. New platform = one
  adapter; the analysis layer is reused untouched.
- **4 analysis lenses** — `quant` (concentration / distribution), `sentiment`, `timeseries`
  (trend / inflection), `forecast` (Szabo-Huberman early→final regression).
- **Compliance baseline** — `scrub_user` salt-hashes user IDs and drops PII before storage;
  `RateLimiter` throttles requests to avoid bans.

## Cookies (two ways)

- **macOS auto-read** (zero manual steps): `XHSAdapter(chrome_profile="Default")` reads and
  decrypts cookies straight from your Chrome profile. Needs `pip install -e ".[cookies]"`.
- **Portable**: drop a `cookies.json` (works anywhere / CI). See [README_zh](./README_zh.md).

## Compliance

For **research and personal analysis only**. User objects are anonymized before storage and
rate-limiting is on by default. See [DISCLAIMER.md](./DISCLAIMER.md) and
[SECURITY.md](./SECURITY.md). Scraping that violates a platform's Terms of Service is the
user's responsibility.

## Contributing

**New platform adapters are especially welcome** — the whole point of Prism is that one
adapter unlocks the full analysis stack. See [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE)
