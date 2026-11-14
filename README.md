## Web-Scraper & Visualizer

A powerful full-stack application that scrapes hotel data from Booking.com and visualizes it as an interactive force-directed graph.

##  Features
- **Automated Scraping**: Uses Playwright to scrape real-time hotel data (prices, ratings, locations).
- **Page-Level Records**: Every scraped page is recorded with page number, new/cumulative record counts, and an end reason (`continue` / `target_reached` / `no_cards` / `no_next_button` / `pagination_error`). Failed pages carry a short error detail.
- **Real Progress**: `/status` exposes real progress (pages completed, total records vs. target, per-page outcomes); the frontend progress bar is driven by `total_records / target`, not simulated increments.
- **Failed-Page Retry**: `POST /retry-failed` re-scrapes only the pages marked as failed in the last run. Successful data is preserved and merged without duplicates; if there are no failed pages, the endpoint reports `no_failed_pages` instead of starting an empty run.
- **Interactive Visualization**: D3.js force-directed graph to explore hotel relationships.
- **Data Processing**: Automatic cleaning and formatting of scraped data using Pandas.
- **Professional UI**: Modern dark-themed interface with neon accents and guided workflows.

##  Offline Verification (No Real Network)
Page-level records and the retry flow can be verified with locally generated sample pages:
```bash
python tests/test_offline.py
```
The test builds sample HTML pages (cards, next-page buttons, an empty page) in a temp directory and runs the real scraper loop against them via `file://` URLs, covering: per-page records, `no_cards` / `no_next_button` / `target_reached` end reasons, and failed-page retry with merge (no clearing, no duplicates).

##  Tech Stack
- **Backend**: Python, Flask
- **Scraping**: Playwright (Async)
- **Data**: Pandas
- **Frontend**: HTML5, CSS3 (Bootstrap 5), D3.js v7

##  Deployment Guide

### Option 1: Vercel (Frontend & UI Only)
**Note:** Vercel has a strict 50MB size limit for serverless functions. **Playwright browsers (Chromium) exceed this limit.**
- If you deploy to Vercel, the **UI and Visualization will work**, but the **Scraping feature will likely fail** unless you connect to an external browser service (like Browserless.io).

**Steps:**
1. Push this code to a GitHub repository.
2. Go to [Vercel.com](https://vercel.com) and "Add New Project".
3. Import your GitHub repository.
4. Vercel will automatically detect the `vercel.json` and `requirements.txt`.
5. Click **Deploy**.

### Option 2: Render / Railway (Recommended for Full Functionality)
For the scraper to work fully, you need a platform that supports Docker or larger environments.

**Steps for Render:**
1. Create a `Dockerfile` (already included in this project).
2. Push code to GitHub.
3. Go to [Render.com](https://render.com) -> New -> **Web Service**.
4. Connect your repo.
5. Select **Docker** as the Runtime.
6. Click **Create Web Service**.

##  Local Development
1. Clone the repo.
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   playwright install chromium
   ```
3. Run the app:
   ```bash
   python app/main.py
   ```
4. Open `http://localhost:5000`.
