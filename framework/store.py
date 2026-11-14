#!/usr/bin/env python3
"""
store.py — Universal persistence layer

Writes the data contracts from adapter.py (Entity / Item / Metric / Text) into
the tables defined in schema.sql. All platforms share this write path: adapters
translate, store persists.

- Entities / items:  INSERT OR REPLACE (primary key is platform+id; re-fetch overwrites)
- Metrics / texts / features:  append-only (timestamped, enabling multiple snapshots)
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .adapter import Entity, Item, Metric, Text

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, db_path: str | Path):
        self.con = sqlite3.connect(str(db_path), isolation_level=None)  # autocommit
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    # ---- entities / items: upsert ----

    def upsert_entity(self, e: Entity, captured_at: str | None = None) -> None:
        self.con.execute(
            """INSERT OR REPLACE INTO entities
               (platform, entity_id, entity_type, name, segment, category,
                profile_json, status, captured_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (e.platform, e.entity_id, e.entity_type, e.name, e.segment, e.category,
             json.dumps(e.profile, ensure_ascii=False), e.status,
             captured_at or now_iso()),
        )

    def upsert_item(self, it: Item, captured_at: str | None = None) -> None:
        self.con.execute(
            """INSERT OR REPLACE INTO items
               (platform, item_id, entity_id, item_type, title, url, published_at,
                segment, category, meta_json, status, captured_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (it.platform, it.item_id, it.entity_id, it.item_type, it.title, it.url,
             it.published_at, it.segment, it.category,
             json.dumps(it.meta, ensure_ascii=False), it.status,
             captured_at or now_iso()),
        )

    # ---- metrics / texts: append (timestamped) ----

    def add_metric(self, m: Metric, captured_at: str | None = None) -> None:
        if m.metric_value is None:
            return  # skip metrics that could not be retrieved rather than inserting null rows
        self.con.execute(
            """INSERT INTO metrics
               (platform, scope, ref_id, metric_name, metric_value, captured_at)
               VALUES (?,?,?,?,?,?)""",
            (m.platform, m.scope, m.ref_id, m.metric_name, float(m.metric_value),
             captured_at or now_iso()),
        )

    def add_metrics(self, ms: list[Metric], captured_at: str | None = None) -> None:
        ts = captured_at or now_iso()
        for m in ms:
            self.add_metric(m, ts)

    def add_text(self, t: Text, captured_at: str | None = None) -> None:
        self.con.execute(
            """INSERT INTO texts
               (platform, scope, ref_id, text_type, author, content, lang,
                extra_json, captured_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (t.platform, t.scope, t.ref_id, t.text_type, t.author, t.content, t.lang,
             json.dumps(t.extra, ensure_ascii=False), captured_at or now_iso()),
        )

    def add_feature(self, platform: str, scope: str, ref_id: str,
                    feature_set: str, feature: dict, source: str) -> None:
        self.con.execute(
            """INSERT INTO features
               (platform, scope, ref_id, feature_set, feature_json, source, analyzed_at)
               VALUES (?,?,?,?,?,?,?)""",
            (platform, scope, ref_id, feature_set,
             json.dumps(feature, ensure_ascii=False), source, now_iso()),
        )

    # ---- utilities ----

    def counts(self) -> dict[str, int]:
        out = {}
        for t in ("entities", "items", "metrics", "texts", "features"):
            out[t] = self.con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        return out

    def close(self) -> None:
        self.con.close()
