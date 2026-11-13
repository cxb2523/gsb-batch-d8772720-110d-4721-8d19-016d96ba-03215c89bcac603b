"""
Scrapy download handler using curl_cffi for TLS fingerprint impersonation.

Bypasses TLS-based bot detection (e.g. derstandard.at) by impersonating a real
Chrome browser at the TLS handshake level — something Scrapy/Twisted cannot do.

Activated via spider setting: CURL_CFFI_ENABLED: true

Every request leaves a structured DownloadRecord (see curl_cffi_records.py)
describing the proxy used and its source, redirect chain end point, status
code and final outcome. Records go through an injectable collector; the
default collector only logs and never changes the crawl result.
"""

import gzip
import logging

from curl_cffi import requests as cffi_requests
from scrapy.http import HtmlResponse, TextResponse, Request
from twisted.internet import threads

from handlers.curl_cffi_records import (
    OUTCOME_EXCEPTION,
    OUTCOME_SUCCESS,
    PROXY_SOURCE_META,
    PROXY_SOURCE_NONE,
    DownloadRecord,
    LoggingDownloadRecordCollector,
    collector_from_crawler,
)

logger = logging.getLogger(__name__)


def proxies_from_request(request):
    """Map Scrapy's request.meta['proxy'] to curl_cffi's proxies dict, or None.

    SmartProxyMiddleware communicates the chosen proxy via request.meta['proxy'];
    curl_cffi needs it as a {scheme: url} dict. Without this the proxy is silently
    dropped on the curl_cffi transport.
    """
    proxy = request.meta.get("proxy")
    if proxy:
        return {"http": proxy, "https": proxy}
    return None


def _redirect_info(response):
    """Extract (redirect_count, final_url, redirected) from a curl_cffi response.

    curl_cffi follows redirects itself (allow_redirects=True) and exposes the
    chain in ``response.history``; ``redirect_count`` is a convenience attribute
    on newer releases. Fall back to the history length when it is missing.
    """
    history = getattr(response, "history", None) or []
    count = getattr(response, "redirect_count", None)
    if not isinstance(count, int) or count < 0:
        count = len(history)
    final_url = getattr(response, "url", None)
    return count, final_url, count > 0


class CurlCffiDownloadHandler:
    """
    Download handler that uses curl_cffi with Chrome TLS impersonation.

    Activated per-spider via: CURL_CFFI_ENABLED: true

    Settings:
    - CURL_CFFI_IMPERSONATE: Chrome version to impersonate (default: 'chrome')
    - CURL_CFFI_TIMEOUT: Request timeout in seconds (default: 30)
    - CURL_CFFI_RECORD_COLLECTOR: optional dotted path to a no-arg callable
      returning a DownloadRecordCollector (default: logging collector)

    A collector can also be injected directly via the constructor — tests
    pass an InMemoryDownloadRecordCollector this way.
    """

    lazy = True

    def __init__(self, settings, crawler=None, record_collector=None):
        self.settings = settings
        self.crawler = crawler
        # Injectable collector; default only logs and never affects results.
        self.record_collector = record_collector or LoggingDownloadRecordCollector()

    @classmethod
    def from_crawler(cls, crawler):
        return cls(
            crawler.settings,
            crawler,
            record_collector=collector_from_crawler(crawler),
        )

    def open(self):
        logger.info("CurlCffiDownloadHandler: Ready (Chrome TLS impersonation)")

    def close(self):
        pass

    def download_request(self, request: Request, spider):
        return threads.deferToThread(self._fetch_sync, request, spider)

    def _emit_record(self, record: DownloadRecord):
        """Hand the record to the collector without letting it break the crawl.

        Recording is observability only: a collector failure is logged and
        swallowed, never propagated to the download path.
        """
        try:
            self.record_collector.collect(record)
        except Exception as e:
            logger.error("curl_cffi record collector failed: %s", e)

    def _fetch_sync(self, request: Request, spider):
        spider_settings = getattr(spider, "custom_settings", {})
        impersonate = spider_settings.get("CURL_CFFI_IMPERSONATE", "chrome")
        timeout = spider_settings.get("CURL_CFFI_TIMEOUT", 30)

        # Build headers from request
        # Scrapy headers have list values — flatten to strings for curl_cffi
        headers = {
            k: (
                v[0]
                if isinstance(v, list) and len(v) == 1
                else (", ".join(v) if isinstance(v, list) else v)
            )
            for k, v in request.headers.to_unicode_dict().items()
        }

        # DEFAULT_REQUEST_HEADERS is set dynamically so DefaultHeadersMiddleware
        # never sees it — inject manually from spider.custom_settings
        default_headers = spider_settings.get("DEFAULT_REQUEST_HEADERS", {})
        for k, v in default_headers.items():
            if k not in headers:
                headers[k] = v

        if "Cookie" in headers:
            logger.debug(f"Cookie header: {headers['Cookie'][:80]}...")
        else:
            logger.debug("No Cookie header for this request")

        # Resolve proxy provenance up front so the record is accurate even
        # when the request later raises.
        proxy_url = request.meta.get("proxy")
        used_proxy = bool(proxy_url)
        proxy_source = PROXY_SOURCE_META if used_proxy else PROXY_SOURCE_NONE
        proxies = proxies_from_request(request)

        record = DownloadRecord(
            url=request.url,
            used_proxy=used_proxy,
            proxy_source=proxy_source,
            proxy_url=proxy_url,
            redirected=False,
            redirect_count=0,
            final_url=None,
            status_code=None,
            outcome=OUTCOME_EXCEPTION,
        )

        try:
            response = cffi_requests.get(
                request.url,
                headers=headers,
                impersonate=impersonate,
                timeout=timeout,
                allow_redirects=True,
                proxies=proxies,
            )

            redirect_count, final_url, redirected = _redirect_info(response)
            record.redirect_count = redirect_count
            record.final_url = final_url
            record.redirected = redirected
            record.status_code = response.status_code

            url_lower = response.url.lower()

            if url_lower.endswith(".gz"):
                # Decompress gzip in handler — Scrapy middlewares expect text responses
                raw = gzip.decompress(response.content)
                resp_headers = {
                    k: v
                    for k, v in response.headers.items()
                    if k.lower()
                    not in ("content-encoding", "transfer-encoding", "content-length")
                }
                logger.debug(
                    f"curl_cffi fetch (gz): {request.url} -> {response.status_code} "
                    f"({len(raw)} bytes decompressed)"
                )
                scrapy_response = TextResponse(
                    url=response.url,
                    status=response.status_code,
                    headers=resp_headers,
                    body=raw,
                    encoding="utf-8",
                    request=request,
                )
            else:
                body = response.text.encode("utf-8")
                # Strip content-encoding — already decoded by curl_cffi
                resp_headers = {
                    k: v
                    for k, v in response.headers.items()
                    if k.lower() not in ("content-encoding", "transfer-encoding")
                }
                logger.debug(
                    f"curl_cffi fetch: {request.url} -> {response.status_code} "
                    f"({len(body)} bytes, final url: {response.url})"
                )
                scrapy_response = HtmlResponse(
                    url=response.url,
                    status=response.status_code,
                    headers=resp_headers,
                    body=body,
                    encoding="utf-8",
                    request=request,
                )

            record.outcome = OUTCOME_SUCCESS
            record.response_class = type(scrapy_response).__name__
            return scrapy_response

        except Exception as e:
            record.exception_type = type(e).__name__
            record.exception_message = str(e)
            logger.error(f"curl_cffi fetch failed for {request.url}: {e}")
            raise
        finally:
            self._emit_record(record)
