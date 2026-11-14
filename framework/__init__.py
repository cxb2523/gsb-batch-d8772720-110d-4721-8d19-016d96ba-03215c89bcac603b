"""Universal research framework — platform-agnostic foundation.

To add a new platform, see adapters/. All writes go through store.Store. Data contracts are defined in adapter.
"""
from .adapter import Entity, Item, Metric, SourceAdapter, Text
from .store import Store

__all__ = ["SourceAdapter", "Entity", "Item", "Metric", "Text", "Store"]
