"""
Unified request URL construction for Letterboxd movie collections.

The three paginated collection models (user lists, watchlists and user films)
previously assembled their filter/sort paths independently, which made it easy
to lose a condition or emit segments in the wrong order. This module exposes a
single construction path (:func:`build_collection_url`) shared by every
collection kind so that filtering and sorting rules live in exactly one place.

Letterboxd collection addresses are path based, e.g.::

    {DOMAIN}/{username}/list/{slug}/decade/1990s/genre/crime/by/rating/
    {DOMAIN}/{username}/watchlist/genre/horror/by/popular/
    {DOMAIN}/{username}/films/rated/4/decade/2010s/by/entry-rating/
"""

import re
from dataclasses import dataclass

from letterboxdpy.constants.project import DOMAIN
from letterboxdpy.utils.utils_url import (
    apply_sort_by_to_url,
    normalize_sort_by,
)

# Supported collection kinds and their fixed path prefix after the username.
COLLECTION_SECTIONS = {
    "list": "list",
    "watchlist": "watchlist",
    "films": "films",
}

_SORT_SEGMENT_RE = re.compile(r"/by/[^/]+/?")
_PAGE_SEGMENT_RE = re.compile(r"/page/\d+/?")


@dataclass(frozen=True)
class CollectionURL:
    """Canonical request address for one filtered/sorted collection."""

    kind: str
    username: str
    slug: str | None
    filters: str
    sort_by: str | None
    base_url: str
    section_path: str

    def __str__(self) -> str:
        return self.base_url


def sanitize_filters(filters: str | None) -> tuple[str, str | None]:
    """
    Normalize a raw filter path supplied as path segments.

    Returns a tuple of ``(clean_filters, embedded_sort)``. Leading/trailing
    slashes, stray ``/page/N/`` pagination segments and any embedded
    ``/by/{sort}/`` segment are removed so that the caller controls sorting
    through the dedicated ``sort_by`` argument instead of having two competing
    join locations.
    """
    if not filters or not isinstance(filters, str):
        return "", None

    clean = filters.strip().strip("/")
    if not clean:
        return "", None

    sort_match = re.search(r"(?:^|/)by/([^/]+)", clean)
    embedded_sort = normalize_sort_by(sort_match.group(1)) if sort_match else None

    clean = _SORT_SEGMENT_RE.sub("/", clean)
    clean = _PAGE_SEGMENT_RE.sub("/", clean)
    clean = re.sub(r"/+", "/", clean).strip("/")
    return clean, embedded_sort


def build_collection_url(
    kind: str,
    username: str,
    filters: str | None = "",
    sort_by: str | None = None,
    slug: str | None = None,
) -> CollectionURL:
    """
    Build the canonical base URL for a filtered/sorted Letterboxd collection.

    Args:
        kind: One of ``"list"``, ``"watchlist"`` or ``"films"``.
        username: Letterboxd account name owning the collection.
        filters: Filter path, e.g. ``"decade/1990s/genre/crime+-comedy"``.
        sort_by: Sort slug such as ``"rating"``; ``None`` keeps default order.
        slug: List slug, required (and only valid) for ``kind="list"``.

    Returns:
        A :class:`CollectionURL` whose ``base_url`` is the page-1 address the
        paginator can extend with ``/page/N/`` segments.

    Raises:
        ValueError: If the collection kind is unknown or a list slug is missing.
    """
    if kind not in COLLECTION_SECTIONS:
        valid = ", ".join(sorted(COLLECTION_SECTIONS))
        raise ValueError(f"Unknown collection kind {kind!r}; expected one of {valid}")
    if kind == "list" and not slug:
        raise ValueError("A list slug is required to build a user list URL")

    clean_filters, embedded_sort = sanitize_filters(filters)
    active_sort = normalize_sort_by(sort_by) or embedded_sort

    if kind == "list":
        section_path = f"/{username}/list/{slug}/"
    else:
        section_path = f"/{username}/{COLLECTION_SECTIONS[kind]}/"

    base_url = f"{DOMAIN}{section_path}"
    if clean_filters:
        base_url = f"{base_url}{clean_filters}/"
    if active_sort:
        base_url = apply_sort_by_to_url(base_url, active_sort)

    return CollectionURL(
        kind=kind,
        username=username,
        slug=slug,
        filters=clean_filters,
        sort_by=active_sort,
        base_url=base_url,
        section_path=section_path,
    )


def build_list_url(
    username: str,
    slug: str,
    filters: str | None = "",
    sort_by: str | None = None,
) -> CollectionURL:
    """Build a user list collection URL via the shared construction path."""
    return build_collection_url(
        "list", username, filters=filters, sort_by=sort_by, slug=slug
    )


def build_watchlist_url(
    username: str,
    filters: str | None = "",
    sort_by: str | None = None,
) -> CollectionURL:
    """Build a watchlist collection URL via the shared construction path."""
    return build_collection_url("watchlist", username, filters=filters, sort_by=sort_by)


def build_user_films_url(
    username: str,
    filters: str | None = "",
    sort_by: str | None = None,
) -> CollectionURL:
    """Build a user films collection URL via the shared construction path."""
    return build_collection_url("films", username, filters=filters, sort_by=sort_by)
