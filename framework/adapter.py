#!/usr/bin/env python3
"""
adapter.py — Source adapter interface + universal data contract

Core idea:
    The collection layer is decoupled from any specific platform. Each platform
    (YouTube / TikTok / XHS / e-commerce …) provides one class that inherits
    SourceAdapter and translates platform-specific fetch logic into the shared
    Entity / Item / Metric / Text data contract. The persistence layer (store.py)
    is written once and shared by all platforms.

Adding a new platform — 3 steps:
    1. Create framework/adapters/xxx.py
    2. Inherit SourceAdapter; implement fetch_entity + fetch_items (required)
    3. Optionally implement fetch_comments / fetch_transcript (declare in capabilities)

Data source abstraction: maps each platform's raw data to the universal 5-table schema.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field

# ============================================================
# Universal data contract — maps to the 5 tables in schema.sql
# Dataclasses instead of raw dicts: typos in field names raise at construction
# time rather than silently writing to the wrong column.
# ============================================================

@dataclass
class Entity:
    """Channel / account / seller — maps to the entities table."""
    platform: str
    entity_id: str
    entity_type: str                       # channel / account / seller
    name: str = ""
    segment: str = ""                      # language / region / research segment
    category: str = ""                     # content style / category
    profile: dict = field(default_factory=dict)   # platform-specific fields → profile_json
    status: str = "ok"


@dataclass
class Item:
    """Video / post / note / product — maps to the items table."""
    platform: str
    item_id: str
    entity_id: str
    item_type: str                         # video / post / note / product
    title: str = ""
    url: str = ""
    published_at: str = ""
    segment: str = ""
    category: str = ""
    meta: dict = field(default_factory=dict)      # platform-specific fields → meta_json
    status: str = "ok"


@dataclass
class Metric:
    """Any numeric metric — maps to the metrics table (EAV long table, time-series capable)."""
    platform: str
    scope: str                             # entity / item
    ref_id: str
    metric_name: str                       # view_count / like_count / subs …
    metric_value: float


@dataclass
class Text:
    """Comment / transcript / description — maps to the texts table."""
    platform: str
    scope: str                             # entity / item
    ref_id: str
    text_type: str                         # comment / transcript / description
    content: str
    author: str = ""
    lang: str = ""
    extra: dict = field(default_factory=dict)     # likes / timestamps / reply depth → extra_json


# ============================================================
# Adapter abstract base class
# ============================================================

class SourceAdapter(ABC):
    """Base class for all platform adapters.

    platform     : platform identifier written into the platform column of every row
    capabilities : which collection dimensions this adapter supports; the caller
                   checks this before dispatching.
                   Valid values: entities / items / comments / transcript
    """
    platform: str = "unknown"
    capabilities: set[str] = set()

    # ---- required ----

    @abstractmethod
    def fetch_entity(self, seed: dict) -> tuple[Entity, list[Metric]]:
        """Fetch profile + snapshot metrics for a single entity.

        seed: seed dict (must contain at least entity_id / handle; may include segment/category)
        Returns: (Entity, [snapshot metrics for this entity, e.g. subs/video_count])
        On failure, return an Entity with status='error' — do not raise and swallow the whole batch.
        """
        ...

    @abstractmethod
    def fetch_items(self, entity_id: str, limit: int = 20
                    ) -> Iterator[tuple[Item, list[Metric]]]:
        """Fetch items + per-item metrics for an entity (generator — store as you go to save memory).

        Yields: (Item, [metrics for this item, e.g. view/like/comment_count])
        """
        ...

    # ---- optional (not supported by default; override as needed) ----

    def fetch_comments(self, item_id: str, limit: int = 100) -> list[Text]:
        """Fetch comments for an item (text_type='comment')."""
        raise NotImplementedError(f"{self.platform} adapter does not support comment collection")

    def fetch_transcript(self, item_id: str) -> list[Text]:
        """Fetch subtitles / transcript for an item (text_type='transcript')."""
        raise NotImplementedError(f"{self.platform} adapter does not support transcript collection")

    # ---- utilities ----

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities

    def __repr__(self) -> str:
        caps = ",".join(sorted(self.capabilities)) or "none"
        return f"<{type(self).__name__} platform={self.platform} caps=[{caps}]>"
