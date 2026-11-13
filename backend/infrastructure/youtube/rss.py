"""RSS feed for a channel's recent uploads -- no API key, no quota.

YouTube publishes an Atom feed per channel at a fixed URL. It carries only the
~15 most recent uploads and no view/like counts, so it is a *novelty
detector*, not a stats source: the worker reads it first, diffs against what
is already stored, and only spends YouTube Data API quota on videos it has
never seen before. A channel that publishes more than ~15 videos between two
worker cycles falls back to the existing playlist-based path
(application.collecting.collect_channel) for anything the feed missed --
this module never claims to be a complete replacement for it.

Failure separation matters to the caller (application.collecting):
  * network/HTTP problems surface as the original requests exception out of
    fetch_channel_feed() -- classify_error() tags them "network";
  * anything wrong with the XML itself raises FeedParseError from
    parse_feed_strict() -- tagged "xml_parse".
parse_feed() keeps its historical lenient contract (malformed input -> [])
for callers that only want best-effort entries.
"""
import xml.etree.ElementTree as ET

import requests

FEED_URL = "https://www.youtube.com/feeds/videos.xml"

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
}


class FeedParseError(ValueError):
    """The feed was reached but its body is not a usable Atom document."""


def fetch_channel_feed(channel_id: str, timeout: float = 10.0) -> str:
    """Raw XML. Kept separate from parse_feed() so tests can feed in a fixture
    without touching the network."""
    resp = requests.get(FEED_URL, params={"channel_id": channel_id}, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def parse_feed_strict(xml_text: str) -> list:
    """Like parse_feed(), but raises FeedParseError instead of silently
    returning [] for an empty or malformed body -- so a caller that needs to
    tell "feed broken" apart from "feed legitimately has no entries" can."""
    if not xml_text or not xml_text.strip():
        raise FeedParseError("empty feed body")
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise FeedParseError(f"malformed XML: {e}") from e
    out = []
    for entry in root.findall("atom:entry", _NS):
        video_id_el = entry.find("yt:videoId", _NS)
        video_id = video_id_el.text if video_id_el is not None else None
        if not video_id:
            continue
        channel_id_el = entry.find("yt:channelId", _NS)
        title_el = entry.find("atom:title", _NS)
        published_el = entry.find("atom:published", _NS)
        out.append({
            "videoId": video_id,
            "channelId": channel_id_el.text if channel_id_el is not None else None,
            "title": title_el.text if title_el.text is not None else None,
            "publishedAt": published_el.text if published_el is not None else None,
        })
    return out


def parse_feed(xml_text: str) -> list:
    """-> [{videoId, channelId, title, publishedAt}], newest first (YouTube's
    own feed order). Returns [] for anything malformed instead of raising --
    a feed hiccup for one channel should never take down a worker cycle."""
    try:
        return parse_feed_strict(xml_text)
    except FeedParseError:
        return []


def classify_error(exc: Exception) -> str:
    """Coarse failure tag for per-channel result records.

    "network"   -- the feed could not be fetched (DNS, timeout, connection,
                   HTTP error status); "xml_parse" -- it was fetched but the
                   body is empty or not parseable Atom; "unknown" for
                   anything neither layer recognises."""
    if isinstance(exc, FeedParseError):
        return "xml_parse"
    # requests.exceptions.RequestException covers ConnectionError, Timeout,
    # HTTPError (raise_for_status), URLRequired, SSLError, ...
    if isinstance(exc, requests.exceptions.RequestException):
        return "network"
    return "unknown"


def error_summary(exc: Exception, limit: int = 200) -> str:
    """One-line, length-capped human summary of a feed failure."""
    detail = str(exc)
    if detail:
        return f"{type(exc).__name__}: {detail[:limit]}"
    return type(exc).__name__


def new_video_ids(channel_id: str, known_ids, timeout: float = 10.0) -> list:
    """Video ids present in the channel's feed but not in `known_ids`, oldest
    first -- so a caller that stores them one at a time ends up with a sane
    order in the database."""
    known_ids = set(known_ids or ())
    xml_text = fetch_channel_feed(channel_id, timeout=timeout)
    entries = parse_feed(xml_text)
    fresh = [e["videoId"] for e in entries if e["videoId"] not in known_ids]
    return list(reversed(fresh))
