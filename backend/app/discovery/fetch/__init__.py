"""Transport layer for the discovery pipeline."""

from app.discovery.fetch.proxy import DeadProxyRegistry, ProxySelector, mask_proxy, process_dead_proxies
from app.discovery.fetch.ratelimit import DomainRateLimiter, RateRule, registrable_domain
from app.discovery.fetch.result import FetchResult, classify_http_status, detect_block_signal
from app.discovery.fetch.session import FetchSession, FetchStats, build_proxy_selector

__all__ = [
    "DeadProxyRegistry",
    "DomainRateLimiter",
    "FetchResult",
    "FetchSession",
    "FetchStats",
    "ProxySelector",
    "RateRule",
    "build_proxy_selector",
    "classify_http_status",
    "detect_block_signal",
    "mask_proxy",
    "process_dead_proxies",
    "registrable_domain",
]
