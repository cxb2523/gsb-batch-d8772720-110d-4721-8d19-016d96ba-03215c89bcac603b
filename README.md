# 🍜 NoodleScraper

**NoodleScraper** provides Noodlemagazine's video scraper with web interface, video player, sources, previews and custom scraper API if interface not needed.

![Python](https://img.shields.io/badge/Python-3.10+-blue?style=flat-square&logo=python)
![FastAPI](https://img.shields.io/badge/FastAPI-green?style=flat-square&logo=fastapi)
![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)

## ✨ Features

- 🌐 Web interface for browsing and searching videos
- 📺 Integrated video player with direct-link quality selection
- 🖼️ Video preview thumbnails
- 🔌 JSON API for programmatic access
- ⚡ Truly async: `curl-cffi` with Chrome TLS impersonation (`impersonate="chrome"` always tracks the latest Chrome the library supports — no User-Agent scraping)
- 💸 Cheap on the upstream: a search costs **one** request, opening a video costs **two**
- 🔗 Shareable video links — `/video/{id}` renders server-side, no browser-side data passing

## 🚀 Installation

```bash
git clone https://github.com/catochin/noodlescraper
cd noodlescraper
pip install -r requirements.txt
python run.py
```

## 🔧 Usage

After installation, the web interface will be available at:
```
http://127.0.0.1:6969
```

## 🏗️ Architecture

The project consists of two main components:

### 🧠 `noodle.py`

Async scraper built on `curl_cffi.requests.AsyncSession`:

- 🕸️ One request per search page — results are parsed straight from the listing in source-site order
- 🎬 Two requests per video page load (`/watch/{id}` → player page) — the `window.playlist` object with direct `.mp4` links is pulled on demand, with the `Referer` header the player page requires
- 🧼 Robust playlist extraction via `JSONDecoder.raw_decode` (tolerates trailing JS)
- 🩺 Per-result enrichment outcomes (`sources_status` / `sources_error`) — a failed video keeps its listing data instead of silently looking link-less

### 🖥️ `app.py`

FastAPI web interface that:

- 👤 Renders the frontend (server-side video pages)
- 🔗 Exposes the scraper via JSON API endpoints

## 🔌 API Endpoints

### 🔍 Search Videos
```
GET /api/search?q={query}&page={page}
```
Returns listing data for the given query (`id`, `title`, `image`, `duration` in seconds plus `duration_text`), in source-site order — one upstream request.

Opt-in enrichment for mass grabbers:
```
GET /api/search?q={query}&page={page}&with_sources=1
```
Merges `sources` (sorted high→low), `tags`, `player_url` and a precise `duration` into every result. At most two upstream requests per video, fetched with bounded concurrency — use deliberately.

Every result carries an outcome so a partially failed page never needs a full rerun:

- `sources_status: "ok"` — links, tags and duration were merged; `sources_error` is `null`.
- `sources_status: "failed"` — the listing fields (`id`, `title`, `image`, `duration`, `duration_text`) are untouched and `sources_error` gives a readable reason (`video page could not be loaded`, `player URL is missing from the video page`, `player page could not be loaded`, `playlist could not be parsed`).

Failed entries never drop results, never reorder the page (order always matches the source site) and never turn the request into an error. Without `with_sources` the endpoint stays a single listing request, and results carry no enrichment fields at all.

### 📹 Get Video Details
```
GET /api/video/{video_id}
```
Returns title, tags, duration, player URL and sorted direct links (highest quality first).

### 💚 Health Check
```
GET /health
```
Returns application health status.

## 📋 Requirements

- Python 3.10+
- FastAPI + Uvicorn (async web framework and ASGI server)
- curl-cffi (Chrome-impersonating HTTP client)
- selectolax (fast C-based HTML parsing)
- Jinja2 (templating)

## 🧪 Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Tests never touch the network: listing, video and player pages are built as local HTML, so the success / partial-failure / total-failure paths of `with_sources=1` are covered deterministically, along with the fact that plain searches issue no video-page requests at all.

## ⚖️ License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<p align="center">
Made with ❤️ for video content enthusiasts
</p>
