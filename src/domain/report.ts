import type { Viewport } from './snapshot.js';

export type Framework = 'next' | 'astro';
export type Target = 'preview' | Framework;
export type Styling = 'css' | 'tailwind';

/** Why the crawler did (or did not) follow a link it inspected. */
export type LinkOutcome =
  | 'enqueued'
  | 'duplicate'
  | 'cross-origin'
  | 'outside-scope'
  | 'skipped-extension'
  | 'robots-disallowed'
  | 'not-a-page';

/** How a page fared: captured, attempted and skipped, or still queued when the page limit hit. */
export type PageStatus = 'ok' | 'failed' | 'pending';

/** "carried" = reused from an earlier run in the same output directory; "new" = produced by this run. */
export type CrawlRound = 'new' | 'carried';

export interface CrawlLinkRecord {
  /** Normalized URL, or the raw href when it was not a page URL. */
  url: string;
  outcome: LinkOutcome;
  /** URL of the page whose markup contained the link (absent for URLs re-queued from an earlier run). */
  foundOn?: string;
}

export interface CrawlPageRecord {
  /** Final URL after redirects for captured pages; the queued URL otherwise. */
  url: string;
  /** Normalized URL that was put on the queue. */
  requestedUrl?: string;
  /** Clone route, or null while the page has not been captured. */
  route: string | null;
  status: PageStatus;
  /** Capture error for pages skipped with status "failed". */
  reason?: string;
  round: CrawlRound;
}

export interface CrawlSummary {
  pages: { ok: number; new: number; carried: number; failed: number; pending: number };
  links: Record<LinkOutcome, number>;
}

/** Per-link and per-page account of a crawl, so a clone can be audited and resumed. */
export interface CrawlLedger {
  /** Normalized start URL. */
  startUrl: string;
  /** Folder the crawl stays inside (`/` for the whole site). */
  scope: string;
  /** `--pages` limit. */
  maxPages: number;
  links: CrawlLinkRecord[];
  pages: CrawlPageRecord[];
  summary: CrawlSummary;
}

/** dittu.json — written by `clone`, read by `verify` and the MCP server. */
export interface Manifest {
  startUrl: string;
  viewport: Viewport;
  pages: { route: string; url: string }[];
  frameworks: Framework[];
  styling?: Styling;
  /** Crawl ledger. Older manifests and non-crawl clones may omit it. */
  crawl?: CrawlLedger;
  /** "capturing" while a clone is still running (written after each page), "complete" once exported. */
  state?: 'capturing' | 'complete';
  /** 1 on the first clone, incremented every time the same output directory is resumed. */
  runs?: number;
  createdAt?: string;
  updatedAt?: string;
  warnings?: Record<string, string[]>;
  failedAssets?: string[];
}

export function summarizeCrawl(links: CrawlLinkRecord[], pages: CrawlPageRecord[]): CrawlSummary {
  const counts: Record<LinkOutcome, number> = {
    enqueued: 0,
    duplicate: 0,
    'cross-origin': 0,
    'outside-scope': 0,
    'skipped-extension': 0,
    'robots-disallowed': 0,
    'not-a-page': 0,
  };
  for (const link of links) counts[link.outcome]++;
  const ok = pages.filter((p) => p.status === 'ok');
  return {
    pages: {
      ok: ok.length,
      new: ok.filter((p) => p.round === 'new').length,
      carried: ok.filter((p) => p.round === 'carried').length,
      failed: pages.filter((p) => p.status === 'failed').length,
      pending: pages.filter((p) => p.status === 'pending').length,
    },
    links: counts,
  };
}

export interface DiffResult {
  /** 1 − differing pixels / total pixels, over the union of both images. */
  score: number;
  width: number;
  heightA: number;
  heightB: number;
  diffPixels: number;
  /** Worst horizontal bands, to locate where the clone deviates. */
  worstBands: { y: number; height: number; score: number }[];
}

export interface VerifyResult {
  target: Target;
  route: string;
  width: number;
  diff: DiffResult;
  diffImage: string;
}

export interface VerifyReport {
  results: VerifyResult[];
  errors: string[];
}
