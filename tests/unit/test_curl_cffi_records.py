"""
Unit tests for the curl_cffi download handler's structured execution records.

Every test builds Scrapy requests locally and fakes the curl_cffi response by
patching ``cffi_requests.get`` — no network is ever touched. Coverage:

- proxied request (proxy from request.meta, mapped to curl_cffi proxies dict)
- request without a proxy
- redirect chain (redirect count + final URL on the record)
- .gz response decompression (TextResponse, decoded headers stripped)
- exception propagation with exception type captured on the record
- header expansion incl. DEFAULT_REQUEST_HEADERS and impersonate/timeout
- injectable in-memory collector; default logging collector; collector isolation
"""

import gzip
import logging
from unittest.mock import Mock, patch

import pytest
from curl_cffi.requests.exceptions import RequestException
from scrapy import Request
from scrapy.http import HtmlResponse, TextResponse

from handlers import curl_cffi_handler as handler_module
from handlers.curl_cffi_handler import CurlCffiDownloadHandler
from handlers.curl_cffi_records import (
    OUTCOME_EXCEPTION,
    OUTCOME_SUCCESS,
    PROXY_SOURCE_META,
    PROXY_SOURCE_NONE,
    InMemoryDownloadRecordCollector,
    LoggingDownloadRecordCollector,
)

pytestmark = pytest.mark.unit


class FakeResponse:
    """Minimal stand-in for curl_cffi.requests.Response (no network)."""

    def __init__(
        self,
        url,
        status_code=200,
        text="",
        content=b"",
        headers=None,
        history=None,
        redirect_count=0,
    ):
        self.url = url
        self.status_code = status_code
        self._text = text
        self.content = content
        self.headers = headers if headers is not None else {}
        self.history = history if history is not None else []
        self.redirect_count = redirect_count

    @property
    def text(self):
        return self._text


def _spider(custom_settings=None):
    spider = Mock()
    spider.custom_settings = custom_settings or {}
    return spider


def _handler(collector=None):
    return CurlCffiDownloadHandler(
        settings={}, record_collector=collector or InMemoryDownloadRecordCollector()
    )


class TestProxyHandling:
    def test_proxied_request_records_proxy_from_meta(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request(
            "https://example.com/article",
            meta={"proxy": "http://user:pass@proxy.host:8080"},
        )
        fake = FakeResponse(
            url="https://example.com/article",
            status_code=200,
            text="<html>ok</html>",
            headers={"Content-Encoding": "gzip"},
        )

        with patch.object(
            handler_module.cffi_requests, "get", return_value=fake
        ) as mocked_get:
            response = handler._fetch_sync(request, _spider())

        # Existing semantics: meta['proxy'] is mapped to curl_cffi's dict.
        assert mocked_get.call_args.kwargs["proxies"] == {
            "http": "http://user:pass@proxy.host:8080",
            "https": "http://user:pass@proxy.host:8080",
        }

        record = collector.last()
        assert record.url == "https://example.com/article"
        assert record.used_proxy is True
        assert record.proxy_source == PROXY_SOURCE_META
        assert record.proxy_url == "http://user:pass@proxy.host:8080"
        assert record.outcome == OUTCOME_SUCCESS
        assert record.status_code == 200
        assert record.redirected is False
        assert record.redirect_count == 0
        assert record.final_url == "https://example.com/article"
        assert record.exception_type is None
        assert record.response_class == "HtmlResponse"

        # Response semantics unchanged: HtmlResponse, decoded header stripped.
        assert isinstance(response, HtmlResponse)
        assert response.headers.get("Content-Encoding") is None
        assert response.body == b"<html>ok</html>"

    def test_request_without_proxy_records_not_configured(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request("https://example.com/plain")
        fake = FakeResponse(
            url="https://example.com/plain", status_code=200, text="hi"
        )

        with patch.object(
            handler_module.cffi_requests, "get", return_value=fake
        ) as mocked_get:
            handler._fetch_sync(request, _spider())

        assert mocked_get.call_args.kwargs["proxies"] is None

        record = collector.last()
        assert record.used_proxy is False
        assert record.proxy_source == PROXY_SOURCE_NONE
        assert record.proxy_url is None
        assert record.outcome == OUTCOME_SUCCESS


class TestRedirects:
    def test_redirect_chain_recorded_with_final_url(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request("https://example.com/start")
        hop1 = FakeResponse(url="https://example.com/middle", status_code=302)
        final_fake = FakeResponse(
            url="https://example.com/landing",
            status_code=200,
            text="<html>landing</html>",
            history=[hop1],
            redirect_count=2,
        )

        with patch.object(
            handler_module.cffi_requests, "get", return_value=final_fake
        ):
            response = handler._fetch_sync(request, _spider())

        record = collector.last()
        assert record.redirected is True
        assert record.redirect_count == 2
        assert record.final_url == "https://example.com/landing"
        assert record.outcome == OUTCOME_SUCCESS
        # The Scrapy response is built at the post-redirect URL.
        assert response.url == "https://example.com/landing"

    def test_redirect_count_falls_back_to_history_length(self):
        # Older curl_cffi responses may not expose redirect_count.
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request("https://example.com/start")
        hop1 = FakeResponse(url="https://example.com/middle", status_code=302)
        final_fake = FakeResponse(
            url="https://example.com/landing",
            status_code=200,
            text="done",
            history=[hop1],
        )
        del final_fake.redirect_count

        with patch.object(
            handler_module.cffi_requests, "get", return_value=final_fake
        ):
            handler._fetch_sync(request, _spider())

        record = collector.last()
        assert record.redirected is True
        assert record.redirect_count == 1
        assert record.final_url == "https://example.com/landing"


class TestGzipDecompression:
    def test_gz_response_decompresses_and_strips_decoded_headers(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request("https://example.com/feed.xml.gz")
        payload = b"<feed><item>hello</item></feed>"
        fake = FakeResponse(
            url="https://example.com/feed.xml.gz",
            status_code=200,
            content=gzip.compress(payload),
            headers={
                "Content-Encoding": "gzip",
                "Transfer-Encoding": "chunked",
                "Content-Length": "42",
                "Content-Type": "application/xml",
            },
        )

        with patch.object(
            handler_module.cffi_requests, "get", return_value=fake
        ):
            response = handler._fetch_sync(request, _spider())

        # .gz path returns a TextResponse with the decompressed body.
        assert isinstance(response, TextResponse)
        assert not isinstance(response, HtmlResponse)
        assert response.body == payload
        assert response.headers.get("Content-Encoding") is None
        assert response.headers.get("Transfer-Encoding") is None
        assert response.headers.get("Content-Length") is None
        assert response.headers.get("Content-Type") == b"application/xml"

        record = collector.last()
        assert record.outcome == OUTCOME_SUCCESS
        assert record.response_class == "TextResponse"
        assert record.status_code == 200


class TestExceptions:
    def test_exception_propagates_and_is_recorded_with_type(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request(
            "https://example.com/fail", meta={"proxy": "http://proxy.host:9000"}
        )
        boom = RequestException("connection reset by peer")

        with patch.object(handler_module.cffi_requests, "get", side_effect=boom):
            with pytest.raises(RequestException):
                handler._fetch_sync(request, _spider())

        assert len(collector.records) == 1
        record = collector.last()
        assert record.outcome == OUTCOME_EXCEPTION
        assert record.exception_type == "RequestException"
        assert "connection reset by peer" in record.exception_message
        assert record.status_code is None
        assert record.final_url is None
        assert record.redirected is False
        # Proxy provenance is captured even when the fetch itself fails.
        assert record.used_proxy is True
        assert record.proxy_source == PROXY_SOURCE_META
        assert record.proxy_url == "http://proxy.host:9000"

    def test_generic_exception_type_is_captured(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request("https://example.com/timeout")

        with patch.object(
            handler_module.cffi_requests, "get", side_effect=TimeoutError("slow")
        ):
            with pytest.raises(TimeoutError):
                handler._fetch_sync(request, _spider())

        record = collector.last()
        assert record.outcome == OUTCOME_EXCEPTION
        assert record.exception_type == "TimeoutError"


class TestRequestHeadersAndSettings:
    def test_headers_expanded_with_default_request_headers(self):
        handler = _handler()
        request = Request(
            "https://example.com/",
            headers={"X-Request-Only": "from-request", "Accept": "text/html"},
        )
        spider = _spider(
            {
                "DEFAULT_REQUEST_HEADERS": {
                    "Accept-Language": "en-US",
                    # Request header must win over the default.
                    "Accept": "application/json",
                },
                "CURL_CFFI_IMPERSONATE": "chrome120",
                "CURL_CFFI_TIMEOUT": 15,
            }
        )
        fake = FakeResponse(url="https://example.com/", text="ok")

        with patch.object(
            handler_module.cffi_requests, "get", return_value=fake
        ) as mocked_get:
            handler._fetch_sync(request, spider)

        kwargs = mocked_get.call_args.kwargs
        assert kwargs["headers"]["X-Request-Only"] == "from-request"
        assert kwargs["headers"]["Accept-Language"] == "en-US"
        assert kwargs["headers"]["Accept"] == "text/html"
        assert kwargs["impersonate"] == "chrome120"
        assert kwargs["timeout"] == 15
        assert kwargs["allow_redirects"] is True


class TestCollectorInjection:
    def test_default_collector_only_logs(self, caplog):
        handler = CurlCffiDownloadHandler(settings={})
        assert isinstance(handler.record_collector, LoggingDownloadRecordCollector)

        request = Request("https://example.com/logged")
        fake = FakeResponse(url="https://example.com/logged", text="ok")

        with caplog.at_level(logging.INFO, logger="handlers.curl_cffi_records"):
            with patch.object(
                handler_module.cffi_requests, "get", return_value=fake
            ):
                response = handler._fetch_sync(request, _spider())

        # Default collector changes nothing about the result...
        assert isinstance(response, HtmlResponse)
        # ...but leaves a checkable log line.
        assert any(
            "curl_cffi record" in r.message and "https://example.com/logged" in r.message
            for r in caplog.records
        )

    def test_failing_collector_does_not_break_download(self):
        broken = Mock()
        broken.collect.side_effect = RuntimeError("collector exploded")
        handler = CurlCffiDownloadHandler(settings={}, record_collector=broken)
        request = Request("https://example.com/sturdy")
        fake = FakeResponse(url="https://example.com/sturdy", text="ok")

        with patch.object(
            handler_module.cffi_requests, "get", return_value=fake
        ):
            response = handler._fetch_sync(request, _spider())

        assert isinstance(response, HtmlResponse)
        assert response.body == b"ok"

    def test_collector_receives_one_record_per_request_in_order(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)

        with patch.object(
            handler_module.cffi_requests,
            "get",
            side_effect=[
                FakeResponse(url="https://example.com/a", text="a"),
                FakeResponse(url="https://example.com/b", text="b"),
            ],
        ):
            handler._fetch_sync(Request("https://example.com/a"), _spider())
            handler._fetch_sync(Request("https://example.com/b"), _spider())

        assert [r.url for r in collector.records] == [
            "https://example.com/a",
            "https://example.com/b",
        ]
        assert collector.dicts()[0]["outcome"] == OUTCOME_SUCCESS

    def test_from_crawler_loads_collector_from_setting(self):
        crawler = Mock()
        crawler.settings = {
            "CURL_CFFI_RECORD_COLLECTOR": (
                "handlers.curl_cffi_records.InMemoryDownloadRecordCollector"
            )
        }

        handler = CurlCffiDownloadHandler.from_crawler(crawler)

        assert isinstance(handler.record_collector, InMemoryDownloadRecordCollector)

    def test_from_crawler_without_setting_uses_logging_default(self):
        crawler = Mock()
        crawler.settings = {}

        handler = CurlCffiDownloadHandler.from_crawler(crawler)

        assert isinstance(handler.record_collector, LoggingDownloadRecordCollector)

    def test_from_crawler_falls_back_when_setting_invalid(self, caplog):
        from handlers.curl_cffi_records import collector_from_crawler

        # A callable that loads fine but returns something that is not a
        # collector must fall back to the logging default.
        import sys
        import types

        fake_module = types.ModuleType("fake_collector_module")
        fake_module.make_thing = lambda: object()
        sys.modules["fake_collector_module"] = fake_module
        try:
            crawler = Mock()
            crawler.settings = {
                "CURL_CFFI_RECORD_COLLECTOR": "fake_collector_module.make_thing"
            }

            with caplog.at_level(logging.ERROR, logger="handlers.curl_cffi_records"):
                collector = collector_from_crawler(crawler)
        finally:
            del sys.modules["fake_collector_module"]

        assert isinstance(collector, LoggingDownloadRecordCollector)
        assert any("Failed to load" in r.message for r in caplog.records)

    def test_from_crawler_falls_back_when_import_fails(self, caplog):
        from handlers.curl_cffi_records import collector_from_crawler

        crawler = Mock()
        crawler.settings = {
            "CURL_CFFI_RECORD_COLLECTOR": "no.such.module.Collector"
        }

        with caplog.at_level(logging.ERROR, logger="handlers.curl_cffi_records"):
            collector = collector_from_crawler(crawler)

        assert isinstance(collector, LoggingDownloadRecordCollector)


class TestRecordAndCollectorHelpers:
    def test_record_succeeded_and_to_dict_round_trip(self):
        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request("https://example.com/a")

        with patch.object(
            handler_module.cffi_requests,
            "get",
            side_effect=[
                FakeResponse(url="https://example.com/a", text="a"),
                RequestException("boom"),
            ],
        ):
            handler._fetch_sync(request, _spider())
            with pytest.raises(RequestException):
                handler._fetch_sync(
                    Request("https://example.com/b"), _spider()
                )

        ok_record, bad_record = collector.records
        assert ok_record.succeeded is True
        assert bad_record.succeeded is False

        data = ok_record.to_dict()
        assert data["url"] == "https://example.com/a"
        assert data["used_proxy"] is False
        assert data["proxy_source"] == PROXY_SOURCE_NONE
        assert data["outcome"] == OUTCOME_SUCCESS

        assert collector.last() is bad_record
        collector.clear()
        assert collector.records == []
        assert collector.last() is None
        assert collector.dicts() == []

    def test_logging_collector_logs_exception_records(self, caplog):
        collector = LoggingDownloadRecordCollector()
        handler = CurlCffiDownloadHandler(settings={}, record_collector=collector)

        with patch.object(
            handler_module.cffi_requests,
            "get",
            side_effect=RequestException("kaboom"),
        ):
            with pytest.raises(RequestException):
                handler._fetch_sync(
                    Request("https://example.com/err"), _spider()
                )

        assert any(
            "curl_cffi record" in r.message
            and "RequestException" in r.message
            and r.levelno == logging.ERROR
            for r in caplog.records
        )

    def test_download_request_dispatches_through_thread_pool(self):
        # download_request wraps the sync fetch in deferToThread; drive the
        # deferred's result instead of starting a reactor.
        from twisted.internet import defer

        collector = InMemoryDownloadRecordCollector()
        handler = _handler(collector)
        request = Request("https://example.com/deferred")
        fake = FakeResponse(url="https://example.com/deferred", text="ok")

        with patch.object(
            handler_module.cffi_requests, "get", return_value=fake
        ), patch.object(
            handler_module.threads,
            "deferToThread",
            side_effect=lambda fn, req, spider: defer.succeed(fn(req, spider)),
        ):
            deferred = handler.download_request(request, _spider())
            response = deferred.result

        assert isinstance(response, HtmlResponse)
        assert collector.last().url == "https://example.com/deferred"

    def test_cookie_debug_branch_does_not_affect_record(self, caplog):
        handler = _handler()
        request = Request(
            "https://example.com/",
            headers={"Cookie": "session=abc123"},
        )
        fake = FakeResponse(url="https://example.com/", text="ok")

        with patch.object(
            handler_module.cffi_requests, "get", return_value=fake
        ) as mocked_get:
            handler._fetch_sync(request, _spider())

        assert mocked_get.call_args.kwargs["headers"]["Cookie"] == "session=abc123"

    def test_open_close_lifecycle(self):
        handler = _handler()
        assert handler.open() is None
        assert handler.close() is None
