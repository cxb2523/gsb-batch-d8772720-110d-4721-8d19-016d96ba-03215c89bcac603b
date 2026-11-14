"""
Contract tests for the collection pipeline:
  parse -> price tracking (always) -> ad filtering -> result/export/notification.

Covers:
* positive path: tracked, filtered-in items with recognised price drops;
* negative path: filtered-out items are still tracked (history written) but never
  reach the results, Excel export, or notifier;
* edge path: duplicate parses of the same id with the same price never create a
  duplicate history row and never report a price drop;
* batch summary explains why an item is missing from the results.

Both the synchronous (AvitoClient) and asynchronous (AsyncAvitoClient) paths are covered.
"""

import asyncio
import json

import pytest

from avito_sdk import (
    AvitoClient,
    AsyncAvitoClient,
    BatchSummary,
    PriceOutcome,
    PriceTracker,
)
from avito_sdk.models import Item


def _catalog_html(items):
    """Build a minimal Avito-like page embedding a JSON catalog state."""
    payload = {"result": {"catalog": {"items": items}}}
    return (
        '<html><body><script type="mime/invalid" data-mfe-state="true">'
        + json.dumps(payload)
        + "</script></body></html>"
    )


def _items(*specs):
    return [
        {"id": item_id, "title": title, "price": price, "sellerName": "Shop"}
        for item_id, title, price in specs
    ]


class _RecordingNotifier:
    def __init__(self):
        self.notified = []
        self.progress = []
        self.finished = []

    def notify(self, item=None, **kwargs):
        self.notified.append(item)
        return True

    def start_progress(self, **kwargs):
        return {"chat": 1}

    def update_progress(self, **kwargs):
        self.progress.append(kwargs)

    def finish_progress(self, **kwargs):
        self.finished.append(kwargs)


# ---------------------------------------------------------------------------
# PriceTracker unit-level contract
# ---------------------------------------------------------------------------

def test_record_price_classifies_four_outcomes(tmp_path):
    tracker = PriceTracker(db_path=tmp_path / "prices.db")

    item = Item(id=1, title="iPhone", price=100000)
    first = tracker.record_price(item)
    assert first.outcome == PriceOutcome.FIRST_RECORD
    assert first.is_new is True
    assert first.initial_price == 100000
    assert item.is_new is True
    assert item.price_drop is None

    same = tracker.record_price(Item(id=1, title="iPhone", price=100000))
    assert same.outcome == PriceOutcome.UNCHANGED
    assert same.changed is False
    assert same.initial_price == 100000

    up_item = Item(id=1, title="iPhone", price=110000)
    up = tracker.record_price(up_item)
    assert up.outcome == PriceOutcome.PRICE_UP
    assert up.previous_price == 100000
    assert up.initial_price == 100000
    assert up_item.price_drop is None
    assert up_item.old_price == 100000

    down_item = Item(id=1, title="iPhone", price=90000)
    down = tracker.record_price(down_item)
    assert down.outcome == PriceOutcome.PRICE_DOWN
    assert down.previous_price == 110000
    assert down.initial_price == 100000
    assert down.price_drop == 20000
    assert down_item.price_drop == 20000

    history = tracker.get_history(1)
    assert [rec.price for rec in history] == [100000, 110000, 90000]


def test_record_price_duplicate_same_price_does_not_duplicate_history(tmp_path):
    tracker = PriceTracker(db_path=tmp_path / "dup.db")

    for _ in range(5):
        item = Item(id=42, title="Same price", price=5000)
        update = tracker.record_price(item)
        assert update.price_drop is None
        assert item.price_drop is None

    assert len(tracker.get_history(42)) == 1
    assert tracker.get_price_drops() == []


def test_price_history_preserved_across_filtering_gaps(tmp_path):
    """A price must survive a round where the item was never returned by filters."""
    tracker = PriceTracker(db_path=tmp_path / "gap.db")

    tracker.record_price(Item(id=7, price=20000))
    # Simulate rounds with no tracking call (item filtered out / not scraped).
    tracker.record_price(Item(id=7, price=19000))
    assert tracker.get_initial_price(7) == 20000

    item = Item(id=7, price=15000)
    update = tracker.record_price(item)
    assert update.outcome == PriceOutcome.PRICE_DOWN
    assert update.initial_price == 20000
    assert item.price_drop == 4000
    assert [rec.price for rec in tracker.get_history(7)] == [20000, 19000, 15000]


# ---------------------------------------------------------------------------
# Sync collection path
# ---------------------------------------------------------------------------

def test_sync_search_tracks_before_filtering_and_returns_matches(monkeypatch, tmp_path):
    """Positive path: price-filtered drop is tracked, returned, exported, notified."""
    client = AvitoClient(tracker_db=tmp_path / "sync.db")
    # Seed the tracker with a previous, higher price for item 1.
    client.tracker.record_price(Item(id=1, title="iPhone 15", price=100000))

    html = _catalog_html(_items((1, "iPhone 15", 80000), (2, "iPhone 15 Pro", 150000)))
    monkeypatch.setattr(client.transport, "fetch_html", lambda url: html)

    notifier = _RecordingNotifier()
    client.notifier = notifier

    excel_path = tmp_path / "out.xlsx"
    items = list(
        client.search(
            query="iphone",
            max_price=100000,
            notify_telegram=True,
            excel_path=excel_path,
            limit=10,
            max_pages=1,
        )
    )

    assert [it.id for it in items] == [1]
    assert items[0].price_drop == 20000
    assert items[0].old_price == 100000
    assert [it.id for it in notifier.notified] == [1]
    assert excel_path.exists()

    # The expensive item was tracked even though it never reached the results.
    assert [rec.price for rec in client.tracker.get_history(2)] == [150000]
    assert client.tracker.get_initial_price(2) == 150000

    summary = client.last_batch_summary
    assert isinstance(summary, BatchSummary)
    assert summary.get(1).outcome == PriceOutcome.PRICE_DOWN
    assert summary.get(1).passed is True
    assert summary.get(1).returned is True
    assert summary.get(1).current_price == 80000
    assert summary.get(1).initial_price == 100000
    assert summary.get(1).price_drop == 20000

    assert summary.get(2).passed is False
    assert summary.get(2).returned is False
    assert summary.get(2).rejection_reason == "price_above_max"
    assert summary.get(2).outcome == PriceOutcome.FIRST_RECORD
    assert summary.get(2).current_price == 150000
    assert "rejected" in summary.explain(2)
    assert summary.stats["parsed"] == 2
    assert summary.stats["returned"] == 1
    assert summary.stats["rejected"] == 1
    client.close()


def test_sync_scrape_url_tracks_rejected_items_without_exporting_them(monkeypatch, tmp_path):
    """Negative path: a blacklisted item keeps history but never enters results/export."""
    client = AvitoClient(tracker_db=tmp_path / "scrape.db")
    client.tracker.record_price(Item(id=11, title="Laptop new", price=60000))

    html = _catalog_html(
        _items((11, "Laptop new", 50000), (12, "Laptop broken", 40000))
    )
    monkeypatch.setattr(client.transport, "fetch_html", lambda url: html)

    notifier = _RecordingNotifier()
    client.notifier = notifier
    excel_path = tmp_path / "catalog.xlsx"

    results = client.scrape_url(
        url="https://www.avito.ru/moskva/noutbuki",
        max_pages=1,
        black_keywords=["broken"],
        notify_telegram=True,
        excel_path=excel_path,
    )

    assert [it.id for it in results] == [11]
    assert [it.id for it in notifier.notified] == [11]
    assert client.tracker.get_history(12)[0].price == 40000
    assert client.tracker.get_initial_price(12) == 40000

    summary = client.last_batch_summary
    assert summary.get(12).passed is False
    assert summary.get(12).rejection_reason == "black_keyword"
    assert summary.get(12).outcome == PriceOutcome.FIRST_RECORD
    assert summary.get(11).outcome == PriceOutcome.PRICE_DOWN
    assert summary.get(11).price_drop == 10000

    import openpyxl

    wb = openpyxl.load_workbook(excel_path)
    ids = [row[0] for row in wb.active.iter_rows(min_row=2, values_only=True)]
    assert ids == [11]
    client.close()


def test_sync_rejected_then_eligible_item_is_recognised_as_drop(monkeypatch, tmp_path):
    """
    Round 1: item is above max_price and is filtered out, but its price is recorded.
    Round 2: price drops below max_price -> recognised as a price drop, not a first sight.
    """
    client = AvitoClient(tracker_db=tmp_path / "two_rounds.db")

    round1_html = _catalog_html(_items((51, "RTX 4090", 200000)))
    monkeypatch.setattr(client.transport, "fetch_html", lambda url: round1_html)

    first = list(client.search(query="rtx", max_price=150000, limit=10, max_pages=1))
    assert first == []
    assert client.tracker.get_initial_price(51) == 200000
    summary1 = client.last_batch_summary
    assert summary1.get(51).passed is False
    assert summary1.get(51).rejection_reason == "price_above_max"
    assert summary1.get(51).outcome == PriceOutcome.FIRST_RECORD

    round2_html = _catalog_html(_items((51, "RTX 4090", 140000)))
    monkeypatch.setattr(client.transport, "fetch_html", lambda url: round2_html)

    second = list(client.search(query="rtx", max_price=150000, limit=10, max_pages=1))
    assert [it.id for it in second] == [51]
    assert second[0].old_price == 200000
    assert second[0].price_drop == 60000

    summary2 = client.last_batch_summary
    assert summary2.get(51).passed is True
    assert summary2.get(51).outcome == PriceOutcome.PRICE_DOWN
    assert summary2.get(51).current_price == 140000
    assert summary2.get(51).initial_price == 200000
    assert summary2.get(51).price_drop == 60000
    assert [rec.price for rec in client.tracker.get_history(51)] == [200000, 140000]
    client.close()


def test_batch_summary_explains_items_trimmed_by_limit(monkeypatch, tmp_path):
    """Items trimmed by `limit` are tracked and explained, but never returned."""
    client = AvitoClient(tracker_db=tmp_path / "limit.db")
    html = _catalog_html(
        _items((61, "GPU A", 10000), (62, "GPU B", 20000), (63, "GPU C", 30000))
    )
    monkeypatch.setattr(client.transport, "fetch_html", lambda url: html)

    results = list(client.search(query="gpu", limit=2, max_pages=1))
    assert [it.id for it in results] == [61, 62]

    summary = client.last_batch_summary
    assert summary.stats["parsed"] == 3
    assert summary.stats["returned"] == 2
    assert summary.get(63).passed is False
    assert summary.get(63).rejection_reason == "limit_reached"
    # Still tracked, so a later round can detect a drop.
    assert client.tracker.get_initial_price(63) == 30000
    assert summary.explain(63) is not None
    client.close()



    """Edge path: the same id parsed on several pages at the same price is one record."""
    client = AvitoClient(tracker_db=tmp_path / "dupes.db")

    html = _catalog_html(_items((21, "PlayStation 5", 55000), (21, "PlayStation 5", 55000)))
    monkeypatch.setattr(client.transport, "fetch_html", lambda url: html)

    results = list(client.search(query="ps5", max_pages=1, limit=10))
    # Duplicate id is returned twice by search but has a single history record.
    assert len(results) == 2
    assert all(it.price_drop is None for it in results)
    assert len(client.tracker.get_history(21)) == 1
    assert client.tracker.get_price_drops() == []

    summary = client.last_batch_summary
    assert summary.get(21).seen_count == 2
    # The first occurrence was a genuine first record; the duplicate is "unchanged".
    # The summary keeps the most significant outcome (first_record dominates unchanged).
    assert summary.get(21).outcome == PriceOutcome.FIRST_RECORD
    assert summary.get(21).price_drop is None
    assert summary.get(21).passed is True
    assert summary.get(21).current_price == 55000
    client.close()


# ---------------------------------------------------------------------------
# Async collection path
# ---------------------------------------------------------------------------

def test_async_search_tracks_before_filtering_and_returns_matches(monkeypatch, tmp_path):
    """Positive path for the async client: same contract, same summary."""

    async def _run():
        client = AsyncAvitoClient(tracker_db=tmp_path / "async.db")
        client.tracker.record_price(Item(id=31, title="MacBook", price=120000))

        html = _catalog_html(_items((31, "MacBook", 100000), (32, "MacBook Pro", 200000)))

        async def mock_fetch(url):
            return html

        monkeypatch.setattr(client.transport, "fetch_html", mock_fetch)

        items = []
        async for item in client.search(
            query="macbook", max_price=150000, limit=10, max_pages=1
        ):
            items.append(item)
        await client.close()
        return client, items

    client, items = asyncio.run(_run())

    assert [it.id for it in items] == [31]
    assert items[0].price_drop == 20000
    assert client.tracker.get_history(32)[0].price == 200000

    summary = client.last_batch_summary
    assert summary.get(31).outcome == PriceOutcome.PRICE_DOWN
    assert summary.get(31).passed is True
    assert summary.get(32).passed is False
    assert summary.get(32).rejection_reason == "price_above_max"
    assert summary.get(32).outcome == PriceOutcome.FIRST_RECORD


def test_async_rejected_item_not_tracked_as_drop_even_if_price_fell(monkeypatch, tmp_path):
    """Rejected items keep their history, but a drop inside a rejected item is not a result."""

    async def _run():
        client = AsyncAvitoClient(tracker_db=tmp_path / "async_reject.db")
        client.tracker.record_price(Item(id=41, title="Broken laptop", price=70000))

        html = _catalog_html(_items((41, "Broken laptop", 50000)))
        async def mock_fetch(url):
            return html

        monkeypatch.setattr(client.transport, "fetch_html", mock_fetch)

        items = []
        async for item in client.search(
            query="laptop", black_keywords=["broken"], limit=10, max_pages=1
        ):
            items.append(item)
        await client.close()
        return client, items

    client, items = asyncio.run(_run())

    assert items == []
    # History still records the drop even though the item was filtered out...
    assert [rec.price for rec in client.tracker.get_history(41)] == [70000, 50000]
    summary = client.last_batch_summary
    assert summary.get(41).outcome == PriceOutcome.PRICE_DOWN
    assert summary.get(41).passed is False
    assert summary.get(41).rejection_reason == "black_keyword"
