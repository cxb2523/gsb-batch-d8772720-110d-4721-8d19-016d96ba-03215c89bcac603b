import pytest

from ..api import Client


@pytest.mark.asyncio
async def test_all():
    client = Client()
    seen = 0
    async with client.search_videos("test", pages=2) as stream:
        async for page in stream:
            assert page.url in stream.page_urls
            if page.succeeded:
                for video in page.videos:
                    assert isinstance(video.title, str)
                    seen += 1
            else:
                # A failed page is reported, not silently dropped.
                assert page.error is not None
            if seen >= 3:
                # Stopping early must release the underlying stream.
                break
