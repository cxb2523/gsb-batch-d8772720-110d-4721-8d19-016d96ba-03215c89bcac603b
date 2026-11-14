import pLimit from "p-limit";
import { parseHTML } from "linkedom";
import {
  resolveUrl,
  isValidUrl,
  isSameDomain,
  getUrlKey,
  isContentUrl,
  shouldIncludeUrl,
} from "./utils/url-helpers";
import { fetchRobotsTxt, isUrlAllowed, type RobotsRules } from "./utils/robots-parser";
import { createLogger } from "./utils/logger";
import { scrape } from "./scraper";
import type {
  CrawlOptions,
  CrawlResult,
  CrawlUrl,
  CrawlMetadata,
  CrawlPageOutcome,
  CrawlPageStatus,
} from "./crawl-types";
import type { ScrapeResult, WebsiteScrapeResult } from "./types";

/** Result of attempting to fetch a single page. */
type FetchPageOutcome =
  | {
      ok: true;
      crawlUrl: CrawlUrl;
      html: string;
      scraped?: WebsiteScrapeResult;
      /** Time waited to honour robots.txt crawl-delay before this fetch */
      delayMs: number;
    }
  | {
      ok: false;
      status: "failed" | "timeout";
      reason: string;
      /** Time waited to honour robots.txt crawl-delay before this fetch */
      delayMs: number;
    };

/**
 * Crawler class for discovering and scraping pages concurrently.
 *
 * BFS traversal with concurrent page fetching. Each page is scraped once
 * for both link discovery and content extraction (single pass).
 *
 * Every address that is actually attempted — or explicitly refused by
 * robots.txt or left unprocessed — gets a {@link CrawlPageOutcome} entry in
 * the result's `pageOutcomes`, so failures are never dropped silently.
 */
export class Crawler {
  private options: CrawlOptions;
  private visited: Set<string> = new Set();
  private queue: Array<{ url: string; depth: number }> = [];
  private urls: CrawlUrl[] = [];
  private scrapedPages: WebsiteScrapeResult[] = [];
  private pageOutcomes: CrawlPageOutcome[] = [];
  private logger = createLogger("crawler");
  private robotsRules: RobotsRules | null = null;

  /** Serializes crawl-delay waiting per host (one promise chain per host) */
  private hostDelayChains: Map<string, Promise<number>> = new Map();
  /** Timestamp of the last fetch issued against each host */
  private lastFetchByHost: Map<string, number> = new Map();

  constructor(options: CrawlOptions) {
    this.options = {
      depth: 1,
      maxPages: 20,
      scrape: false,
      delayMs: 200,
      formats: ["markdown", "html"],
      scrapeConcurrency: 3,
      verbose: false,
      showChrome: false,
      ...options,
    };
  }

  /**
   * Start crawling
   */
  async crawl(): Promise<CrawlResult> {
    const startTime = Date.now();
    const maxPages = this.options.maxPages ?? 20;
    const concurrency = this.options.scrapeConcurrency ?? 3;
    const limit = pLimit(concurrency);
    let timedOut = false;

    // Fetch robots.txt rules
    this.robotsRules = await fetchRobotsTxt(this.options.url);
    if (this.robotsRules) {
      this.logger.info("Loaded robots.txt rules");
    }

    // Add seed URL to queue. A seed disallowed by robots.txt is recorded as
    // refused and never enters `urls`.
    if (isUrlAllowed(this.options.url, this.robotsRules)) {
      this.queue.push({ url: this.options.url, depth: 0 });
    } else {
      this.logger.warn(`Seed URL blocked by robots.txt: ${this.options.url}`);
      this.recordOutcome(this.options.url, 0, "robots-blocked", "Blocked by robots.txt");
    }

    // BFS crawl with concurrent fetching
    while (this.queue.length > 0 && this.urls.length < maxPages) {
      if (this.options.timeoutMs && Date.now() - startTime > this.options.timeoutMs) {
        this.logger.warn(`Crawl timed out after ${this.options.timeoutMs}ms`);
        timedOut = true;
        break;
      }

      // Grab a batch of items from the queue (up to concurrency limit)
      const remaining = maxPages - this.urls.length;
      const batchSize = Math.min(this.queue.length, concurrency, remaining);
      const batch: Array<{ url: string; depth: number }> = [];

      while (batch.length < batchSize && this.queue.length > 0) {
        const item = this.queue.shift()!;
        const urlKey = getUrlKey(item.url);
        if (this.visited.has(urlKey)) continue;
        this.visited.add(urlKey);
        batch.push(item);
      }

      if (batch.length === 0) break;

      // Fetch all pages in the batch concurrently
      const results = await Promise.all(
        batch.map((item) =>
          limit(async () => {
            const result = await this.fetchPage(item.url);
            return { item, result };
          })
        )
      );

      // Process results: collect URLs, record outcomes, extract links
      for (const { item, result } of results) {
        if (result.ok) {
          this.recordOutcome(item.url, item.depth, "success", null, result.delayMs);
          this.urls.push(result.crawlUrl);

          // Store scraped content if scrape mode is on
          if (this.options.scrape && result.scraped) {
            this.scrapedPages.push(result.scraped);
          }

          // Extract links for BFS if not at max depth
          if (item.depth < (this.options.depth ?? 1)) {
            const { links, blocked } = this.extractLinks(result.html, item.url, item.depth + 1);
            // Robots-blocked discovered links are recorded as refused and
            // never enter `urls` or the queue.
            for (const blockedLink of blocked) {
              this.recordOutcome(
                blockedLink.url,
                blockedLink.depth,
                "robots-blocked",
                "Blocked by robots.txt"
              );
            }
            this.queue.push(...links);
          }
        } else {
          // Fetch failure (including timeout): record it but keep crawling.
          this.recordOutcome(item.url, item.depth, result.status, result.reason, result.delayMs);
        }
      }
    }

    // Anything still queued was never attempted: record it as unprocessed
    // rather than silently dropping it.
    if (this.queue.length > 0) {
      const reason = timedOut
        ? `Not processed: crawl timed out after ${this.options.timeoutMs}ms`
        : `Not processed: maxPages limit (${maxPages}) reached`;
      for (const item of this.queue) {
        this.recordOutcome(item.url, item.depth, "not-processed", reason, 0);
      }
      this.queue.length = 0;
    }

    const metadata: CrawlMetadata = {
      totalUrls: this.urls.length,
      maxDepth: this.options.depth ?? 1,
      totalDuration: Date.now() - startTime,
      seedUrl: this.options.url,
    };

    // Build scraped result from collected pages
    let scraped: ScrapeResult | undefined;
    if (this.options.scrape && this.scrapedPages.length > 0) {
      scraped = {
        data: this.scrapedPages,
        batchMetadata: {
          totalUrls: this.scrapedPages.length,
          successfulUrls: this.scrapedPages.length,
          failedUrls: 0,
          scrapedAt: new Date().toISOString(),
          totalDuration: Date.now() - startTime,
          errors: [],
        },
      };
    }

    return {
      urls: this.urls,
      scraped,
      metadata,
      pageOutcomes: this.pageOutcomes,
    };
  }

  /**
   * Append a per-page outcome record.
   */
  private recordOutcome(
    url: string,
    depth: number,
    status: CrawlPageStatus,
    reason: string | null,
    delayMs: number = 0
  ): void {
    this.pageOutcomes.push({ url, depth, status, reason, delayMs });
  }

  /**
   * Wait for this host's robots.txt crawl-delay slot.
   *
   * Requests to the same host are serialized through a promise chain so that
   * the gap between two adjacent fetches is at least `crawlDelay`. Returns the
   * number of milliseconds actually waited.
   */
  private async waitForHostSlot(host: string): Promise<number> {
    const crawlDelay = this.robotsRules?.crawlDelay ?? 0;
    if (crawlDelay <= 0) return 0;

    const previous = this.hostDelayChains.get(host) ?? Promise.resolve(0);
    const current = previous.then(async () => {
      const lastFetch = this.lastFetchByHost.get(host);
      let waited = 0;
      if (lastFetch !== undefined) {
        const elapsed = Date.now() - lastFetch;
        if (elapsed < crawlDelay) {
          waited = crawlDelay - elapsed;
          await this.sleep(waited);
        }
      }
      this.lastFetchByHost.set(host, Date.now());
      return waited;
    });
    this.hostDelayChains.set(host, current);
    return current;
  }

  /**
   * Promise-based sleep. An instance method (arrow property) so tests can stub
   * it without touching global timers.
   */
  private sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Fetch a single page. Returns both discovery data (URL, title, raw HTML
   * for link extraction) and scraped content (markdown/html) in one pass.
   *
   * Never throws: any failure is returned as a structured `ok: false`
   * outcome so the crawl can continue and the failure is recorded.
   */
  private async fetchPage(url: string): Promise<FetchPageOutcome> {
    let delayMs = 0;
    try {
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        host = url;
      }
      delayMs = await this.waitForHostSlot(host);

      const formats = this.options.scrape ? this.options.formats || ["markdown", "html"] : [];

      const result = await scrape({
        urls: [url],
        formats,
        onlyMainContent: this.options.scrape ? true : false,
        proxy: this.options.proxy,
        proxyTier: this.options.proxyTier,
        timeoutMs: this.options.timeoutMs,
        verbose: this.options.verbose,
        showChrome: this.options.showChrome,
        playwrightPool: this.options.playwrightPool,
        proxyGate: this.options.proxyGate,
        healthTracker: this.options.healthTracker,
        resolveProxy: this.options.resolveProxy,
        abortSignal: this.options.abortSignal,
      });

      if (result.data.length === 0) {
        const reason = result.batchMetadata.errors?.[0]?.error ?? "No data returned for page";
        this.logger.warn(`[crawler] No data returned for ${url}`);
        const status: "failed" | "timeout" = isTimeoutReason(reason) ? "timeout" : "failed";
        return { ok: false, status, reason, delayMs };
      }

      const page = result.data[0];

      return {
        ok: true,
        crawlUrl: {
          url: page.metadata.baseUrl,
          title: page.metadata.website?.title || "Untitled",
          description: page.metadata.website?.description ?? null,
        },
        html: page.rawHtml,
        scraped: this.options.scrape ? page : undefined,
        delayMs,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[crawler] Failed to fetch ${url}: ${msg}`);
      return {
        ok: false,
        status: isTimeoutError(error) ? "timeout" : "failed",
        reason: msg,
        delayMs,
      };
    }
  }

  /**
   * Extract links from HTML content using DOM parsing.
   *
   * Returns same-domain, content-eligible links that passed every filter.
   * Links disallowed by robots.txt are returned separately in `blocked` so
   * the caller can record them as refused outcomes.
   */
  private extractLinks(
    html: string,
    baseUrl: string,
    depth: number
  ): {
    links: Array<{ url: string; depth: number }>;
    blocked: Array<{ url: string; depth: number }>;
  } {
    const links: Array<{ url: string; depth: number }> = [];
    const blocked: Array<{ url: string; depth: number }> = [];
    const { document } = parseHTML(html);

    document.querySelectorAll("a[href]").forEach((anchor: Element) => {
      const rawHref = anchor.getAttribute("href");
      if (!rawHref) return;

      const href = rawHref.trim();
      if (!href) return;

      // Skip fragment-only links
      if (href.startsWith("#")) return;

      // Skip non-HTTP schemes
      const lowerHref = href.toLowerCase();
      if (
        lowerHref.startsWith("javascript:") ||
        lowerHref.startsWith("mailto:") ||
        lowerHref.startsWith("tel:") ||
        lowerHref.startsWith("data:") ||
        lowerHref.startsWith("blob:") ||
        lowerHref.startsWith("ftp:")
      ) {
        return;
      }

      // Resolve relative URLs
      let resolved = resolveUrl(href, baseUrl);
      if (!resolved || !isValidUrl(resolved)) return;

      // Strip hash fragments
      try {
        const parsed = new URL(resolved);
        parsed.hash = "";
        resolved = parsed.toString();
      } catch {
        return;
      }

      // Same domain only
      if (!isSameDomain(resolved, this.options.url)) return;

      // Content pages only
      if (!isContentUrl(resolved)) return;

      // Include/exclude patterns
      if (!shouldIncludeUrl(resolved, this.options.includePatterns, this.options.excludePatterns))
        return;

      // Deduplication
      const urlKey = getUrlKey(resolved);
      if (this.visited.has(urlKey) || this.queue.some((q) => getUrlKey(q.url) === urlKey)) {
        return;
      }

      // Robots.txt — record refused links separately, do not queue them
      if (!isUrlAllowed(resolved, this.robotsRules)) {
        blocked.push({ url: resolved, depth });
        return;
      }

      links.push({ url: resolved, depth });
    });

    return { links, blocked };
  }
}

/**
 * Determine whether a thrown error represents a timeout.
 */
function isTimeoutError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code === "TIMEOUT") return true;
  }
  if (error instanceof Error) {
    return isTimeoutReason(error.message) || error.name === "TimeoutError";
  }
  return isTimeoutReason(String(error));
}

/**
 * Determine whether an error/reason string describes a timeout.
 */
function isTimeoutReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout");
}

/**
 * Convenience function to crawl a website
 */
export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const crawler = new Crawler(options);
  return crawler.crawl();
}
