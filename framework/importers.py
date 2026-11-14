#!/usr/bin/env python3
"""
importers.py — Bring your own data.

The adapters are one way to fill the schema; they are not the only way. If you
already have rows — a MediaCrawler export, a CSV a colleague sent you, whatever —
this module maps them onto the same 5 tables the adapters write to, so the entire
analysis layer works on them unchanged.

    from framework.importers import import_csv, PRESETS
    n = import_csv(store, "xhs_notes.csv", platform="xhs", preset="mediacrawler_xhs")

If your columns don't match a preset, pass an explicit mapping instead:

    import_rows(store, rows, platform="my_platform", mapping=FieldMap(
        item_id="post_id", title="headline",
        metrics={"like_count": "likes", "collect_count": "saves"}))

User identifiers are anonymized on the way in, exactly as the adapters do it —
importing does not become a way to smuggle raw user data into the store.
"""
from __future__ import annotations

import csv
import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import compliance

from .adapter import Entity, Item, Metric, Text


@dataclass
class FieldMap:
    """Which of your columns holds which piece of the schema.

    Only `item_id` is required. Everything else is optional — a row that lacks
    a title or an author still produces a valid item, just a sparser one.
    """
    item_id: str
    title: str = ""
    url: str = ""
    published_at: str = ""
    item_type: str = ""
    author_id: str = ""
    author_name: str = ""
    desc: str = ""
    # metric_name in the schema -> column name in your data
    metrics: dict[str, str] = field(default_factory=dict)
    # extra columns to keep verbatim in items.meta_json
    meta: tuple[str, ...] = ()


# Presets are only added for formats whose field names have been read off the
# producing code, not guessed. Right now that means MediaCrawler's Xiaohongshu
# store (store/xhs/_store_impl.py, add_content) and its Bilibili equivalent.
PRESETS: dict[str, FieldMap] = {
    "mediacrawler_xhs": FieldMap(
        item_id="note_id",
        title="title",
        url="note_url",
        published_at="time",
        item_type="type",
        author_id="creator_hash",
        author_name="nickname",
        desc="desc",
        metrics={
            "like_count": "liked_count",
            "collect_count": "collected_count",
            "comment_count": "comment_count",
            "share_count": "share_count",
        },
        meta=("tag_list", "source_keyword", "video_url"),
    ),
    "mediacrawler_bilibili": FieldMap(
        item_id="video_id",
        title="title",
        url="video_url",
        published_at="create_time",
        author_id="user_id",
        author_name="nickname",
        desc="desc",
        metrics={
            "like_count": "liked_count",
            "view_count": "video_play_count",
            "coin_count": "video_coin_count",
            "collect_count": "video_favorite_count",
            "share_count": "video_share_count",
            "danmaku_count": "video_danmaku",
            "comment_count": "video_comment",
        },
        meta=("source_keyword",),
    ),
}


def _num(v: Any) -> float | None:
    """Best-effort numeric coercion.

    Exports are messy: counts arrive as ints, as '1234', as '1.2万', as '' for
    missing, and occasionally as '暂无'. Anything that isn't a number becomes
    None and the metric is simply not recorded — better a missing row than a
    zero that looks like real data.
    """
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if not isinstance(v, str):
        return None
    s = v.strip().replace(",", "").rstrip("+")
    if not s:
        return None
    for unit, mult in (("亿", 1e8), ("万", 1e4), ("w", 1e4), ("W", 1e4), ("k", 1e3), ("K", 1e3)):
        if s.endswith(unit):
            try:
                return float(s[:-len(unit)]) * mult
            except ValueError:
                return None
    try:
        return float(s)
    except ValueError:
        return None


def _row_to_records(row: dict, fm: FieldMap, platform: str,
                    segment: str, category: str
                    ) -> tuple[Entity | None, Item, list[Metric], list[Text]] | None:
    item_id = str(row.get(fm.item_id) or "").strip()
    if not item_id:
        return None                       # no id, no item — skip rather than invent one

    entity = None
    author_id = ""
    if fm.author_id and row.get(fm.author_id):
        # Same anonymization path the adapters use: the raw id never lands in the store.
        clean = compliance.scrub_user({"user_id": str(row[fm.author_id]),
                                       "nickname": str(row.get(fm.author_name) or "")})
        author_id = clean.get("anon_id", "")
        if author_id:
            entity = Entity(platform=platform, entity_id=author_id, entity_type="author",
                            segment=segment, category=category)

    meta = {k: row[k] for k in fm.meta if k in row and row[k] not in ("", None)}
    item = Item(
        platform=platform, item_id=item_id, entity_id=author_id,
        item_type=str(row.get(fm.item_type) or "") if fm.item_type else "",
        title=str(row.get(fm.title) or "")[:200] if fm.title else "",
        url=str(row.get(fm.url) or "") if fm.url else "",
        published_at=str(row.get(fm.published_at) or "") if fm.published_at else "",
        segment=segment, category=category, meta=meta)

    metrics = []
    for metric_name, column in fm.metrics.items():
        val = _num(row.get(column))
        if val is not None:
            metrics.append(Metric(platform, "item", item_id, metric_name, val))

    texts = []
    if fm.desc:
        desc = str(row.get(fm.desc) or "").strip()
        if desc:
            texts.append(Text(platform, "item", item_id, "desc", desc, author=author_id))

    return entity, item, metrics, texts


def import_rows(store, rows: Iterable[dict], *, platform: str,
                mapping: FieldMap | None = None, preset: str | None = None,
                segment: str = "", category: str = "") -> dict[str, int]:
    """Import already-collected rows into the store. Returns a small tally.

    Either `mapping` or `preset` must be given. Rows without a usable item id
    are skipped and counted, not silently dropped.
    """
    if mapping is None:
        if preset is None:
            raise ValueError("pass either mapping= or preset= "
                             f"(available presets: {', '.join(sorted(PRESETS))})")
        if preset not in PRESETS:
            raise ValueError(f"unknown preset {preset!r}; "
                             f"available: {', '.join(sorted(PRESETS))}")
        mapping = PRESETS[preset]

    tally = {"items": 0, "metrics": 0, "texts": 0, "entities": 0, "skipped": 0}
    seen_entities: set[str] = set()

    for row in rows:
        rec = _row_to_records(row, mapping, platform, segment, category)
        if rec is None:
            tally["skipped"] += 1
            continue
        entity, item, metrics, texts = rec
        if entity is not None and entity.entity_id not in seen_entities:
            store.upsert_entity(entity)
            seen_entities.add(entity.entity_id)
            tally["entities"] += 1
        store.upsert_item(item)
        tally["items"] += 1
        if metrics:
            store.add_metrics(metrics)
            tally["metrics"] += len(metrics)
        for t in texts:
            store.add_text(t)
            tally["texts"] += 1

    return tally


def read_csv(path: str | Path) -> Iterator[dict]:
    """Stream a CSV as dicts. Handles the UTF-8 BOM Excel likes to add."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def read_json(path: str | Path) -> list[dict]:
    """Load a JSON export — either a bare list, or an object wrapping one."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "items", "results", "notes", "list"):
            if isinstance(data.get(key), list):
                return data[key]
    raise ValueError(f"{path}: expected a JSON list of records, or an object containing one")


def import_csv(store, path: str | Path, **kwargs) -> dict[str, int]:
    """Convenience wrapper: read a CSV file and import it. See import_rows."""
    return import_rows(store, read_csv(path), **kwargs)


def import_json(store, path: str | Path, **kwargs) -> dict[str, int]:
    """Convenience wrapper: read a JSON file and import it. See import_rows."""
    return import_rows(store, read_json(path), **kwargs)
