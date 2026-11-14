"""
Offline verification of page-level scrape records and failed-page retry.

Uses locally generated sample HTML pages (no real network). Run:
    python tests/test_offline.py

Scenario:
  page1.html  - 15 cards, "Next page" button -> page2.html
  page2.html  - 15 cards, "Next page" button -> page3.html
  page3.html  - NO cards            => page fails with reason "no_cards"
  page3_fixed.html - 10 cards       => used as the retry target for page 3
  page_nonext.html - 10 cards, no next button => reason "no_next_button"
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Headless even on Windows desktops
os.environ["HEADLESS"] = "true"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

from scraper import (  # noqa: E402
    BookingScraper,
    REASON_CONTINUE,
    REASON_TARGET_REACHED,
    REASON_NO_CARDS,
    REASON_NO_NEXT_BUTTON,
)


def make_card(i):
    return f"""
    <div data-testid="property-card">
      <div data-testid="title">Hotel {i}</div>
      <div data-testid="price-and-discounted-price">US$1{i:02d}</div>
      <div data-testid="address">Address {i}, New York</div>
      <div data-testid="review-score">8.{i % 10}</div>
      <div data-testid="rating-stars"><span></span><span></span><span></span></div>
    </div>"""


def make_page(cards, next_href=None):
    button = ""
    if next_href:
        button = f'<button aria-label="Next page" onclick="location.href=\'{next_href}\'">Next</button>'
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'><title>t</title></head>"
        f"<body>{''.join(cards)}{button}</body></html>"
    )


class OfflineScrapeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.pages_dir = root / "pages"
        cls.pages_dir.mkdir()
        cls.records_dir = root / "records"
        cls.records_dir.mkdir()

        (cls.pages_dir / "page1.html").write_text(
            make_page([make_card(i) for i in range(15)], "page2.html"), encoding="utf-8")
        (cls.pages_dir / "page2.html").write_text(
            make_page([make_card(i) for i in range(15, 30)], "page3.html"), encoding="utf-8")
        (cls.pages_dir / "page3.html").write_text(make_page([]), encoding="utf-8")
        (cls.pages_dir / "page3_fixed.html").write_text(
            make_page([make_card(i) for i in range(30, 40)]), encoding="utf-8")
        (cls.pages_dir / "page_nonext.html").write_text(
            make_page([make_card(i) for i in range(50, 60)]), encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def page_url(self, name):
        return (self.pages_dir / name).as_uri()

    def test_1_full_run_records_page_outcomes(self):
        """Full run: per-page records with new/cumulative counts and end reasons."""
        scraper = BookingScraper(records_dir=str(self.records_dir))
        result = asyncio.run(scraper.run(limit=40, start_url=self.page_url("page1.html")))

        # run() returns page records together with the file path
        self.assertIn("filepath", result)
        self.assertIn("page_records", result)
        self.assertTrue(os.path.exists(result["filepath"]))
        self.assertEqual(result["total_records"], 30)
        self.assertEqual(result["target"], 40)

        records = result["page_records"]
        self.assertEqual(len(records), 3)

        self.assertEqual(records[0]["page"], 1)
        self.assertEqual(records[0]["new_records"], 15)
        self.assertEqual(records[0]["total_records"], 15)
        self.assertEqual(records[0]["reason"], REASON_CONTINUE)
        self.assertTrue(records[0]["success"])

        self.assertEqual(records[1]["page"], 2)
        self.assertEqual(records[1]["new_records"], 15)
        self.assertEqual(records[1]["total_records"], 30)
        self.assertEqual(records[1]["reason"], REASON_CONTINUE)
        self.assertTrue(records[1]["success"])

        # Page 3 has no cards -> failure with a short reason
        self.assertEqual(records[2]["page"], 3)
        self.assertEqual(records[2]["new_records"], 0)
        self.assertEqual(records[2]["reason"], REASON_NO_CARDS)
        self.assertFalse(records[2]["success"])
        self.assertTrue(records[2]["error"])

        OfflineScrapeTest.last_result = result

    def test_2_no_next_button_is_not_a_failure(self):
        scraper = BookingScraper(records_dir=str(self.records_dir))
        result = asyncio.run(scraper.run(limit=40, start_url=self.page_url("page_nonext.html")))
        rec = result["page_records"][0]
        self.assertEqual(rec["reason"], REASON_NO_NEXT_BUTTON)
        self.assertTrue(rec["success"])
        self.assertEqual(rec["new_records"], 10)

    def test_3_target_reached_marks_last_page_successful(self):
        """Limit 10 < cards on page: last page reason is target_reached, not a failure."""
        scraper = BookingScraper(records_dir=str(self.records_dir))
        result = asyncio.run(scraper.run(limit=10, start_url=self.page_url("page1.html")))
        self.assertEqual(len(result["page_records"]), 1)
        rec = result["page_records"][0]
        self.assertEqual(rec["reason"], REASON_TARGET_REACHED)
        self.assertTrue(rec["success"])
        self.assertEqual(result["total_records"], 10)

    def test_4_retry_failed_pages_merges_without_duplicates(self):
        """Retry only the failed page; successful data preserved, no duplicates."""
        base = OfflineScrapeTest.last_result
        base_file = base["filepath"]
        failed_pages = [r["page"] for r in base["page_records"] if not r["success"]]
        self.assertEqual(failed_pages, [3])

        import pandas as pd
        before = pd.read_csv(base_file)
        self.assertEqual(len(before), 30)

        # Retry page 3 against the "fixed" local sample
        def builder(page_number):
            mapping = {3: self.page_url("page3_fixed.html")}
            return mapping[page_number]

        scraper = BookingScraper(records_dir=str(self.records_dir))
        result = asyncio.run(
            scraper.retry_failed_pages(failed_pages, 40, base_file, page_url_builder=builder)
        )

        # Same file path returned & reused (no clearing, no new file)
        self.assertEqual(result["filepath"], base_file)
        self.assertEqual(result["total_records"], 40)

        rec = result["page_records"][0]
        self.assertEqual(rec["page"], 3)
        self.assertEqual(rec["new_records"], 10)
        self.assertEqual(rec["reason"], REASON_TARGET_REACHED)
        self.assertTrue(rec["success"])

        after = pd.read_csv(base_file)
        self.assertEqual(len(after), 40)
        # Old successful rows preserved
        self.assertEqual(set(before["HotelName"]), set(after["HotelName"].head(30)))
        # No duplicates
        self.assertFalse(after.duplicated(subset=["HotelName", "Location"]).any())

    def test_5_no_failed_pages_means_nothing_to_retry(self):
        """A fully successful run exposes no failed pages (frontend shows notice)."""
        scraper = BookingScraper(records_dir=str(self.records_dir))
        result = asyncio.run(scraper.run(limit=10, start_url=self.page_url("page1.html")))
        failed = [r["page"] for r in result["page_records"] if not r["success"]]
        self.assertEqual(failed, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
