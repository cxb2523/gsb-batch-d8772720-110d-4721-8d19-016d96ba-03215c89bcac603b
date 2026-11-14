import type { APIRequestContext } from 'playwright';
import type { CrawlLinkRecord, LinkOutcome } from '../domain/report.js';
import { normalizePageUrl } from '../util/url.js';

const SKIP_EXT = /\.(pdf|zip|rar|7z|gz|dmg|exe|png|jpe?g|gif|webp|avif|svg|mp4|webm|mp3|xml|rss|json|txt|ico|css|js)$/i;

export type RobotsCheck = (path: string) => boolean;

/** robots.txt rules for `User-agent: *` (RFC 9309: `*` wildcards, `$` end anchor, longest match wins, ties allow). */
export async function loadRobots(request: APIRequestContext, origin: string): Promise<RobotsCheck> {
  try {
    const res = await request.get(new URL('/robots.txt', origin).href, { timeout: 10_000, failOnStatusCode: false });
    if (!res.ok()) return () => true;
    return parseRobots(await res.text());
  } catch {
    return () => true;
  }
}

export function parseRobots(text: string): RobotsCheck {
  const rules: { allow: boolean; length: number; re: RegExp }[] = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!lastWasAgent) applies = false;
      applies ||= m[2] === '*';
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (applies && (key === 'allow' || key === 'disallow') && m[2]) {
      const pattern = m[2];
      const anchored = pattern.endsWith('$');
      const body = (anchored ? pattern.slice(0, -1) : pattern)
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      rules.push({ allow: key === 'allow', length: pattern.length, re: new RegExp(`^${body}${anchored ? '$' : ''}`) });
    }
  }
  return (path) => {
    let best: { allow: boolean; length: number } | null = null;
    for (const r of rules) {
      if (!r.re.test(path)) continue;
      if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
    }
    return !best || best.allow;
  };
}

/**
 * Folder a crawl stays in (like `wget --no-parent`): `/au/` → `/au/`,
 * `/au/home` → `/au/`, `/` → whole site.
 */
export function crawlScope(url: string): string {
  const path = new URL(url).pathname;
  return path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1);
}

/**
 * Breadth-first queue of same-origin pages inside the start URL's folder.
 * Every inspected link is written to `links` with the reason it was (or was
 * not) followed, so the clone can explain its crawl afterwards.
 */
export class CrawlQueue {
  private queue: string[] = [];
  private queued = new Set<string>();
  private seen = new Set<string>();
  /** URLs whose links have already been read (captured this run or reused from an earlier one). */
  private read = new Set<string>();
  readonly links: CrawlLinkRecord[] = [];
  allowed: RobotsCheck = () => true;

  constructor(
    start: string,
    public origin: string,
    public scope = '/',
  ) {
    this.push(start);
    this.seen.add(start);
  }

  private push(url: string) {
    this.queue.push(url);
    this.queued.add(url);
  }

  next(): string | undefined {
    const url = this.queue.shift();
    if (url !== undefined) this.queued.delete(url);
    return url;
  }

  /** URLs still waiting in the queue (left uncaptured when the page limit was reached). */
  pending(): string[] {
    return [...this.queue];
  }

  /** Queue a page from an earlier run again so its links are read (its snapshot is reused, not fetched). */
  seed(url: string) {
    if (this.queued.has(url) || this.read.has(url)) return;
    this.seen.add(url);
    this.push(url);
  }

  markSeen(url: string) {
    this.seen.add(url);
  }

  /** This page's links have been read; links back to it are not followed again. */
  markRead(...urls: string[]) {
    for (const url of urls) {
      this.seen.add(url);
      this.read.add(url);
    }
  }

  private record(url: string, outcome: LinkOutcome, foundOn?: string) {
    this.links.push(foundOn === undefined ? { url, outcome } : { url, outcome, foundOn });
  }

  enqueue(links: string[], foundOn?: string) {
    for (const link of links) {
      const n = normalizePageUrl(link);
      if (!n) {
        this.record(link, 'not-a-page', foundOn);
        continue;
      }
      if (this.seen.has(n)) {
        this.record(n, 'duplicate', foundOn);
        continue;
      }
      const u = new URL(n);
      if (u.origin !== this.origin) {
        this.record(n, 'cross-origin', foundOn);
        continue;
      }
      if (!(u.pathname + '/').startsWith(this.scope)) {
        this.record(n, 'outside-scope', foundOn);
        continue;
      }
      if (SKIP_EXT.test(u.pathname)) {
        this.record(n, 'skipped-extension', foundOn);
        continue;
      }
      if (!this.allowed(u.pathname)) {
        this.record(n, 'robots-disallowed', foundOn);
        continue;
      }
      this.seen.add(n);
      this.push(n);
      this.record(n, 'enqueued', foundOn);
    }
  }
}
