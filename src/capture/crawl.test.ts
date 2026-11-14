import { describe, expect, it } from 'vitest';
import { CrawlQueue, crawlScope, parseRobots } from './crawl.js';

describe('robots.txt', () => {
  it('applies the * group with longest-match precedence', () => {
    const allowed = parseRobots(
      `User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\nAllow: /admin/public\n`,
    );
    expect(allowed('/')).toBe(true);
    expect(allowed('/admin/users')).toBe(false);
    expect(allowed('/admin/public/page')).toBe(true);
  });
});

describe('crawl queue', () => {
  it('keeps same-origin pages once and skips files', () => {
    const q = new CrawlQueue('https://x.com/', 'https://x.com');
    q.enqueue([
      'https://x.com/about',
      'https://x.com/about/#team',
      'https://y.com/',
      'https://x.com/logo.png',
      'https://x.com/',
    ]);
    expect([q.next(), q.next(), q.next()]).toEqual(['https://x.com/', 'https://x.com/about', undefined]);
  });
});

describe('robots.txt wildcards', () => {
  it('supports * and $ (RFC 9309)', () => {
    const allowed = parseRobots(
      `User-agent: *\nDisallow: /*/copy-task/\nDisallow: */post-task/\nDisallow: /*.pdf$\nAllow: /tasks/ok/\nDisallow: /tasks/\n`,
    );
    expect(allowed('/au/copy-task/1')).toBe(false);
    expect(allowed('/au/x/post-task/')).toBe(false);
    expect(allowed('/files/a.pdf')).toBe(false);
    expect(allowed('/files/a.pdf/view')).toBe(true);
    expect(allowed('/tasks/ok/1')).toBe(true);
    expect(allowed('/tasks/other')).toBe(false);
    expect(allowed('/au/services/')).toBe(true);
  });
});

describe('crawl scope', () => {
  it('stays inside the start folder', () => {
    expect(crawlScope('https://x.com/au/')).toBe('/au/');
    expect(crawlScope('https://x.com/home')).toBe('/');
    expect(crawlScope('https://x.com')).toBe('/');
    const q = new CrawlQueue('https://x.com/au', 'https://x.com', '/au/');
    q.enqueue(['https://x.com/au/cleaning', 'https://x.com/us/cleaning', 'https://x.com/about']);
    expect([q.next(), q.next(), q.next()]).toEqual(['https://x.com/au', 'https://x.com/au/cleaning', undefined]);
  });
});

describe('crawl ledger', () => {
  it('records why every inspected link was or was not followed', () => {
    const q = new CrawlQueue('https://x.com/docs/', 'https://x.com', '/docs/');
    q.enqueue(
      [
        'https://x.com/docs/about',
        'https://x.com/docs/about', // duplicate of a link already queued
        'https://y.com/other',
        'https://x.com/blog/post',
        'https://x.com/docs/photo.jpg',
        'javascript:void(0)',
      ],
      'https://x.com/docs/',
    );
    expect(q.links).toEqual([
      { url: 'https://x.com/docs/about', outcome: 'enqueued', foundOn: 'https://x.com/docs/' },
      { url: 'https://x.com/docs/about', outcome: 'duplicate', foundOn: 'https://x.com/docs/' },
      { url: 'https://y.com/other', outcome: 'cross-origin', foundOn: 'https://x.com/docs/' },
      { url: 'https://x.com/blog/post', outcome: 'outside-scope', foundOn: 'https://x.com/docs/' },
      { url: 'https://x.com/docs/photo.jpg', outcome: 'skipped-extension', foundOn: 'https://x.com/docs/' },
      { url: 'javascript:void(0)', outcome: 'not-a-page', foundOn: 'https://x.com/docs/' },
    ]);
  });

  it('records robots.txt refusals and reports what is still queued', () => {
    const q = new CrawlQueue('https://x.com/', 'https://x.com');
    q.allowed = (path) => path !== '/private';
    q.enqueue(['https://x.com/private', 'https://x.com/public', 'https://x.com/later'], 'https://x.com/');
    expect(q.links.map((l) => l.outcome)).toEqual(['robots-disallowed', 'enqueued', 'enqueued']);
    expect(q.next()).toBe('https://x.com/');
    expect(q.pending()).toEqual(['https://x.com/public', 'https://x.com/later']);
  });

  it('treats a URL whose links were read as a duplicate of the start page', () => {
    const q = new CrawlQueue('https://x.com/', 'https://x.com');
    q.markRead('https://x.com/');
    q.enqueue(['https://x.com/', 'https://x.com/'], 'https://x.com/');
    expect(q.links.map((l) => l.outcome)).toEqual(['duplicate', 'duplicate']);
  });

  it('queues a page from an earlier run again without fetching it', () => {
    const q = new CrawlQueue('https://x.com/a', 'https://x.com');
    q.markRead('https://x.com/');
    q.markSeen('https://x.com/a');
    q.seed('https://x.com/a');
    expect(q.next()).toBe('https://x.com/a');
  });
});
