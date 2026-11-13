---
name: decodo-scraper
description: Search Google, scrape web pages, Amazon product pages, YouTube subtitles, or Reddit (post/subreddit) using the Decodo Scraper OpenClaw Skill.
homepage: https://decodo.com
credentials:
  - DECODO_AUTH_TOKEN
env:
  required:
    - DECODO_AUTH_TOKEN
---

# Decodo Scraper OpenClaw Skill

Use this skill to search Google, scrape any URL, or fetch YouTube subtitles via the [Decodo Web Scraping API](https://help.decodo.com/docs/web-scraping-api-google-search). **Search** outputs a JSON object of result sections; **Scrape URL** outputs plain markdown; **Amazon** and **Amazon search** output parsed product-page or search results (JSON). Amazon search uses `--query`. **YouTube subtitles** outputs transcript/subtitles. **Reddit post** and **Reddit subreddit** output post/listing content (JSON).

**Authentication:** Set `DECODO_AUTH_TOKEN` (Basic auth token from Decodo Dashboard → Scraping APIs) in your environment or in a `.env` file in the repo root.

**Errors:** Every failure carries a stable, machine-readable `error_category` (single-task mode writes `{"error", "error_category", "details"?}` JSON to stderr and exits 1; batch mode embeds it per item). Categories:

| `error_category`          | Meaning                                                                     |
|---------------------------|-----------------------------------------------------------------------------|
| `missing_credentials`     | `DECODO_AUTH_TOKEN` is not set                                              |
| `invalid_parameters`      | Unknown target, missing/mismatched `query`/`url`, `geo`/`locale` on a non-`google_search` target, malformed batch JSON |
| `request_failed`          | Transport error or HTTP status outside 2xx (`details.status_code` when known) |
| `invalid_response`        | Response body is not valid JSON                                             |
| `response_structure_error`| JSON parsed but `results[0].content` or an expected inner field is missing  |

All parameter and credential checks run **before any network request**, so invalid combinations never hit the API.

---

## Batch entry point

For automation, submit an ordered list of tasks with `--batch-file PATH` (use `-` for stdin). Input is a JSON array of task objects, or an object with a `tasks` array. Each task contains `target` plus the `query` or `url` that target requires; `geo`/`locale` are optional and only apply to `google_search`.

One task failing never aborts the others. The command prints one summary JSON — each item shows its original `index`, `target`, `status` (`success`/`failed`), and either the actual scrape `result` or `error` + `error_category`; the document also reports `total`, `succeeded`, and `failed`. Exit code is `0` only when all tasks succeed, and `1` if any task failed (or input/credentials were invalid).

```bash
cat tasks.json | python3 tools/scrape.py --batch-file -
```
```json
[
  {"target": "google_search", "query": "best laptops 2025", "geo": "US"},
  {"target": "universal", "url": "https://example.com"},
  {"target": "amazon_search", "query": "laptop"}
]
```

---

## Tools

### 1. Search Google

Use this to find URLs, answers, or structured search results. The API returns a JSON object whose `results` key contains several sections (not all may be present for every query):

| Section | Description |
|--------|--------------|
| `organic` | Main search results (titles, links, snippets). |
| `ai_overviews` | AI-generated overviews or summaries when Google shows them. |
| `paid` | Paid/sponsored results (ads). |
| `related_questions` | “People also ask”–style questions and answers. |
| `related_searches` | Suggested related search queries. |
| `discussions_and_forums` | Forum or discussion results (e.g. Reddit, Stack Exchange). |

The script outputs only the inner `results` object (these sections); pagination info (`page`, `last_visible_page`, `parse_status_code`) is not included.

**Command:**
```bash
python3 tools/scrape.py --target google_search --query "your search query"
```

**Examples:**
```bash
python3 tools/scrape.py --target google_search --query "best laptops 2025"
python3 tools/scrape.py --target google_search --query "python requests tutorial"
```

Optional: `--geo US` or `--locale en` for location/language.

---

### 2. Scrape URL

Use this to get the content of a specific web page. By default the API returns content as **Markdown** (cleaner for LLMs and lower token usage).

**Command:**
```bash
python3 tools/scrape.py --target universal --url "https://example.com"
```

**Examples:**
```bash
python3 tools/scrape.py --target universal --url "https://example.com"
python3 tools/scrape.py --target universal --url "https://news.ycombinator.com/"
```

---

### 3. Amazon product page

Use this to get parsed data from an Amazon product (or other Amazon) page. Pass the product page URL as `--url`. The script sends `parse: true` and outputs the inner **results** object (e.g. `ads`, product details, etc.).

**Command:**
```bash
python3 tools/scrape.py --target amazon --url "https://www.amazon.com/dp/PRODUCT_ID"
```

**Examples:**
```bash
python3 tools/scrape.py --target amazon --url "https://www.amazon.com/dp/B09H74FXNW"
```

---

### 4. Amazon search

Use this to search Amazon and get parsed results (search results list, delivery_postcode, etc.). Pass the search query as `--query`.

**Command:**
```bash
python3 tools/scrape.py --target amazon_search --query "your search query"
```

**Examples:**
```bash
python3 tools/scrape.py --target amazon_search --query "laptop"
```

---

### 5. YouTube subtitles

Use this to get subtitles/transcript for a YouTube video. Pass the **video ID** (e.g. from `youtube.com/watch?v=VIDEO_ID`) as `--query`.

**Command:**
```bash
python3 tools/scrape.py --target youtube_subtitles --query "VIDEO_ID"
```

**Examples:**
```bash
python3 tools/scrape.py --target youtube_subtitles --query "dFu9aKJoqGg"
```

---

### 6. Reddit post

Use this to get the content of a Reddit post (thread). Pass the full post URL as `--url`.

**Command:**
```bash
python3 tools/scrape.py --target reddit_post --url "https://www.reddit.com/r/SUBREDDIT/comments/ID/..."
```

**Examples:**
```bash
python3 tools/scrape.py --target reddit_post --url "https://www.reddit.com/r/nba/comments/17jrqc5/serious_next_day_thread_postgame_discussion/"
```

---

### 7. Reddit subreddit

Use this to get the listing (posts) of a Reddit subreddit. Pass the subreddit URL as `--url`.

**Command:**
```bash
python3 tools/scrape.py --target reddit_subreddit --url "https://www.reddit.com/r/SUBREDDIT/"
```

**Examples:**
```bash
python3 tools/scrape.py --target reddit_subreddit --url "https://www.reddit.com/r/nba/"
```

---

## Summary

| Action             | Target               | Argument   | Example command |
|--------------------|----------------------|------------|-----------------|
| Search             | `google_search`      | `--query`  | `python3 tools/scrape.py --target google_search --query "laptop"` |
| Scrape page        | `universal`          | `--url`    | `python3 tools/scrape.py --target universal --url "https://example.com"` |
| Amazon product     | `amazon`             | `--url`    | `python3 tools/scrape.py --target amazon --url "https://www.amazon.com/dp/B09H74FXNW"` |
| Amazon search      | `amazon_search`     | `--query`  | `python3 tools/scrape.py --target amazon_search --query "laptop"` |
| YouTube subtitles  | `youtube_subtitles`  | `--query`  | `python3 tools/scrape.py --target youtube_subtitles --query "dFu9aKJoqGg"` |
| Reddit post        | `reddit_post`        | `--url`    | `python3 tools/scrape.py --target reddit_post --url "https://www.reddit.com/r/nba/comments/17jrqc5/..."` |
| Reddit subreddit   | `reddit_subreddit`   | `--url`    | `python3 tools/scrape.py --target reddit_subreddit --url "https://www.reddit.com/r/nba/"` |

**Output:** Search → JSON (sections). Scrape URL → markdown. Amazon / Amazon search → JSON (results e.g. ads, product info, delivery_postcode). YouTube → transcript. Reddit → JSON (content).
