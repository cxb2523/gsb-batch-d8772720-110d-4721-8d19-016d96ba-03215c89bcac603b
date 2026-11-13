"""
Structured execution records for the curl_cffi download channel.

Every request handled by CurlCffiDownloadHandler produces one
:class:`DownloadRecord` describing what actually happened on the wire:
which proxy (if any) was used and where it came from, whether redirects
occurred and where the chain landed, the final status code, and whether
the request succeeded or raised.

Records are handed to a pluggable :class:`DownloadRecordCollector`. The
default implementation only logs — crawl results are never changed by
recording. Tests inject :class:`InMemoryDownloadRecordCollector` and read
the records back directly.
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

# Outcome markers stored on DownloadRecord.outcome.
OUTCOME_SUCCESS = "success"
OUTCOME_EXCEPTION = "exception"

# Proxy provenance markers stored on DownloadRecord.proxy_source.
PROXY_SOURCE_META = "request.meta"
PROXY_SOURCE_NONE = "not_configured"


@dataclass
class DownloadRecord:
    """One auditable record per request processed by the curl_cffi handler.

    Fields answer: which request, which proxy (and where it came from),
    how many redirects and the final URL, what status came back, and how
    it ended. On exception, ``exception_type`` carries the exception class
    name and ``status_code`` stays None.
    """

    url: str
    used_proxy: bool
    proxy_source: str
    proxy_url: Optional[str]
    redirected: bool
    redirect_count: int
    final_url: Optional[str]
    status_code: Optional[int]
    outcome: str
    exception_type: Optional[str] = None
    exception_message: Optional[str] = None
    response_class: Optional[str] = None
    extra: dict = field(default_factory=dict)

    @property
    def succeeded(self) -> bool:
        return self.outcome == OUTCOME_SUCCESS

    def to_dict(self) -> dict:
        """Plain-dict view, handy for log lines and JSON serialization."""
        return {
            "url": self.url,
            "used_proxy": self.used_proxy,
            "proxy_source": self.proxy_source,
            "proxy_url": self.proxy_url,
            "redirected": self.redirected,
            "redirect_count": self.redirect_count,
            "final_url": self.final_url,
            "status_code": self.status_code,
            "outcome": self.outcome,
            "exception_type": self.exception_type,
            "exception_message": self.exception_message,
            "response_class": self.response_class,
            "extra": self.extra,
        }


class DownloadRecordCollector(ABC):
    """Accumulates DownloadRecords from the curl_cffi handler.

    Implementations must not alter crawl results; the handler isolates
    collector failures so a broken collector can never fail a download.
    """

    @abstractmethod
    def collect(self, record: DownloadRecord) -> None:
        """Receive one record for a completed or failed request."""


class LoggingDownloadRecordCollector(DownloadRecordCollector):
    """Default collector: emit a single log line per request, nothing else.

    Keeps the channel observable without any side effects on the crawl.
    """

    def collect(self, record: DownloadRecord) -> None:
        if record.outcome == OUTCOME_SUCCESS:
            logger.info(
                "curl_cffi record: url=%s proxy=%s(%s) redirected=%s "
                "redirect_count=%d final_url=%s status=%s response=%s",
                record.url,
                record.used_proxy,
                record.proxy_source,
                record.redirected,
                record.redirect_count,
                record.final_url,
                record.status_code,
                record.response_class,
            )
        else:
            logger.error(
                "curl_cffi record: url=%s proxy=%s(%s) redirected=%s "
                "redirect_count=%d final_url=%s outcome=%s error=%s: %s",
                record.url,
                record.used_proxy,
                record.proxy_source,
                record.redirected,
                record.redirect_count,
                record.final_url,
                record.outcome,
                record.exception_type,
                record.exception_message,
            )


class InMemoryDownloadRecordCollector(DownloadRecordCollector):
    """Collector for tests and short-lived in-process inspection.

    Records accumulate in request order and can be read back directly.
    """

    def __init__(self) -> None:
        self.records: List[DownloadRecord] = []

    def collect(self, record: DownloadRecord) -> None:
        self.records.append(record)

    def clear(self) -> None:
        self.records.clear()

    def last(self) -> Optional[DownloadRecord]:
        return self.records[-1] if self.records else None

    def dicts(self) -> List[dict]:
        return [r.to_dict() for r in self.records]


def build_default_collector() -> DownloadRecordCollector:
    """Factory for the collector used when none is injected."""
    return LoggingDownloadRecordCollector()


def collector_from_crawler(crawler: Any) -> DownloadRecordCollector:
    """Resolve a collector from Scrapy settings, falling back to logging.

    The setting ``CURL_CFFI_RECORD_COLLECTOR`` may hold a dotted import
    path to a no-argument callable (class or factory) returning a
    DownloadRecordCollector. Invalid or missing values fall back to the
    logging default so the crawl can never break on a misconfiguration.
    """
    setting = crawler.settings.get("CURL_CFFI_RECORD_COLLECTOR")
    if not setting:
        return build_default_collector()
    try:
        from scrapy.utils.misc import load_object

        factory = load_object(setting)
        collector = factory()
        if not isinstance(collector, DownloadRecordCollector):
            raise TypeError(
                f"{setting} did not return a DownloadRecordCollector: "
                f"{type(collector)!r}"
            )
        return collector
    except Exception as e:
        logger.error(
            "Failed to load CURL_CFFI_RECORD_COLLECTOR %r, falling back to "
            "logging collector: %s",
            setting,
            e,
        )
        return build_default_collector()
