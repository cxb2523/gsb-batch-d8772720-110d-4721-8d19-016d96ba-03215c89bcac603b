"""
Price tracking and change detection engine (PR #334 / Issue #214).
Stores historical item prices in SQLite and detects price drops.

Collection contract
-------------------
Every item parsed from a page must be passed through :meth:`PriceTracker.record_price`
*before* ad filters are evaluated.  Filtering never mutates or clears price history, so
an item that is rejected by the current filter (price range, keywords, region, ...)
keeps its full history and can still be recognised as a price drop once it becomes
eligible again.

``record_price`` classifies each update into exactly one of four outcomes:

* ``first_record``  - the item id was never seen before;
* ``unchanged``     - the same price was seen again (no history row is written);
* ``price_up``      - the price increased compared to the previous known price;
* ``price_down``    - the price decreased compared to the previous known price.

:class:`BatchSummary` records the outcome of every parsed item for a single collection
call, including items rejected by filters, so callers can explain why an item did not
show up in the results.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from threading import Lock
from typing import Dict, Iterator, List, Optional, Tuple, Union

from avito_sdk.models import Item, PriceRecord


class PriceOutcome(str, Enum):
    """The four possible results of tracking an item's price."""

    FIRST_RECORD = "first_record"
    UNCHANGED = "unchanged"
    PRICE_UP = "price_up"
    PRICE_DOWN = "price_down"


# Convenience module-level aliases (useful for string comparisons in user code).
FIRST_RECORD = PriceOutcome.FIRST_RECORD
UNCHANGED = PriceOutcome.UNCHANGED
PRICE_UP = PriceOutcome.PRICE_UP
PRICE_DOWN = PriceOutcome.PRICE_DOWN


@dataclass
class PriceUpdate:
    """Rich result returned by :meth:`PriceTracker.record_price`."""

    item_id: int
    outcome: PriceOutcome
    current_price: int
    initial_price: int
    previous_price: Optional[int] = None
    changed: bool = False
    price_drop: Optional[int] = None

    @property
    def is_new(self) -> bool:
        """True when this is the first time the item has been recorded."""
        return self.outcome == PriceOutcome.FIRST_RECORD

    @property
    def is_price_drop(self) -> bool:
        return self.outcome == PriceOutcome.PRICE_DOWN

    @property
    def is_price_increase(self) -> bool:
        return self.outcome == PriceOutcome.PRICE_UP

    def to_dict(self) -> Dict[str, object]:
        return {
            "item_id": self.item_id,
            "outcome": self.outcome.value,
            "current_price": self.current_price,
            "initial_price": self.initial_price,
            "previous_price": self.previous_price,
            "changed": self.changed,
            "price_drop": self.price_drop,
            "is_new": self.is_new,
        }


@dataclass
class BatchItemSummary:
    """Per-item outcome of a single collection (search / scrape) call."""

    item_id: int
    passed: bool
    outcome: Optional[PriceOutcome]
    current_price: int
    initial_price: Optional[int] = None
    previous_price: Optional[int] = None
    price_drop: Optional[int] = None
    is_new: Optional[bool] = None
    rejection_reason: Optional[str] = None
    returned: bool = False
    seen_count: int = 1

    @property
    def price_changed(self) -> bool:
        return self.outcome in (PriceOutcome.PRICE_UP, PriceOutcome.PRICE_DOWN)

    def to_dict(self) -> Dict[str, object]:
        return {
            "item_id": self.item_id,
            "passed": self.passed,
            "returned": self.returned,
            "outcome": self.outcome.value if self.outcome is not None else None,
            "current_price": self.current_price,
            "initial_price": self.initial_price,
            "previous_price": self.previous_price,
            "price_drop": self.price_drop,
            "is_new": self.is_new,
            "rejection_reason": self.rejection_reason,
            "seen_count": self.seen_count,
        }

    def explain(self) -> str:
        """Human readable one-line explanation, handy for debugging missing items."""
        status = "passed" if self.passed else f"rejected ({self.rejection_reason or 'filter'})"
        outcome = self.outcome.value if self.outcome is not None else "not_tracked"
        prices = f"{self.current_price}"
        if self.initial_price is not None and self.initial_price != self.current_price:
            prices += f" (initial {self.initial_price})"
        return f"item {self.item_id}: {status}, {outcome}, current {prices}"


@dataclass
class BatchSummary:
    """
    Queryable summary of one collection call, keyed by item id.

    The summary covers *every* item parsed from pages, including items that were
    rejected by filters.  Duplicate occurrences of the same id are merged into a
    single entry (``seen_count`` tracks how many times it was parsed).
    """

    query: str = ""
    url: Optional[str] = None
    entries: Dict[int, BatchItemSummary] = field(default_factory=dict)

    # ----- recording -----------------------------------------------------
    def record(
        self,
        item: Item,
        passed: bool,
        update: Optional[PriceUpdate] = None,
        rejection_reason: Optional[str] = None,
        returned: bool = False,
    ) -> BatchItemSummary:
        """Record/merge the result of processing one parsed item."""
        item_id = int(getattr(item, "id", 0) or 0)
        current_price = int(getattr(item, "price", 0) or 0)
        price_drop = getattr(item, "price_drop", None)
        is_new = getattr(item, "is_new", None)
        outcome = update.outcome if update is not None else None
        initial_price = update.initial_price if update is not None else None
        previous_price = update.previous_price if update is not None else None

        existing = self.entries.get(item_id)
        if existing is None:
            entry = BatchItemSummary(
                item_id=item_id,
                passed=bool(passed),
                outcome=outcome,
                current_price=current_price,
                initial_price=initial_price,
                previous_price=previous_price,
                price_drop=price_drop,
                is_new=is_new,
                rejection_reason=None if passed else rejection_reason,
                returned=bool(returned),
                seen_count=1,
            )
            self.entries[item_id] = entry
            return entry

        # Duplicate id within the same batch: keep the most significant outcome
        # (a real price change dominates new/unchanged). A verdict of "passed" is
        # sticky: being trimmed on a later page must not erase an earlier return.
        existing.seen_count += 1
        existing.passed = existing.passed or bool(passed)
        existing.returned = existing.returned or bool(returned)
        existing.current_price = current_price
        if existing.passed:
            existing.rejection_reason = None
        elif rejection_reason is not None:
            existing.rejection_reason = rejection_reason
        if initial_price is not None:
            existing.initial_price = initial_price
        if update is not None:
            if update.previous_price is not None:
                existing.previous_price = update.previous_price
            # Never let a duplicate same-price occurrence erase a real drop.
            if update.price_drop is not None:
                existing.price_drop = update.price_drop
            priority = {
                PriceOutcome.UNCHANGED: 0,
                PriceOutcome.FIRST_RECORD: 1,
                PriceOutcome.PRICE_UP: 2,
                PriceOutcome.PRICE_DOWN: 3,
            }
            if existing.outcome is None or priority[update.outcome] >= priority[existing.outcome]:
                existing.outcome = update.outcome
                existing.is_new = update.is_new
        return existing

    # ----- querying ------------------------------------------------------
    def get(self, item_id: Union[int, str]) -> Optional[BatchItemSummary]:
        """Return the summary entry for an item id (or ``None``)."""
        try:
            return self.entries.get(int(item_id))
        except (TypeError, ValueError):
            return None

    def outcome(self, item_id: Union[int, str]) -> Optional[PriceOutcome]:
        entry = self.get(item_id)
        return entry.outcome if entry else None

    def was_passed(self, item_id: Union[int, str]) -> bool:
        entry = self.get(item_id)
        return bool(entry and entry.passed)

    def explain(self, item_id: Union[int, str]) -> Optional[str]:
        entry = self.get(item_id)
        return entry.explain() if entry else None

    def __getitem__(self, item_id: Union[int, str]) -> BatchItemSummary:
        entry = self.get(item_id)
        if entry is None:
            raise KeyError(item_id)
        return entry

    def __contains__(self, item_id: object) -> bool:
        try:
            return int(item_id) in self.entries  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return False

    def __iter__(self) -> Iterator[BatchItemSummary]:
        return iter(self.entries.values())

    def __len__(self) -> int:
        return len(self.entries)

    @property
    def passed_items(self) -> List[BatchItemSummary]:
        return [e for e in self.entries.values() if e.passed]

    @property
    def rejected_items(self) -> List[BatchItemSummary]:
        return [e for e in self.entries.values() if not e.passed]

    @property
    def stats(self) -> Dict[str, int]:
        values = list(self.entries.values())
        return {
            "parsed": len(values),
            "occurrences": sum(e.seen_count for e in values),
            "passed": sum(1 for e in values if e.passed),
            "rejected": sum(1 for e in values if not e.passed),
            "returned": sum(1 for e in values if e.returned),
            "price_drops": sum(1 for e in values if e.price_drop),
        }

    def to_dict(self) -> Dict[str, object]:
        return {
            "query": self.query,
            "url": self.url,
            "stats": self.stats,
            "items": {str(item_id): entry.to_dict() for item_id, entry in self.entries.items()},
        }


class PriceTracker:
    """
    Tracks price changes over time for Avito listings.
    Supports in-memory tracking or persistent SQLite storage.
    """

    def __init__(self, db_path: Union[str, Path] = "avito_prices.db"):
        self.db_path = str(db_path)
        self._lock = Lock()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            cursor = conn.cursor()
            # Current price cache for fast lookup
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS current_prices (
                    item_id INTEGER PRIMARY KEY,
                    price INTEGER NOT NULL,
                    title TEXT,
                    seller_name TEXT,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            # Full historical log
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id INTEGER NOT NULL,
                    price INTEGER NOT NULL,
                    title TEXT,
                    seller_name TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_history_item ON price_history(item_id, timestamp)"
            )
            conn.commit()

    @staticmethod
    def _initial_price(cursor: sqlite3.Cursor, item_id: int, fallback: int) -> int:
        """Return the first ever recorded price for an item."""
        cursor.execute(
            "SELECT price FROM price_history WHERE item_id = ? ORDER BY id ASC LIMIT 1",
            (item_id,),
        )
        row = cursor.fetchone()
        return int(row["price"]) if row is not None else int(fallback)

    def record_price(self, item: Item) -> PriceUpdate:
        """
        Record the current price of an item and classify the update.

        The method always runs *before* ad filtering in the collection paths.
        It distinguishes four outcomes (:class:`PriceOutcome`):

        * ``first_record`` - inserts the first history row, marks ``item.is_new``;
        * ``unchanged``    - same price as the last known one: no history row is
          written and ``item.price_drop`` stays ``None``;
        * ``price_up``     - previous price is lower, ``item.old_price`` is set;
        * ``price_down``   - previous price is higher, ``item.old_price`` and
          ``item.price_drop`` are set.

        The initial (first ever) price is returned in ``PriceUpdate.initial_price``.
        """
        item_id = int(item.id)
        current_price = int(item.price or 0)
        title = item.title
        seller_name = item.seller_name

        with self._lock, self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT price FROM current_prices WHERE item_id = ?", (item_id,)
            )
            row = cursor.fetchone()

            if row is None:
                # First time seeing this item.
                item.is_new = True
                item.old_price = None
                cursor.execute(
                    """
                    INSERT INTO current_prices (item_id, price, title, seller_name, last_updated)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (item_id, current_price, title, seller_name),
                )
                cursor.execute(
                    """
                    INSERT INTO price_history (item_id, price, title, seller_name, timestamp)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (item_id, current_price, title, seller_name),
                )
                conn.commit()
                return PriceUpdate(
                    item_id=item_id,
                    outcome=PriceOutcome.FIRST_RECORD,
                    current_price=current_price,
                    initial_price=current_price,
                    previous_price=None,
                    changed=False,
                    price_drop=None,
                )

            item.is_new = False
            saved_price = int(row["price"])
            initial_price = self._initial_price(cursor, item_id, saved_price)

            if saved_price == current_price:
                # Same price seen again (also covers duplicate cards in one batch):
                # never write a duplicate history row and never report a drop.
                item.old_price = None
                return PriceUpdate(
                    item_id=item_id,
                    outcome=PriceOutcome.UNCHANGED,
                    current_price=current_price,
                    initial_price=initial_price,
                    previous_price=saved_price,
                    changed=False,
                    price_drop=None,
                )

            # Real price change: update the cache and append exactly one history row.
            item.old_price = saved_price
            cursor.execute(
                """
                UPDATE current_prices
                SET price = ?, title = ?, seller_name = ?, last_updated = CURRENT_TIMESTAMP
                WHERE item_id = ?
                """,
                (current_price, title, seller_name, item_id),
            )
            cursor.execute(
                """
                INSERT INTO price_history (item_id, price, title, seller_name, timestamp)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (item_id, current_price, title, seller_name),
            )
            conn.commit()

            if current_price > saved_price:
                return PriceUpdate(
                    item_id=item_id,
                    outcome=PriceOutcome.PRICE_UP,
                    current_price=current_price,
                    initial_price=initial_price,
                    previous_price=saved_price,
                    changed=True,
                    price_drop=None,
                )
            return PriceUpdate(
                item_id=item_id,
                outcome=PriceOutcome.PRICE_DOWN,
                current_price=current_price,
                initial_price=initial_price,
                previous_price=saved_price,
                changed=True,
                price_drop=saved_price - current_price,
            )

    def check_and_update(self, item: Item) -> Tuple[bool, Optional[int]]:
        """
        Backwards-compatible wrapper around :meth:`record_price`.

        Returns ``(changed, old_price)`` where ``changed`` is True for both price
        increases and decreases (use :meth:`record_price` when the direction matters).
        """
        update = self.record_price(item)
        return update.changed, update.previous_price

    def track_items(self, items: List[Item]) -> List[Item]:
        """Process a list of items, updating each item's old_price if changed."""
        for item in items:
            self.record_price(item)
        return items

    def get_history(self, item_id: int) -> List[PriceRecord]:
        """Return full price history for a given item ordered by insertion."""
        with self._lock, self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT item_id, price, timestamp, title, seller_name
                FROM price_history
                WHERE item_id = ?
                ORDER BY id ASC
                """,
                (item_id,),
            )
            rows = cursor.fetchall()
            return [
                PriceRecord(
                    item_id=row["item_id"],
                    price=row["price"],
                    timestamp=datetime.fromisoformat(row["timestamp"])
                    if "T" in str(row["timestamp"])
                    else datetime.strptime(str(row["timestamp"]), "%Y-%m-%d %H:%M:%S"),
                    seller_name=row["seller_name"],
                    title=row["title"],
                )
                for row in rows
            ]

    def get_initial_price(self, item_id: int) -> Optional[int]:
        """Return the first ever recorded price for an item, if any."""
        with self._lock, self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT price FROM price_history WHERE item_id = ? ORDER BY id ASC LIMIT 1",
                (item_id,),
            )
            row = cursor.fetchone()
            return int(row["price"]) if row is not None else None

    def get_price_drops(self) -> List[dict]:
        """Find items whose latest price is strictly lower than their initial recorded price."""
        with self._lock, self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT c.item_id, c.title, c.seller_name,
                       c.price AS current_price,
                       (SELECT h.price FROM price_history h
                        WHERE h.item_id = c.item_id
                        ORDER BY h.id ASC LIMIT 1) AS initial_price
                FROM current_prices c
                WHERE c.price < (
                    SELECT h2.price FROM price_history h2
                    WHERE h2.item_id = c.item_id
                    ORDER BY h2.id ASC LIMIT 1
                )
                ORDER BY (initial_price - c.price) DESC
                """
            )
            return [dict(row) for row in cursor.fetchall()]
