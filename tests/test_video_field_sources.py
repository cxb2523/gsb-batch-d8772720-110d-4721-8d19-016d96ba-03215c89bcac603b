"""Offline tests for Video HTML fallback layers and per-field provenance.

Every page is a locally built HTML string: nothing here performs network I/O.
The provenance labels live on ``Video`` instances / the parser return value and
must always describe the same parse run that produced the field values.
"""
import pytest
from unittest.mock import AsyncMock, patch

from base_api import BaseCore

from xvideos_api import Video
from xvideos_api.api import (
    FIELD_SOURCE_DOM,
    FIELD_SOURCE_JSON_LD,
    FIELD_SOURCE_MISSING,
    FIELD_SOURCE_SCRIPT,
    TRACKED_HTML_FIELDS,
)


JSON_LD_ONLY_HTML = """
<html><head>
<script type="application/ld+json">
{
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": "JSON LD Only Title",
    "thumbnailUrl": "https://cdn.example.com/ld-thumb.jpg",
    "uploadDate": "2026-10-01T12:00:00+00:00",
    "contentUrl": "https://cdn.example.com/ld-content.mp4",
    "embedUrl": "https://www.xvideos.com/embedframe/ldonly",
    "author": {
        "@type": "Organization",
        "name": "LD Author",
        "url": "https://xvideos.com/channels/ld_author"
    }
}
</script>
</head><body><div id="page"><p>no player markup at all</p></div></body></html>
"""

DOM_ONLY_HTML = """
<html><head>
<meta property="og:image" content="https://cdn.example.com/og-thumb.jpg">
<meta property="article:published_time" content="2026-09-15T06:53:32+00:00">
</head><body>
<h2 class="page-title"><span id="title-auto-tr">DOM Only Title</span></h2>
<div class="video-pic"><img src="https://cdn.example.com/dom-pic-thumb.jpg"></div>
<video><source src="https://cdn.example.com/dom-content.mp4"></video>
<ul>
    <li class="main-uploader">
        <a href="/dom_uploader" class="uploader-tag"><span class="name">DOM Uploader</span></a>
    </li>
</ul>
<input id="copy-video-embed" type="text" readonly="readonly"
       value="&lt;iframe src=&quot;https://www.xvideos.com/embedframe/dom123&quot; frameborder=0&gt;&lt;/iframe&gt;">
</body></html>
"""

SCRIPT_ONLY_HTML = """
<html><body>
<div id="video-player-bg">
<script>
    html5player.setVideoTitle('Script &amp; Only &#039;Title&#039;');
    html5player.setThumbUrl('https://cdn.example.com/script-thumb.jpg');
    html5player.setVideoUrlHigh('https://cdn.example.com/script-high.mp4');
    html5player.setVideoUrlLow('https://cdn.example.com/script-low.mp4');
    html5player.setUploaderName('script_uploader');
    html5player.setEncodedIdVideo('scriptid77');
</script>
</div>
<!-- dispo - Tue, 15 Sep 26 06:53:32 +0000 Loaded ! Video exists and OK. -->
</body></html>
"""

# Every layer populated: the preferred source of each field must win.
ALL_LAYERS_HTML = """
<html><head>
<script type="application/ld+json">
{
    "@type": "VideoObject",
    "name": "LD TITLE",
    "thumbnailUrl": "https://cdn.example.com/ld-thumb.jpg",
    "uploadDate": "2026-10-01T12:00:00+00:00",
    "contentUrl": "https://cdn.example.com/ld-content.mp4",
    "embedUrl": "https://www.xvideos.com/embedframe/ld-embed",
    "author": {"name": "LD Author", "url": "https://xvideos.com/channels/ld_author"}
}
</script>
<meta property="article:published_time" content="2026-09-15T06:53:32+00:00">
</head><body>
<span id="title-auto-tr">DOM TITLE</span>
<div class="video-pic"><img src="https://cdn.example.com/dom-thumb.jpg"></div>
<video><source src="https://cdn.example.com/dom-content.mp4"></video>
<li class="main-uploader">
    <a href="/dom_uploader"><span class="name">DOM Uploader</span></a>
</li>
<input id="copy-video-embed" type="text"
       value="&lt;iframe src=&quot;https://www.xvideos.com/embedframe/dom-embed&quot;&gt;&lt;/iframe&gt;">
<script>
    html5player.setVideoTitle('SCRIPT TITLE');
    html5player.setThumbUrl('https://cdn.example.com/script-thumb.jpg');
    html5player.setVideoUrlHigh('https://cdn.example.com/script-content.mp4');
    html5player.setUploaderName('script_uploader');
    html5player.setEncodedIdVideo('script-embed');
</script>
<!-- dispo - Tue, 15 Sep 26 06:53:32 +0000 Loaded ! -->
</body></html>
"""

# Preferred layer absent for several fields so the middle/fallback ordering
# becomes observable. JSON-LD here deliberately omits date and content values.
PARTIAL_LAYERS_HTML = """
<html><head>
<script type="application/ld+json">
{
    "@type": "VideoObject",
    "name": "LD TITLE",
    "thumbnailUrl": "https://cdn.example.com/ld-thumb.jpg",
    "embedUrl": "https://www.xvideos.com/embedframe/ld-embed",
    "author": {"name": "LD Author", "url": "https://xvideos.com/channels/ld_author"}
}
</script>
</head><body>
<div class="video-pic"><img src="https://cdn.example.com/dom-thumb.jpg"></div>
<time datetime="2026-08-01T00:00:00+00:00">Aug 2026</time>
<video><source src="https://cdn.example.com/dom-content.mp4"></video>
<script>
    html5player.setVideoTitle('SCRIPT TITLE');
    html5player.setThumbUrl('https://cdn.example.com/script-thumb.jpg');
    html5player.setVideoUrlHigh('https://cdn.example.com/script-content.mp4');
    html5player.setUploaderName('script_uploader');
    html5player.setEncodedIdVideo('script-embed');
</script>
<!-- dispo - Tue, 15 Sep 26 06:53:32 +0000 Loaded ! -->
</body></html>
"""

EMPTY_HTML = "<html><body><p>nothing of interest</p></body></html>"


def _parse(html_content):
    return Video._extract_html_with_sources(html_content, "https://www.xvideos.com/video.test/x")


def test_json_ld_only_page_labels_every_field_as_json_ld():
    data, sources = _parse(JSON_LD_ONLY_HTML)

    assert data["title"] == "JSON LD Only Title"
    assert data["thumbnail_url"] == "https://cdn.example.com/ld-thumb.jpg"
    assert data["publish_date"] == "2026-10-01T12:00:00+00:00"
    assert data["content_url"] == "https://cdn.example.com/ld-content.mp4"
    assert data["author_link"] == "https://xvideos.com/channels/ld_author"
    assert data["author_name"] == "LD Author"
    assert data["embed_url"] == "https://www.xvideos.com/embedframe/ldonly"

    assert set(sources) == set(TRACKED_HTML_FIELDS)
    assert all(label == FIELD_SOURCE_JSON_LD for label in sources.values())


def test_dom_only_page_labels_every_field_as_dom():
    data, sources = _parse(DOM_ONLY_HTML)

    assert data["title"] == "DOM Only Title"
    assert data["thumbnail_url"] == "https://cdn.example.com/dom-pic-thumb.jpg"
    assert data["publish_date"] == "2026-09-15T06:53:32+00:00"
    assert data["content_url"] == "https://cdn.example.com/dom-content.mp4"
    assert data["author_link"] == "https://xvideos.com/dom_uploader"
    assert data["author_name"] == "DOM Uploader"
    assert "embedframe/dom123" in data["embed_url"]

    assert all(label == FIELD_SOURCE_DOM for label in sources.values())


def test_script_only_page_labels_every_field_as_script():
    data, sources = _parse(SCRIPT_ONLY_HTML)

    assert data["thumbnail_url"] == "https://cdn.example.com/script-thumb.jpg"
    assert data["publish_date"] == "Tue, 15 Sep 26 06:53:32 +0000"
    assert data["content_url"] == "https://cdn.example.com/script-high.mp4"
    assert data["author_link"] == "https://xvideos.com/script_uploader"
    assert data["author_name"] == "script_uploader"
    assert "embedframe/scriptid77" in data["embed_url"]

    assert all(label == FIELD_SOURCE_SCRIPT for label in sources.values())


def test_script_title_entities_are_unescaped_after_fallback():
    data, sources = _parse(SCRIPT_ONLY_HTML)

    # No DOM title node and no JSON-LD, so the html5player assignment is the
    # fallback that supplies the title; entities must still be decoded.
    assert data["title"] == "Script & Only 'Title'"
    assert sources["title"] == FIELD_SOURCE_SCRIPT


def test_all_layers_present_preferred_source_wins_and_is_not_overridden():
    data, sources = _parse(ALL_LAYERS_HTML)

    # Title / author / embed prefer DOM nodes.
    assert data["title"] == "DOM TITLE"
    assert sources["title"] == FIELD_SOURCE_DOM
    assert data["author_link"] == "https://xvideos.com/dom_uploader"
    assert data["author_name"] == "DOM Uploader"
    assert sources["author_link"] == FIELD_SOURCE_DOM
    assert sources["author_name"] == FIELD_SOURCE_DOM
    assert "embedframe/dom-embed" in data["embed_url"]
    assert sources["embed_url"] == FIELD_SOURCE_DOM

    # Thumbnail / date / content prefer JSON-LD.
    assert data["thumbnail_url"] == "https://cdn.example.com/ld-thumb.jpg"
    assert sources["thumbnail_url"] == FIELD_SOURCE_JSON_LD
    assert data["publish_date"] == "2026-10-01T12:00:00+00:00"
    assert sources["publish_date"] == FIELD_SOURCE_JSON_LD
    assert data["content_url"] == "https://cdn.example.com/ld-content.mp4"
    assert sources["content_url"] == FIELD_SOURCE_JSON_LD


def test_partial_layers_prove_stable_fallback_ordering():
    data, sources = _parse(PARTIAL_LAYERS_HTML)

    # No DOM title node: JSON-LD beats the html5player setter.
    assert data["title"] == "LD TITLE"
    assert sources["title"] == FIELD_SOURCE_JSON_LD
    # JSON-LD thumbnail beats both script and DOM.
    assert data["thumbnail_url"] == "https://cdn.example.com/ld-thumb.jpg"
    assert sources["thumbnail_url"] == FIELD_SOURCE_JSON_LD

    # No JSON-LD date/content: the script layer beats DOM fallbacks.
    assert data["publish_date"] == "Tue, 15 Sep 26 06:53:32 +0000"
    assert sources["publish_date"] == FIELD_SOURCE_SCRIPT
    assert data["content_url"] == "https://cdn.example.com/script-content.mp4"
    assert sources["content_url"] == FIELD_SOURCE_SCRIPT

    # No DOM author/embed nodes: script beats JSON-LD for these fields.
    assert data["author_link"] == "https://xvideos.com/script_uploader"
    assert data["author_name"] == "script_uploader"
    assert sources["author_link"] == FIELD_SOURCE_SCRIPT
    assert sources["author_name"] == FIELD_SOURCE_SCRIPT
    assert "embedframe/script-embed" in data["embed_url"]
    assert sources["embed_url"] == FIELD_SOURCE_SCRIPT


def test_completely_missing_fields_are_marked_missing_without_error():
    data, sources = _parse(EMPTY_HTML)

    for field_name in TRACKED_HTML_FIELDS:
        assert data[field_name] is None
        assert sources[field_name] == FIELD_SOURCE_MISSING

    # Legacy wrapper keeps returning the flat mapping with the original keys.
    legacy = Video._extract_html(EMPTY_HTML)
    assert isinstance(legacy, dict)
    for field_name in TRACKED_HTML_FIELDS:
        assert legacy[field_name] is None
    assert all(not key.startswith("_") for key in legacy)


@pytest.mark.asyncio
async def test_instance_provenance_comes_from_the_single_parse_run():
    core = BaseCore()
    video = Video(url="https://www.xvideos.com/video.test/x", core=core)

    with patch(
        "xvideos_api.api.get_html_content",
        AsyncMock(return_value=SCRIPT_ONLY_HTML),
    ) as mocked_fetch:
        await video.load_sources("html")
        sources_first = await video.get_field_sources()
        sources_second = await video.get_field_sources()

        # The page is fetched exactly once; provenance never triggers a refetch.
        assert mocked_fetch.await_count == 1

    assert sources_first == sources_second
    assert all(label == FIELD_SOURCE_SCRIPT for label in sources_first.values())

    # Values and provenance describe the same parse run.
    assert video.title == "Script & Only 'Title'"
    assert video.author_name == "script_uploader"

    # The returned field mapping keeps its flat structure and original keys:
    # provenance is not nested into it and not exposed via to_dict().
    serialized = video.to_dict()
    assert "_html_field_sources" not in serialized
    assert "title" in serialized and "author_name" in serialized


@pytest.mark.asyncio
async def test_all_missing_page_records_missing_and_loads_only_once():
    core = BaseCore()
    video = Video(url="https://www.xvideos.com/video.test/empty", core=core)

    with patch(
        "xvideos_api.api.get_html_content",
        AsyncMock(return_value=EMPTY_HTML),
    ) as mocked_fetch:
        sources = await video.get_field_sources()
        sources_again = await video.get_field_sources()

        assert mocked_fetch.await_count == 1

    assert sources == sources_again
    assert all(label == FIELD_SOURCE_MISSING for label in sources.values())
    # Values stay None while provenance explicitly says "missing", not "".
    for field_name in TRACKED_HTML_FIELDS:
        assert await video.get_field(field_name) is None
