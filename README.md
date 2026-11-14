# MovieMod Scraper

A Python crawler and metadata extraction pipeline for dynamic media catalogs. It pairs Selenium with a multiprocessing worker pool, verifies ephemeral link liveness before caching, and writes structured records into MySQL with optional Telegram job alerts.

![Interactive single-title run: search, pick season and resolution, get the final link](docs/cli-demo.png)

--- 

Demo recording (4x playback speed). The video runs in headed mode for demonstration; production runs execute headlessly.

https://github.com/user-attachments/assets/8ab58885-8724-4059-9793-96fea4f3d916

---

## System capabilities

- Multiprocess page crawler: Splits pagination ranges across worker processes, launching dedicated headless Chrome sessions with isolated memory profiles.
- Dynamic domain resolution: Resolves active catalog mirrors at runtime through `getCurrentDomain.py` to handle upstream domain shifts.
- Interactive terminal selector: Provides an arrow-key CLI menu to look up titles, select specific seasons, and filter target resolutions before fetching.
- Relational storage: Normalizes titles, metadata, seasons, and parsed media links in MySQL.
- Status notifications: Sends job milestone summaries and execution error alerts to Telegram.
- Liveness validation: Tests stored asset links on demand, purging broken records and re-fetching fresh access tokens.
- Containerized execution: Runs through Docker Compose with a pinned 2GB shared memory setting for headless Chrome stability.

---

## Ephemeral token handling

Media endpoints use session-based access tokens that expire after several hours. The pipeline handles this through temporal caching and validation:

- Stored database rows act as temporal snapshots rather than permanent mirrors.
- Before serving cached entries, `linkcheck.py` validates HTTP status codes against the target host.
- When stored URLs fail health checks, the worker purges the expired records and triggers a fresh extraction pass.

---

## Project structure

```plaintext
moviemod-scraper/
├── src/
│   ├── helpers.py      # resolution and season parsing (pure functions)
│   ├── db.py           # MySQL connection and insert/fetch helpers
│   ├── notify.py       # Telegram notifications
│   ├── introspect.py   # detail-page parsing: qualities, sizes, seasons
│   ├── interactive.py  # search resolver and arrow-menu prompts
│   └── linkcheck.py    # stored-link liveness validation
├── tests/
│   ├── test_helpers.py
│   ├── test_introspect.py
│   ├── test_linkcheck.py
│   └── test_interactive.py
├── docs/
│   └── cli-demo.png
├── moviescraper.py  # scraping orchestration (Selenium + multiprocessing)
├── getCurrentDomain.py
├── init.sql         # table schema (database itself comes from MYSQL_DATABASE / DB_NAME)
├── pyproject.toml
├── Dockerfile
└── docker-compose.yaml
```

---

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) for dependency management
- MySQL Server 8.0+ or Docker
- Google Chrome browser (the driver is managed automatically at runtime by Selenium Manager)

---

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/barryallen16/moviemod-scraper.git
   cd moviemod-scraper
   ```

2. Install dependencies:
   ```bash
   uv sync
   ```

3. Configure environment variables:
   Copy `.env.example` to `.env` and fill in values:
   ```bash
   cp .env.example .env
   ```
   Required keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `NUM_PROCESSES`, `START_PAGE`, `END_PAGE`, `website_type` (`hollywood` or `bollywood`).
   Under Docker Compose, set `DB_HOST=db` so the scraper connects to the containerized database.

4. Initialize the database:
   Tables are created automatically from [`init.sql`](init.sql). With Docker Compose, the database itself initializes from `DB_NAME`.

5. Run the crawler:
   ```bash
   uv run moviescraper.py
   ```

6. Run the test suite:
   ```bash
   uv run pytest -q
   uv run ruff check src/ tests/ moviescraper.py
   ```

---

## CLI usage

The CLI operates in two modes. Running with no arguments in an interactive terminal opens an arrow-key menu. Running in headless environments (such as Docker Compose) defaults to batch page scraping.

| Command | Action |
|---|---|
| `moviescraper.py` | Interactive menu: batch scrape or search a single title |
| `moviescraper.py pages --start 1 --end 5 -p 2` | Scrape a specific page range using 2 parallel processes |
| `moviescraper.py search "last of us"` | Interactive title selection: choose season, scope, and resolution |
| `moviescraper.py search "last of us" --pick 0 --season 1 --resolution 720px264` | Headless execution without interactive menus |

Single-title flags:

| Flag | Values | Description |
|---|---|---|
| `--pick N` | Result index integer | Selects title from search results directly |
| `--season N` | e.g. `1` | Selects season for series |
| `--resolution R` | `480p`, `720p`, `1080p`, `720px264`, `1080px264` | Targets specific output quality |
| `--scope S` | `all`, `episodes`, `specific`, `zip` | Defines batch scope: all, single episodes, or archive packages |
| `--episodes R` | e.g. `1-3,5` | Specifies episode numbers when scope is set to specific |
| `--refresh` | flag | Forces a fresh crawl even when usable cached links exist |
| `-v`, `--verbose` | flag | Enables detailed debug logging for each scraping step |

Single-title movie lookups skip season menus and proceed directly to resolution selection. Only the chosen variant is requested through the browser. Results are committed to MySQL and Telegram, and the resolved links are printed to stdout.

Stored links are validated before serving: each stored URL is checked for active HTTP responses. Dead links are pruned, and requests only reuse stored records matching the requested season, resolution, and scope; otherwise, a fresh extraction is executed.

Every interactive menu includes a `Quit` row (or press `q`). Entering `q` + Enter during a run stops processing gracefully after the active item finishes.

For interactive menus inside Docker, run with an attached TTY:
```bash
docker compose run --rm scraper .venv/bin/python moviescraper.py search "last of us"
```

---

## Run with Docker Compose

```bash
docker compose up --build
```

- `db` runs MySQL 8.0 with `init.sql` applied on first initialization; credentials match `.env`.
- `scraper` waits for `db` health checks to pass, runs `moviescraper.py`, and exits.
- `shm_size: 2gb` is configured for headless Chrome memory stability.

---

## Cloud setup notes

```bash
apt-get update \
&& apt-get install -y wget \
&& wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
&& apt-get install -y -f ./google-chrome-stable_current_amd64.deb \
&& google-chrome --version
```

Selenium Manager (bundled with `selenium>=4.6`) manages matching drivers at runtime. Avoid installing standalone ChromeDriver packages manually, as version drift against Chrome updates triggers `SessionNotCreatedException`.

---

## License

This project is licensed under the **GNU General Public License v3.0**. See the [LICENSE](LICENSE) file for details.
