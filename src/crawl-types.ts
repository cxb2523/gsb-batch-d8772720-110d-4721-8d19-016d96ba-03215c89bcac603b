import type { ScrapeResult, ProxyConfig, ProxyTier } from "./types";

/**
 * Crawl options interface
 */
export interface CrawlOptions {
  /** Single seed URL to start crawling from */
  url: string;

  /** Maximum depth to crawl (default: 1) */
  depth?: number;

  /** Maximum pages to discover (default: 20) */
  maxPages?: number;

  /** Also scrape full content (default: false) */
  scrape?: boolean;

  /** Delay between requests in milliseconds (default: 1000) */
  delayMs?: number;

  /** Total timeout for the entire crawl operation in milliseconds */
  timeoutMs?: number;

  /** URL patterns to include (regex strings) - if set, only matching URLs are crawled */
  includePatterns?: string[];

  /** URL patterns to exclude (regex strings) - matching URLs are skipped */
  excludePatterns?: string[];

  // ============================================================================
  // Scrape options (used when scrape: true)
  // ============================================================================

  /** Output formats for scraped content (default: ['markdown']) */
  formats?: Array<"markdown" | "html">;

  /** Number of URLs to scrape in parallel (default: 2) */
  scrapeConcurrency?: number;

  // ============================================================================
  // Content cleaning options
  // ============================================================================

  /** Remove ads and tracking elements (default: true) */
  removeAds?: boolean;

  /** Remove base64-encoded images to reduce output size (default: true) */
  removeBase64Images?: boolean;

  // ============================================================================
  // Browser options
  // ============================================================================

  /** Proxy configuration */
  proxy?: ProxyConfig;

  /** Proxy tier selection: "standard" (default) or "premium" */
  proxyTier?: ProxyTier;

  /** Custom user agent string */
  userAgent?: string;

  /** Enable verbose logging (default: false) */
  verbose?: boolean;

  /** Show Chrome window (default: false) */
  showChrome?: boolean;

  /** Abort signal for cancelling in-flight crawls */
  abortSignal?: AbortSignal;

  /**
   * Playwright browser pool (internal, provided by ReaderClient).
   * Typed as `unknown` to avoid a type cycle.
   */
  playwrightPool?: unknown;

  /**
   * Per-proxy concurrency gate (internal, provided by ReaderClient).
   *
   * When present, the crawler wraps every fetchPage in `proxyGate.withSlot`
   * the same way the scraper does. Typed as `unknown` to avoid a cycle.
   */
  proxyGate?: unknown;

  /**
   * Per-proxy health tracker (internal, provided by ReaderClient).
   */
  healthTracker?: unknown;

  /**
   * Callback that resolves a proxy URL for a given tier. Provided by
   * ReaderClient. Used per-fetch so escalation works.
   */
  resolveProxy?: (tier: ProxyTier | undefined) => ProxyConfig | undefined;
}

/**
 * Crawl URL result interface
 */
export interface CrawlUrl {
  /** URL of the page */
  url: string;

  /** Page title */
  title: string;

  /** Page description or null if not found */
  description: string | null;
}

/**
 * Final outcome of a single URL the crawler actually attempted.
 */
export type CrawlPageStatus = "success" | "robots-blocked" | "failed" | "timeout" | "not-processed";

/**
 * Per-URL outcome record.
 *
 * Every address the crawler actually attempts (or explicitly refuses to
 * attempt) gets one entry, so callers can see which addresses were not
 * collected and why — nothing is dropped silently.
 */
export interface CrawlPageOutcome {
  /** Address the outcome belongs to */
  url: string;

  /** BFS depth at which the address was queued (seed = 0) */
  depth: number;

  /**
   * How the address ended:
   * - `success`         — fetched successfully, included in `urls`
   * - `robots-blocked`  — disallowed by robots.txt, never fetched, not in `urls`
   * - `failed`          — fetch threw or returned empty data; crawl continued
   * - `timeout`         — fetch failed because of a timeout; crawl continued
   * - `not-processed`   — still queued when the crawl stopped (e.g. maxPages)
   */
  status: CrawlPageStatus;

  /** Human-readable reason text. Present for non-success outcomes, null on success */
  reason: string | null;

  /**
   * Milliseconds the crawler waited before fetching this address to honour a
   * robots.txt crawl-delay (per host). 0 when no waiting was required.
   * Always 0 for addresses that were never fetched.
   */
  delayMs: number;
}

/**
 * Crawl result interface
 */
export interface CrawlResult {
  /** Array of discovered URLs with basic info */
  urls: CrawlUrl[];

  /** Full scrape results (only when scrape: true) */
  scraped?: ScrapeResult;

  /** Crawl operation metadata */
  metadata: CrawlMetadata;

  /**
   * One outcome record per address actually attempted or explicitly skipped.
   * Recorded in the order the addresses were handled. `urls`, `scraped` and
   * `metadata` keep their original meaning.
   */
  pageOutcomes: CrawlPageOutcome[];
}

/**
 * Crawl metadata interface
 */
export interface CrawlMetadata {
  /** Total URLs discovered */
  totalUrls: number;

  /** Maximum depth reached */
  maxDepth: number;

  /** Total crawl duration in milliseconds */
  totalDuration: number;

  /** Seed URL that started the crawl */
  seedUrl: string;
}
