---
name: prism
description: Platform-agnostic content research framework — fetch Xiaohongshu / Bilibili content, store to the universal 5-table schema, compute collect-rate rankings, distributions, concentration, and viral post prediction. Use when the user wants to "research a content niche / competitors / topics", "analyze Xiaohongshu or Bilibili data", "find patterns in viral posts", "collect-rate analysis", or "compare creators / UP hosts".
user-invocable: true
argument-hint: <platform (xhs/bilibili) / research topic / creator>
allowed-tools: Bash, Read, Write, Edit
---

# Prism · Content Research Framework

A platform-agnostic content research framework. The project lives at `~/projects/prism` (installed with `pip install -e .`; the `prism` command is available).
Core signal = **collect-rate** (saves ÷ likes): a like means "nice", a save means "I'll come back to this" (recipe and tutorial posts routinely get more saves than likes).

## Quickstart (30 seconds)

```bash
cd ~/projects/prism
prism demo                            # offline anonymized data; instant four-lens analysis (collect-rate / image vs video / distribution / concentration)
prism analyze bilibili --limit 15     # Bilibili — no login required, fetches and analyzes live
prism analyze xhs --profile Default   # Xiaohongshu — reads Chrome cookies from the local profile automatically, no manual export
```

## One-liner API (embed in your own scripts)

```python
import prism
ins = prism.analyze("bilibili", limit=15)      # Bilibili, no login; or analyze("xhs", chrome_profile="Default")
ins.collect_rate_ranking(top=5)                # collect-rate ranking (primary signal)
ins.note_type_compare()                        # image posts vs videos
ins.distribution("collect_count")             # percentile distribution
ins.concentration("view_count")               # concentration HHI + head / mid / tail segmentation
```

## Architecture (adding a platform means writing one adapter)

- **Universal 5-table schema**: entities (creators) / items (posts · videos) / metrics (long table, supports time series) / texts (comments) / features (AI analysis)
- **Adapter abstraction**: platform data → 5-table contracts; pure-function parse layer + fetch layer. Add a platform: see `framework/adapters/` + `CONTRIBUTING.md`
- **Four analysis lenses**: quant (quantitative · concentration) / sentiment (uses a local LLM) / timeseries / forecast (viral post prediction)
- **Compliance base**: `compliance.scrub_user` anonymizes automatically (salted-hash IDs + sensitive field removal) + `RateLimiter` throttles to prevent bans

## Platform status

| Platform | Login | Primary signal | Notes |
|----------|-------|---------------|-------|
| Xiaohongshu xhs | Requires Chrome login (e.g. Default profile; cookies read automatically) | collect-rate (saves ÷ likes) | Feed list only exposes likes; save count requires the detail page |
| Bilibili | **No login, no signature** — public API | collect-rate + **coin rate** (unique to Bilibili) + danmaku | Easiest to start with |
| Douyin | **No login** (app-side guest feed endpoint) | likes / comments / saves / shares | Search not supported (soft-walled for guests); uses feed pagination + keyword filtering |
| Kuaishou | **No login** | likes / comments / views | Supports targeted fetch by video ID |

## Compliance (automatic, but worth knowing)

- Anonymization: user IDs are hashed and sensitive fields (phone, IP, display name, etc.) are dropped before storage
- Rate limiting: low request rate + daily cap; raises `RateLimitError` on breach
- **For learning and research use only** — see `DISCLAIMER.md`

## Configuration (when a platform changes its layout)

All field mappings live in `framework/config/{xhs,bilibili,douyin,kuaishou}_selectors.yml` — update the YAML, no code changes needed.

See `~/projects/prism/README.md` (English) / `README_zh.md` (Chinese).
