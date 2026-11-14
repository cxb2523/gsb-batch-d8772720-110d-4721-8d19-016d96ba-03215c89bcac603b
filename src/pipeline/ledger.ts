import type { CrawlLedger, CrawlLinkRecord, CrawlPageRecord, LinkOutcome } from '../domain/report.js';
import { summarizeCrawl } from '../domain/report.js';

const OUTCOMES: LinkOutcome[] = [
  'enqueued',
  'duplicate',
  'cross-origin',
  'outside-scope',
  'skipped-extension',
  'robots-disallowed',
  'not-a-page',
];

export interface LedgerInput {
  startUrl: string;
  scope: string;
  maxPages: number;
  links: CrawlLinkRecord[];
  pages: CrawlPageRecord[];
}

/** Stable ordering so consecutive runs of the same site produce comparable ledgers. */
export function buildLedger(input: LedgerInput): CrawlLedger {
  const links = input.links.toSorted(
    (a, b) =>
      a.url.localeCompare(b.url) ||
      OUTCOMES.indexOf(a.outcome) - OUTCOMES.indexOf(b.outcome) ||
      (a.foundOn ?? '').localeCompare(b.foundOn ?? ''),
  );
  const pages = input.pages.toSorted((a, b) => (a.route ?? a.url).localeCompare(b.route ?? b.url));
  return {
    startUrl: input.startUrl,
    scope: input.scope,
    maxPages: input.maxPages,
    links,
    pages,
    summary: summarizeCrawl(links, pages),
  };
}

/** One short line per outcome, for the clone log. */
export function describeCrawl(ledger: CrawlLedger): string[] {
  const { pages, links } = ledger.summary;
  const out = [`${pages.ok} page(s) captured: ${pages.new} new, ${pages.carried} reused`];
  if (pages.failed) out.push(`${pages.failed} page(s) failed`);
  if (pages.pending) out.push(`${pages.pending} link(s) left uncaptured at the --pages limit`);
  const followed = links.enqueued;
  if (followed || links.duplicate) out.push(`${followed} followed, ${links.duplicate} duplicate link(s) skipped`);
  const filtered: string[] = [];
  if (links['cross-origin']) filtered.push(`${links['cross-origin']} cross-origin`);
  if (links['outside-scope']) filtered.push(`${links['outside-scope']} outside the folder`);
  if (links['skipped-extension']) filtered.push(`${links['skipped-extension']} file(s)`);
  if (links['robots-disallowed']) filtered.push(`${links['robots-disallowed']} robots.txt`);
  if (links['not-a-page']) filtered.push(`${links['not-a-page']} not a page URL`);
  if (filtered.length) out.push(`skipped: ${filtered.join(', ')}`);
  return out;
}
