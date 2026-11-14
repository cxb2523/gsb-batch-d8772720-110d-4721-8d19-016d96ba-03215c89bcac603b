import re
import asyncio
import os
import pandas as pd
from datetime import datetime, timedelta
from playwright.async_api import async_playwright

# Page-level end reasons (页级结束原因)
REASON_CONTINUE = "continue"                # 继续翻页（本页成功，翻到下一页）
REASON_TARGET_REACHED = "target_reached"    # 达到目标数量
REASON_NO_CARDS = "no_cards"                # 未找到房源卡片（失败）
REASON_NO_NEXT_BUTTON = "no_next_button"    # 无下一页按钮
REASON_PAGINATION_ERROR = "pagination_error"  # 翻页异常（失败）

# Reasons that count as page failures (eligible for retry)
FAILED_REASONS = {REASON_NO_CARDS, REASON_PAGINATION_ERROR}

REQUIRED_COLS = ["HotelName", "Location", "Price", "Rating", "Stars", "City"]


class BookingScraper:
    def __init__(self, records_dir="app/records", on_page_record=None):
        self.records_dir = records_dir
        if not os.path.exists(self.records_dir):
            os.makedirs(self.records_dir)
        self.hotels_data = []
        self.page_records = []
        self.target = 0
        self._seen_keys = set()
        # Optional callback invoked with each page record as soon as it is produced
        self.on_page_record = on_page_record

    # ------------------------------------------------------------------
    # URL helpers
    # ------------------------------------------------------------------
    @staticmethod
    def default_page_url(page_number):
        """Booking.com search URL for a 1-based page number (25 results per page)."""
        tomorrow = datetime.now() + timedelta(days=1)
        next_day = tomorrow + timedelta(days=1)
        checkin = tomorrow.strftime("%Y-%m-%d")
        checkout = next_day.strftime("%Y-%m-%d")
        offset = (page_number - 1) * 25
        return (
            f"https://www.booking.com/searchresults.en-gb.html?"
            f"ss=New+York&checkin={checkin}&checkout={checkout}"
            f"&group_adults=2&no_rooms=1&group_children=0&offset={offset}"
        )

    # ------------------------------------------------------------------
    # Extraction
    # ------------------------------------------------------------------
    def _record_key(self, record):
        return (record.get("HotelName", ""), record.get("Location", ""))

    def _append_hotel(self, record):
        """Append a hotel record, skipping duplicates already collected."""
        key = self._record_key(record)
        if key in self._seen_keys:
            return False
        self._seen_keys.add(key)
        self.hotels_data.append(record)
        return True

    async def _extract_cards(self, page, limit):
        """Extract hotel cards on the current page. Returns number of new records."""
        cards = await page.locator('[data-testid="property-card"]').all()
        print(f"Found {len(cards)} cards on this page.")
        new_count = 0
        for card in cards:
            if len(self.hotels_data) >= limit:
                break

            try:
                name = await card.locator('[data-testid="title"]').first.inner_text()
            except Exception:
                name = "N/A"

            try:
                price = await card.locator('[data-testid="price-and-discounted-price"]').first.inner_text()
            except Exception:
                try:
                    price = await card.locator('.bui-price-display__value').first.inner_text()
                except Exception:
                    price = "0"

            try:
                address = await card.locator('[data-testid="address"]').first.inner_text()
            except Exception:
                address = "New York"  # Fallback since we searched for NY

            try:
                rating = await card.locator('[data-testid="review-score"]').first.inner_text()
                rating = rating.replace("\n", " ")
            except Exception:
                rating = "N/A"

            try:
                stars_count = await card.locator('[data-testid="rating-stars"] span').count()
                if stars_count == 0:
                    stars_count = await card.locator('[data-testid="rating-squares"] span').count()
                stars = f"{stars_count} stars" if stars_count > 0 else "N/A"
            except Exception:
                stars = "N/A"

            if self._append_hotel({
                "HotelName": name.strip(),
                "Location": address.strip(),
                "Price": price.strip(),
                "Rating": rating.strip(),
                "Stars": stars,
                "City": "New York"
            }):
                new_count += 1
        return new_count

    def _new_page_record(self, page_number):
        return {
            "page": page_number,
            "new_records": 0,
            "total_records": len(self.hotels_data),
            "reason": None,          # end reason code, see REASON_* constants
            "success": True,
            "error": None,           # short failure detail when success is False
        }

    def _emit_page_record(self, record):
        record["total_records"] = len(self.hotels_data)
        self.page_records.append(record)
        if self.on_page_record:
            try:
                self.on_page_record(dict(record))
            except Exception as e:
                print(f"on_page_record callback error: {e}")

    async def _scrape_current_page(self, page, page_number, limit, paginate=True):
        """
        Scrape the page currently loaded in the browser.
        Returns (record, should_continue_pagination).
        """
        record = self._new_page_record(page_number)

        # Wait for cards to load
        try:
            await page.wait_for_selector('[data-testid="property-card"]', timeout=10000)
        except Exception:
            print(f"Page {page_number}: no property cards found.")
            record["reason"] = REASON_NO_CARDS
            record["success"] = False
            record["error"] = "未找到房源卡片"
            self._emit_page_record(record)
            return record, False

        new_count = await self._extract_cards(page, limit)
        record["new_records"] = new_count
        print(f"Page {page_number}: +{new_count} records, total {len(self.hotels_data)}/{limit}.")

        if len(self.hotels_data) >= limit:
            record["reason"] = REASON_TARGET_REACHED
            self._emit_page_record(record)
            return record, False

        if not paginate:
            # Direct-navigation mode (retry): no next-button handling needed
            record["reason"] = REASON_CONTINUE
            self._emit_page_record(record)
            return record, False

        # Pagination
        try:
            next_button = page.locator('button[aria-label="Next page"]')
            if await next_button.count() == 0 or not await next_button.first.is_visible():
                print(f"Page {page_number}: no next page button found.")
                record["reason"] = REASON_NO_NEXT_BUTTON
                self._emit_page_record(record)
                return record, False
            await next_button.first.click()
            await page.wait_for_timeout(3000)  # Wait for page load
            record["reason"] = REASON_CONTINUE
            self._emit_page_record(record)
            return record, True
        except Exception as e:
            print(f"Page {page_number}: pagination error: {e}")
            record["reason"] = REASON_PAGINATION_ERROR
            record["success"] = False
            record["error"] = f"翻页异常: {str(e)[:200]}"
            self._emit_page_record(record)
            return record, False

    # ------------------------------------------------------------------
    # Browser lifecycle
    # ------------------------------------------------------------------
    async def _new_browser_page(self, p):
        is_server = os.name != 'nt' or os.environ.get('HEADLESS', 'false').lower() == 'true'
        print(f"Running scraper with headless={is_server}")
        launch_kwargs = {"headless": is_server}
        # Optional overrides for environments without the bundled chromium
        if os.environ.get('CHROME_EXECUTABLE'):
            launch_kwargs["executable_path"] = os.environ['CHROME_EXECUTABLE']
        elif os.environ.get('CHROME_CHANNEL'):
            launch_kwargs["channel"] = os.environ['CHROME_CHANNEL']
        browser = await p.chromium.launch(**launch_kwargs)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()
        return browser, page

    @staticmethod
    async def _dismiss_popups(page):
        try:
            await page.get_by_label("Dismiss sign in information.").click(timeout=2000)
        except Exception:
            pass
        try:
            await page.locator("button#onetrust-accept-btn-handler").click(timeout=2000)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def run(self, limit=10, start_url=None, page_url_builder=None):
        """
        Full scrape run. Returns a dict:
        {
            "filepath": str,
            "page_records": [ {page, new_records, total_records, reason, success, error}, ... ],
            "total_records": int,
            "target": int,
        }
        """
        limit = max(10, min(100, int(limit)))
        self.target = limit
        self.hotels_data = []
        self.page_records = []
        self._seen_keys = set()
        print(f"Starting scrape for {limit} records...")

        if page_url_builder is None:
            page_url_builder = self.default_page_url
        first_url = start_url or page_url_builder(1)

        async with async_playwright() as p:
            browser, page = await self._new_browser_page(p)
            try:
                print(f"Navigating to: {first_url}")
                await page.goto(first_url, timeout=60000)
                await self._dismiss_popups(page)

                page_number = 1
                while len(self.hotels_data) < limit:
                    record, should_continue = await self._scrape_current_page(
                        page, page_number, limit, paginate=True
                    )
                    if not should_continue:
                        break
                    page_number += 1
            finally:
                await browser.close()

        filepath = self._save_csv(limit)
        return {
            "filepath": filepath,
            "page_records": list(self.page_records),
            "total_records": len(self.hotels_data),
            "target": limit,
        }

    async def retry_failed_pages(self, failed_pages, limit, base_file, page_url_builder=None):
        """
        Re-scrape only the given failed page numbers, merging results into the
        existing dataset from base_file. Successful data is preserved and
        duplicates are not written. Returns the same shape as run().
        """
        limit = max(10, min(100, int(limit)))
        self.target = limit
        self.page_records = []
        self._seen_keys = set()

        # Load previously collected (successful) data so it is preserved
        self.hotels_data = []
        if base_file and os.path.exists(base_file):
            df = pd.read_csv(base_file)
            for col in REQUIRED_COLS:
                if col not in df.columns:
                    df[col] = "N/A"
            for row in df.to_dict(orient="records"):
                self._append_hotel({col: row.get(col, "N/A") for col in REQUIRED_COLS})
        print(f"Retrying pages {failed_pages}; loaded {len(self.hotels_data)} existing records.")

        if page_url_builder is None:
            page_url_builder = self.default_page_url

        async with async_playwright() as p:
            browser, page = await self._new_browser_page(p)
            try:
                for page_number in sorted(failed_pages):
                    if len(self.hotels_data) >= limit:
                        break
                    url = page_url_builder(page_number)
                    print(f"Retrying page {page_number}: {url}")
                    try:
                        await page.goto(url, timeout=60000)
                    except Exception as e:
                        record = self._new_page_record(page_number)
                        record["reason"] = REASON_PAGINATION_ERROR
                        record["success"] = False
                        record["error"] = f"页面加载失败: {str(e)[:200]}"
                        self._emit_page_record(record)
                        continue
                    await self._dismiss_popups(page)
                    await self._scrape_current_page(page, page_number, limit, paginate=False)
            finally:
                await browser.close()

        # Save merged data back to the SAME file (no clearing, no duplicates)
        filepath = self._save_csv(limit, filepath=base_file)
        return {
            "filepath": filepath,
            "page_records": list(self.page_records),
            "total_records": len(self.hotels_data),
            "target": limit,
        }

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def _save_csv(self, limit, filepath=None):
        if filepath is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"hotels_{limit}_{timestamp}.csv"
            filepath = os.path.join(self.records_dir, filename)

        df = pd.DataFrame(self.hotels_data)
        for col in REQUIRED_COLS:
            if col not in df.columns:
                df[col] = "N/A"
        df = df[REQUIRED_COLS]
        df.to_csv(filepath, index=False)
        print(f"Data saved to {filepath}")
        return filepath


if __name__ == "__main__":
    scraper = BookingScraper()
    result = asyncio.run(scraper.run(limit=10))
    print(f"Finished: {result['total_records']} records -> {result['filepath']}")
    for rec in result["page_records"]:
        print(rec)
