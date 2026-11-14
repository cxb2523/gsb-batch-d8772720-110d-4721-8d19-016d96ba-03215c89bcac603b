# Prism Roadmap

Prism turns raw social content into structured, comparable insight. Here's where it's headed —
contributions on any of these are welcome.

## Shipped

- ✅ Universal 5-table schema (`entities` / `items` / `metrics` / `texts` / `features`)
- ✅ **Four platform adapters** — Xiaohongshu · Bilibili · Douyin · Kuaishou. All of them feed
  the same schema, and **the analysis layer runs across them unchanged**: the very same
  `collect_rate_ranking` works as-is on every platform. Plus platform-specific extras where they
  exist (Bilibili coin-rate / danmaku).
- ✅ Collect-rate (`saves / likes`) as the core content-value signal
- ✅ 4 analysis lenses: `quant` / `sentiment` / `timeseries` / `forecast`
- ✅ One-line API: `prism.analyze(...)` — fetch → store → analyze in a single call
- ✅ `prism demo` CLI — a full insight report from bundled offline data, in seconds
- ✅ Compliance baseline — salted-hash anonymization + rate limiting
- ✅ macOS Chrome cookie auto-read (convenience layer; a plain `cookies.json` works too)

## Next

- 🔜 **`pip install prism-insights`** on PyPI
- 🔜 **Export**: CSV / JSON / Markdown reports out of the box
- 🔜 **Peak detection** in the time-series lens — spot content breaking out early
- 🔜 Test coverage to 80%+ on `store` / `compliance` / `analysis`, with a coverage badge

## Help wanted

**New platform adapters are the highest-leverage contribution** — each one unlocks the entire
analysis stack for free. Weibo, Zhihu and Xiaoyuzhou are all good candidates. Start from
`framework/adapters/bilibili.py` (the simplest one — zero login, zero signing) as your
reference, and see [CONTRIBUTING.md](./CONTRIBUTING.md).

> **Scope note.** Prism deliberately does **not** implement, ship or vendor anti-bot signature
> bypasses. Adapters target publicly reachable endpoints only. If a platform requires
> circumventing its protection mechanisms to reach the data, that is explicitly out of scope —
> please don't send a PR for it.
