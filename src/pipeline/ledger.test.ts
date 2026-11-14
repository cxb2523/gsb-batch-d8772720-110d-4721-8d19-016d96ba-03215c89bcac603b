import { describe, expect, it } from 'vitest';
import { buildLedger, describeCrawl } from './ledger.js';
import type { CrawlLinkRecord, CrawlPageRecord } from '../domain/report.js';

const link = (url: string, outcome: CrawlLinkRecord['outcome'], foundOn = 'https://x.com/'): CrawlLinkRecord => ({
  url,
  outcome,
  foundOn,
});

describe('crawl ledger', () => {
  it('counts outcomes and page states, and reports new vs carried pages', () => {
    const links = [
      link('https://x.com/about', 'enqueued'),
      link('https://y.com/', 'cross-origin'),
      link('https://x.com/about', 'duplicate'),
      link('https://x.com/a.pdf', 'skipped-extension'),
      link('https://x.com/private', 'robots-disallowed'),
      link('https://x.com/out/', 'outside-scope'),
      link('mailto:a@b.c', 'not-a-page'),
    ];
    const pages: CrawlPageRecord[] = [
      { url: 'https://x.com/', route: '/', status: 'ok', round: 'carried' },
      { url: 'https://x.com/about', route: '/about', status: 'ok', round: 'new' },
      { url: 'https://x.com/broken', route: null, status: 'failed', round: 'new', reason: 'net::ERR_FAILED' },
      { url: 'https://x.com/later', route: null, status: 'pending', round: 'new' },
    ];
    const ledger = buildLedger({ startUrl: 'https://x.com/', scope: '/', maxPages: 2, links, pages });

    expect(ledger.summary).toEqual({
      pages: { ok: 2, new: 1, carried: 1, failed: 1, pending: 1 },
      links: {
        enqueued: 1,
        duplicate: 1,
        'cross-origin': 1,
        'outside-scope': 1,
        'skipped-extension': 1,
        'robots-disallowed': 1,
        'not-a-page': 1,
      },
    });
    expect(ledger.maxPages).toBe(2);
    // stable order: links by URL, pages by route
    expect(ledger.links.map((l) => l.url)).toEqual(ledger.links.map((l) => l.url).toSorted());
    expect(ledger.pages.map((p) => p.route ?? p.url)).toEqual([
      '/',
      '/about',
      'https://x.com/broken',
      'https://x.com/later',
    ]);
  });

  it('describes a crawl in one line per outcome', () => {
    const ledger = buildLedger({
      startUrl: 'https://x.com/',
      scope: '/',
      maxPages: 1,
      links: [link('https://y.com/', 'cross-origin'), link('https://x.com/about', 'enqueued')],
      pages: [
        { url: 'https://x.com/', route: '/', status: 'ok', round: 'new' },
        { url: 'https://x.com/about', route: null, status: 'pending', round: 'new' },
      ],
    });
    const lines = describeCrawl(ledger).join('\n');
    expect(lines).toContain('1 page(s) captured: 1 new, 0 reused');
    expect(lines).toContain('1 link(s) left uncaptured at the --pages limit');
    expect(lines).toContain('1 followed, 0 duplicate');
    expect(lines).toContain('1 cross-origin');
  });
});
