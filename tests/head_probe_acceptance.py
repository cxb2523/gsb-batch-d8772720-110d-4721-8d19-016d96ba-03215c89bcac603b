"""Acceptance test for the rate-limited, error-classifying HEAD probe chain.

The production probe path (WebCrawler._head_check_links) is driven against a
fully local fixture site whose single page references:

  * images and external links that answer normally           -> real status
  * a link whose host never resolves (RFC 2606 .invalid TLD) -> dns_not_found
  * a link whose server accepts the connection but never
    answers                                                    -> timeout

Everything runs in-process; no third-party host is contacted. The sandbox's
transparent HTTP proxy would turn NXDOMAIN into a 502, so the crawler session
used here has trust_env disabled (the same way an operator without a system
proxy sees it), which lets the real socket.gaierror reach the classifier.

Checks, matching the acceptance criteria one by one:

  1. normal probes keep their status code, content type and size
  2. the DNS target reports status 0 + error_type dns_not_found, the timeout
     target reports status 0 + error_type timeout, and neither raises into or
     aborts the crawl
  3. with a large delay, consecutive probes are spaced by at least the delay
     (they pass through the same rate limiter as page fetches)
  4. a URL referenced twice is requested only once: the per-crawl cache
     serves the repeat without a second HTTP request

    python tests/head_probe_acceptance.py
"""
import http.server
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.crawler import WebCrawler  # noqa: E402

PORT = int(os.environ.get('HEAD_PROBE_PORT', '8951'))
EXT_PORT = int(os.environ.get('HEAD_PROBE_EXT_PORT', '8952'))
PASSED, FAILED = [], []


def check(name, ok, detail=''):
    (PASSED if ok else FAILED).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' - ' + detail) if detail else ''}")


def html(body):
    return f'<html><head><title>probe fixture</title></head><body>{body}</body></html>'


def png_bytes():
    return b'\x89PNG\r\n\x1a\n' + b'x' * 40


class BlackHoleServer(threading.Thread):
    """Accepts TCP connections but never writes an HTTP response."""

    def __init__(self):
        super().__init__(daemon=True)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self._stop = threading.Event()

    def run(self):
        self.sock.settimeout(0.5)
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            # Hold the connection open without answering until the client's
            # read timeout fires, then close it.
            self._stop.wait(5)
            try:
                conn.close()
            except OSError:
                pass

    def stop(self):
        self._stop.set()
        self.sock.close()


def build_sites(port, ext_port, blackhole_port, dns_host):
    """A main HTTP site plus a second site on another port that plays the
    role of an off-domain host. Both record every request so cache hits can
    be proven by counting hits per URL."""
    hits, ext_hits = [], []
    lock, ext_lock = threading.Lock(), threading.Lock()
    main_routes = {
        '/': html(
            # same-host image, plus an off-host image referenced twice
            '<img src="/logo.png">'
            f'<img src="http://127.0.0.1:{ext_port}/dupe.png">'
            f'<img src="http://127.0.0.1:{ext_port}/dupe.png">'
            # image whose host does not resolve, and one that never answers
            f'<img src="http://{dns_host}/missing.png">'
            # external-style links: normal (listed twice), DNS-dead, timing out
            f'<a href="http://127.0.0.1:{ext_port}/ok-page">ok</a>'
            f'<a href="http://127.0.0.1:{ext_port}/ok-page">ok again</a>'
            f'<a href="http://{dns_host}/dead-link">dns dead</a>'
            f'<a href="http://127.0.0.1:{blackhole_port}/hang">timeout</a>'
        ),
        '/logo.png': png_bytes(),
    }
    ext_routes = {
        '/dupe.png': png_bytes(),
        '/ok-page': '<html><body>ok</body></html>',
    }

    def make_handler(routes, hit_list, hit_lock):
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def _serve(self):
                with hit_lock:
                    hit_list.append(f'{self.command} {self.path}')
                route = routes.get(self.path)
                if route is None:
                    body = b'not found'
                    self.send_response(404)
                    self.send_header('Content-Type', 'text/plain')
                else:
                    body = route.encode() if isinstance(route, str) else route
                    ctype = 'image/png' if self.path.endswith('.png') else 'text/html'
                    self.send_response(200)
                    self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command == 'GET':
                    self.wfile.write(body)

            do_GET = _serve
            do_HEAD = _serve

        return Handler

    main_srv = http.server.ThreadingHTTPServer(
        ('127.0.0.1', port), make_handler(main_routes, hits, lock))
    ext_srv = http.server.ThreadingHTTPServer(
        ('127.0.0.1', ext_port), make_handler(ext_routes, ext_hits, ext_lock))
    threading.Thread(target=main_srv.serve_forever, daemon=True).start()
    threading.Thread(target=ext_srv.serve_forever, daemon=True).start()
    return main_srv, ext_srv, ext_hits, ext_lock


def run_crawl(url, delay, timeout):
    crawler = WebCrawler()
    # Do not inherit the sandbox/OS proxy: a transparent proxy masks DNS and
    # timeout failures as ordinary 502/504 responses, which would defeat the
    # point of classifying the underlying transport error.
    crawler.session.trust_env = False
    crawler.config.update({
        'delay': delay,
        'timeout': timeout,
        'concurrency': 2,
        'max_urls': 50,
        'max_depth': 2,
        'crawl_external': False,
        'crawl_images': False,
        'discover_sitemaps': False,
        'respect_robots': False,
    })
    ok, message = crawler.start_crawl(url)
    assert ok, message
    deadline = time.time() + 180
    while crawler.is_running and time.time() < deadline:
        time.sleep(0.1)
    assert not crawler.is_running, 'crawl did not finish'
    return crawler


def main():
    dns_host = 'nonexistent-probe-target-9q7.invalid'
    blackhole = BlackHoleServer()
    blackhole.start()
    main_srv, ext_srv, ext_hits, ext_lock = build_sites(
        PORT, EXT_PORT, blackhole.port, dns_host)

    dns_url = f'http://{dns_host}/missing.png'
    dns_link_url = f'http://{dns_host}/dead-link'
    timeout_url = f'http://127.0.0.1:{blackhole.port}/hang'
    ok_page = f'http://127.0.0.1:{EXT_PORT}/ok-page'
    dupe_png = f'http://127.0.0.1:{EXT_PORT}/dupe.png'
    logo_png = f'http://127.0.0.1:{PORT}/logo.png'

    try:
        # ---- pass 1: small delay, verify classification and success data ----
        print('\npass 1: error classification and success payloads (delay=0.05)')
        crawler = run_crawl(f'http://127.0.0.1:{PORT}/', delay=0.05, timeout=3)

        links = {l['target_url']: l for l in crawler.link_manager.all_links}
        rows = {r['url']: r for r in crawler.crawl_results}

        check('crawl completed despite dead targets (nothing aborted it)',
              not crawler.is_running and len(crawler.crawl_results) >= 4,
              f'{len(crawler.crawl_results)} rows')

        logo = links.get(logo_png)
        check('normal image: correct status code on the link',
              logo is not None and logo.get('target_status') == 200,
              str(logo and logo.get('target_status')))
        logo_row = rows.get(logo_png)
        check('normal image: synthesized row keeps content type and size',
              logo_row is not None and logo_row.get('content_type') == 'image/png'
              and logo_row.get('size') == len(png_bytes()),
              str(logo_row and (logo_row.get('content_type'), logo_row.get('size'))))
        check('normal image: no error type on a successful probe',
              logo_row is not None and logo_row.get('error_type') is None
              and logo.get('target_error_type') is None)

        ok = links.get(ok_page)
        check('normal external link: correct status code',
              ok is not None and ok.get('target_status') == 200,
              str(ok and ok.get('target_status')))
        ok_row = rows.get(ok_page)
        check('normal external link: row keeps content type, size and no error',
              ok_row is not None and ok_row.get('status_code') == 200
              and ok_row.get('content_type') == 'text/html'
              and ok_row.get('error_type') is None,
              str(ok_row and (ok_row.get('content_type'), ok_row.get('error_type'))))

        dns_link = links.get(dns_link_url)
        check('non-existent domain: status 0 with distinguishable dns_not_found',
              dns_link is not None and dns_link.get('target_status') == 0
              and dns_link.get('target_error_type') == 'dns_not_found',
              str(dns_link and (dns_link.get('target_status'),
                                dns_link.get('target_error_type'))))
        dns_img = links.get(dns_url)
        check('non-existent domain image: same dns_not_found classification',
              dns_img is not None and dns_img.get('target_status') == 0
              and dns_img.get('target_error_type') == 'dns_not_found',
              str(dns_img and dns_img.get('target_error_type')))
        dns_row = rows.get(dns_link_url)
        check('non-existent domain: synthesized row carries the reason',
              dns_row is not None and dns_row.get('status_code') == 0
              and dns_row.get('error_type') == 'dns_not_found'
              and 'DNS' in (dns_row.get('error') or ''),
              str(dns_row and (dns_row.get('error_type'), dns_row.get('error'))))

        hung = links.get(timeout_url)
        check('timing-out address: status 0 with distinguishable timeout',
              hung is not None and hung.get('target_status') == 0
              and hung.get('target_error_type') == 'timeout',
              str(hung and (hung.get('target_status'), hung.get('target_error_type'))))
        hung_row = rows.get(timeout_url)
        check('timing-out address: synthesized row carries the reason',
              hung_row is not None and hung_row.get('error_type') == 'timeout'
              and 'timed out' in (hung_row.get('error') or '').lower(),
              str(hung_row and (hung_row.get('error_type'), hung_row.get('error'))))

        check('the two failure kinds are distinguishable from each other',
              dns_link.get('target_error_type') != hung.get('target_error_type')
              and {dns_link.get('target_error_type'),
                   hung.get('target_error_type')} == {'dns_not_found', 'timeout'})

        # The end-of-crawl broken-link analysis must quote the reason, not a
        # bare "0", so the report distinguishes DNS failures from timeouts.
        from src.core.crawl_analysis import CrawlAnalyzer
        analyzer = CrawlAnalyzer()
        _, issues = analyzer.analyze(
            crawler.crawl_results, crawler.link_manager.all_links,
            sitemap_urls=set(), start_url=f'http://127.0.0.1:{PORT}/')
        broken_ext = ' '.join(i.get('details', '') for i in issues
                              if i.get('issue') == 'Broken External Links')
        check('broken-external issue details name the DNS reason',
              'DNS lookup failed' in broken_ext and dns_link_url in broken_ext,
              broken_ext[:160])
        check('broken-external issue details name the timeout reason',
              'request timed out' in broken_ext and timeout_url in broken_ext,
              broken_ext[:160])

        # probe results are pushed through the same event journal the UI polls
        journaled = {e['data'].get('target_url'): e['data']
                     for e in crawler.event_log._events if e['kind'] == 'link_update'}
        check('classified link updates were pushed to the frontend event stream',
              journaled.get(dns_link_url, {}).get('target_error_type') == 'dns_not_found'
              and journaled.get(timeout_url, {}).get('target_error_type') == 'timeout'
              and journaled.get(ok_page, {}).get('target_status') == 200,
              str(sorted(journaled)))

        # ---- cache dedup: a repeated URL is probed over the wire once ----
        with ext_lock:
            head_hits = [h for h in ext_hits if h.startswith('HEAD ')]
        per_url = {}
        for h in head_hits:
            per_url[h] = per_url.get(h, 0) + 1
        check('duplicated image URL requested only once (cache dedup)',
              per_url.get('HEAD /dupe.png') == 1, str(per_url))
        check('duplicated external link requested only once (cache dedup)',
              per_url.get('HEAD /ok-page') == 1, str(per_url))
        dupe_link = links.get(dupe_png)
        check('both duplicate links still received the cached status',
              dupe_link is not None and dupe_link.get('target_status') == 200
              and crawler._head_status_cache[dupe_png]['status'] == 200)

        # ---- pass 2: large delay, verify shared rate limiting -------------
        print('\npass 2: rate limiting across probes (delay=0.6)')
        # Timestamp the moment each probe's HTTP request is actually sent
        # (not acquire() entry: several probe threads queue on the limiter
        # lock and share one entry timestamp before taking their turns).
        probe_wire_stamps = []
        crawler2 = run_crawl_limited(f'http://127.0.0.1:{PORT}/',
                                     delay=0.6, timeout=3,
                                     stamp_sink=probe_wire_stamps)
        gaps = [b - a for a, b in zip(probe_wire_stamps, probe_wire_stamps[1:])]
        check('every probe sent an HTTP request',
              len(probe_wire_stamps) >= 4, f'{len(probe_wire_stamps)} probe requests')
        check('adjacent probe requests spaced by the configured delay',
              bool(gaps) and min(gaps) >= 0.55,
              f'smallest gap {min(gaps):.3f}s over {len(probe_wire_stamps)} requests'
              if gaps else 'no gaps recorded')
        with ext_lock:
            total_dupe = sum(1 for h in ext_hits if h == 'HEAD /dupe.png')
        check('duplicate stays a single request inside the delayed crawl',
              total_dupe == 2, f'{total_dupe} HEAD /dupe.png across both crawls')
    finally:
        main_srv.shutdown()
        ext_srv.shutdown()
        blackhole.stop()

    print('\n' + '=' * 64)
    print(f'  {len(PASSED)} passed, {len(FAILED)} failed')
    if FAILED:
        print('  failed: ' + ', '.join(FAILED))
        return 1
    return 0


def run_crawl_limited(url, delay, timeout, stamp_sink):
    """Same as run_crawl, but timestamps the wire instant of each probe
    request (after the rate-limiter slot is acquired), proving the probes
    leave the machine at the configured spacing."""
    crawler = WebCrawler()
    crawler.session.trust_env = False
    session = crawler.session
    orig_head, orig_get = session.head, session.get

    def stamped_head(*args, **kwargs):
        stamp_sink.append(time.time())
        return orig_head(*args, **kwargs)

    def stamped_get(*args, **kwargs):
        # Only the probe fallback uses stream=True; page fetches do not.
        if kwargs.get('stream'):
            stamp_sink.append(time.time())
        return orig_get(*args, **kwargs)

    in_probe = {'on': False}
    session.head = lambda *a, **k: (stamped_head(*a, **k) if in_probe['on']
                                    else orig_head(*a, **k))
    session.get = lambda *a, **k: (stamped_get(*a, **k) if in_probe['on']
                                   else orig_get(*a, **k))

    orig_head_check = crawler._head_check_links

    def head_check_with_stamping(links, depth=0, link_check_only=False):
        in_probe['on'] = True
        try:
            return orig_head_check(links, depth, link_check_only)
        finally:
            in_probe['on'] = False

    crawler._head_check_links = head_check_with_stamping
    crawler.config.update({
        'delay': delay,
        'timeout': timeout,
        'concurrency': 1,
        'max_urls': 50,
        'max_depth': 2,
        'crawl_external': False,
        'crawl_images': False,
        'discover_sitemaps': False,
        'respect_robots': False,
    })
    ok, message = crawler.start_crawl(url)
    assert ok, message
    deadline = time.time() + 180
    while crawler.is_running and time.time() < deadline:
        time.sleep(0.1)
    assert not crawler.is_running, 'delayed crawl did not finish'
    return crawler


if __name__ == '__main__':
    sys.exit(main())
