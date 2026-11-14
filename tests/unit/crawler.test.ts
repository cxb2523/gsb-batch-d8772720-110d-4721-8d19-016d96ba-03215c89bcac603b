/**
 * Crawler Tests
 *
 * Tests link extraction, depth limiting, maxPages cap, URL dedup,
 * same-domain filtering, and robots.txt compliance. We mock fetchPage
 * and fetchRobotsTxt to avoid needing a live browser or network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crawler } from "../../src/crawler";
import type { IBrowserPool } from "../../src/browser/types";
import type { CrawlPageOutcome, CrawlPageStatus, CrawlResult } from "../../src/crawl-types";
import * as robotsParser from "../../src/utils/robots-parser";

// ── Mock robots parser (no network) ──────────────────────────────────────────

vi.mock("../../src/utils/robots-parser", () => ({
  fetchRobotsTxt: vi.fn().mockResolvedValue(null), // no robots.txt by default
  isUrlAllowed: vi.fn().mockReturnValue(true),
}));

vi.mock("../../src/utils/rate-limiter", () => ({
  rateLimit: vi.fn().mockResolvedValue(undefined), // skip delays in tests
}));

// ── Mock scraper (no real browser/network). Behaviour is driven per test. ─────

const scrapeMock = vi.fn();

vi.mock("../../src/scraper", () => ({
  scrape: (...args: unknown[]) => scrapeMock(...args),
}));

/** Build a minimal successful ScrapeResult for the crawler's fetchPage */
function scrapeDataFor(url: string) {
  return {
    data: [
      {
        rawHtml: makeHtml([]),
        metadata: {
          baseUrl: url,
          website: { title: "Test Page", description: null },
        },
      },
    ],
    batchMetadata: { totalUrls: 1, successfulUrls: 1, failedUrls: 0, errors: [] },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock pool that satisfies the constructor check */
function mockPool(): IBrowserPool {
  return {
    withBrowser: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({ size: 1, active: 0, idle: 1, pending: 0 }),
    isReady: vi.fn().mockReturnValue(true),
  } as unknown as IBrowserPool;
}

/** Mock fetchPage result shapes (mirrors the private FetchPageOutcome union) */
type MockFetchResult =
  | {
      ok: true;
      crawlUrl: { url: string; title: string; description: string | null };
      html: string;
      delayMs?: number;
    }
  | {
      ok: false;
      status: "failed" | "timeout";
      reason: string;
      delayMs?: number;
    };

/**
 * Create a Crawler with mocked fetchPage. Returns the crawler and the
 * fetchPage mock so tests can control what each page returns.
 */
function createTestCrawler(options: {
  url: string;
  depth?: number;
  maxPages?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
}) {
  const crawler = new Crawler({
    url: options.url,
    depth: options.depth ?? 1,
    maxPages: options.maxPages ?? 20,
    delayMs: 0, // no delay in tests
    pool: mockPool(),
    includePatterns: options.includePatterns,
    excludePatterns: options.excludePatterns,
  });

  // Suppress log noise
  (crawler as any).logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const fetchPageMock = vi.fn<[string], Promise<MockFetchResult>>();
  (crawler as any).fetchPage = fetchPageMock;

  return { crawler, fetchPageMock };
}

/** Build a simple HTML page with links */
function makeHtml(links: string[], title = "Test Page"): string {
  const anchors = links.map((href) => `<a href="${href}">Link</a>`).join("\n");
  return `<html><head><title>${title}</title></head><body>${anchors}</body></html>`;
}

/** Build a successful fetchPage result */
function pageResult(url: string, html: string, title = "Test Page"): MockFetchResult {
  return {
    ok: true,
    crawlUrl: { url, title, description: null },
    html,
    delayMs: 0,
  };
}

/** Build a failed fetchPage result (fetch threw or returned empty data) */
function failedResult(reason = "boom"): MockFetchResult {
  return { ok: false, status: "failed", reason, delayMs: 0 };
}

/** Find the outcome for a URL */
function outcomeFor(result: CrawlResult, url: string): CrawlPageOutcome {
  const outcome = result.pageOutcomes.find((o) => o.url === url);
  expect(outcome, `expected a pageOutcome entry for ${url}`).toBeDefined();
  return outcome!;
}

/** Assert the recorded status of a URL */
function expectStatus(result: CrawlResult, url: string, status: CrawlPageStatus) {
  expect(outcomeFor(result, url).status).toBe(status);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Crawler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scrapeMock.mockReset();
  });

  describe("constructor", () => {
    it("defaults depth=1, maxPages=20", () => {
      const crawler = new Crawler({ url: "https://example.com" });
      expect((crawler as any).options.depth).toBe(1);
      expect((crawler as any).options.maxPages).toBe(20);
    });
  });

  describe("link extraction", () => {
    it("extracts same-domain absolute links", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock
        .mockResolvedValueOnce(
          pageResult(
            "https://example.com",
            makeHtml([
              "https://example.com/page1",
              "https://example.com/page2",
              "https://other.com/external", // different domain
            ])
          )
        )
        .mockResolvedValueOnce(pageResult("https://example.com/page1", makeHtml([])))
        .mockResolvedValueOnce(pageResult("https://example.com/page2", makeHtml([])));

      const result = await crawler.crawl();
      // Seed + 2 same-domain links (external filtered)
      expect(result.urls).toHaveLength(3);
      expect(result.urls.map((u) => u.url)).toContain("https://example.com/page1");
      expect(result.urls.map((u) => u.url)).toContain("https://example.com/page2");
    });

    it("resolves relative URLs against the page base URL", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock
        .mockResolvedValueOnce(
          pageResult("https://example.com", makeHtml(["/about", "./contact", "blog/post1"]))
        )
        .mockResolvedValueOnce(pageResult("https://example.com/about", makeHtml([])))
        .mockResolvedValueOnce(pageResult("https://example.com/contact", makeHtml([])))
        .mockResolvedValueOnce(pageResult("https://example.com/blog/post1", makeHtml([])));

      const result = await crawler.crawl();
      const urls = result.urls.map((u) => u.url);
      expect(urls).toContain("https://example.com/about");
      expect(urls).toContain("https://example.com/contact");
    });

    it("skips fragment-only links", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml(["#section1", "#top", "https://example.com/real-page"])
        )
      );
      fetchPageMock.mockResolvedValueOnce(
        pageResult("https://example.com/real-page", makeHtml([]))
      );

      const result = await crawler.crawl();
      expect(result.urls).toHaveLength(2); // seed + real-page, not fragments
    });

    it("skips non-HTTP schemes (mailto, javascript, tel, etc.)", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml([
            "mailto:test@example.com",
            "javascript:void(0)",
            "tel:+1234567890",
            "data:text/html,hello",
            "ftp://files.example.com/file",
            "https://example.com/valid",
          ])
        )
      );
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/valid", makeHtml([])));

      const result = await crawler.crawl();
      expect(result.urls).toHaveLength(2); // seed + valid
    });

    it("strips hash fragments from discovered URLs", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock
        .mockResolvedValueOnce(
          pageResult("https://example.com", makeHtml(["https://example.com/page#section1"]))
        )
        .mockResolvedValueOnce(pageResult("https://example.com/page", makeHtml([])));

      const result = await crawler.crawl();
      expect(result.urls[1].url).toBe("https://example.com/page");
    });
  });

  describe("depth limiting", () => {
    it("does not extract links when at max depth", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      // depth=0 (seed) → links extracted at depth=1
      fetchPageMock.mockResolvedValueOnce(
        pageResult("https://example.com", makeHtml(["https://example.com/level1"]))
      );
      // depth=1 → at max depth, links NOT extracted (even though page has them)
      fetchPageMock.mockResolvedValueOnce(
        pageResult("https://example.com/level1", makeHtml(["https://example.com/level2"]))
      );

      const result = await crawler.crawl();
      expect(result.urls).toHaveLength(2); // seed + level1, NOT level2
      expect(result.urls.map((u) => u.url)).not.toContain("https://example.com/level2");
    });

    it("crawls deeper with depth=2", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 2,
      });

      fetchPageMock
        .mockResolvedValueOnce(
          pageResult("https://example.com", makeHtml(["https://example.com/a"]))
        )
        .mockResolvedValueOnce(
          pageResult("https://example.com/a", makeHtml(["https://example.com/a/b"]))
        )
        .mockResolvedValueOnce(
          pageResult(
            "https://example.com/a/b",
            makeHtml(["https://example.com/a/b/c"]) // depth=2, at max, won't extract
          )
        );

      const result = await crawler.crawl();
      expect(result.urls).toHaveLength(3); // seed + a + a/b
      expect(result.urls.map((u) => u.url)).not.toContain("https://example.com/a/b/c");
    });
  });

  describe("maxPages cap", () => {
    it("stops after reaching maxPages", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
        maxPages: 3,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml([
            "https://example.com/p1",
            "https://example.com/p2",
            "https://example.com/p3",
            "https://example.com/p4",
            "https://example.com/p5",
          ])
        )
      );
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/p1", makeHtml([])));
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/p2", makeHtml([])));
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/p3", makeHtml([])));
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/p4", makeHtml([])));

      const result = await crawler.crawl();
      expect(result.urls).toHaveLength(3); // capped at maxPages
    });
  });

  describe("URL deduplication", () => {
    it("does not visit the same URL twice", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml([
            "https://example.com/page",
            "https://example.com/page", // duplicate
            "https://example.com/page", // duplicate
          ])
        )
      );
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/page", makeHtml([])));

      const result = await crawler.crawl();
      expect(result.urls).toHaveLength(2); // seed + page (not 4)
      expect(fetchPageMock).toHaveBeenCalledTimes(2); // only fetched twice
    });
  });

  describe("failed pages", () => {
    it("continues crawling when fetchPage returns a failure", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml(["https://example.com/broken", "https://example.com/ok"])
        )
      );
      fetchPageMock.mockResolvedValueOnce(failedResult("connection reset")); // broken page
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/ok", makeHtml([])));

      const result = await crawler.crawl();
      // seed + ok (broken didn't add to urls)
      expect(result.urls).toHaveLength(2);
      expect(result.urls.map((u) => u.url)).toContain("https://example.com/ok");

      // The failure is still recorded as a per-page outcome with its reason
      const broken = outcomeFor(result, "https://example.com/broken");
      expect(broken.status).toBe("failed");
      expect(broken.reason).toContain("connection reset");
      expect(broken.depth).toBe(1);
    });
  });

  describe("metadata", () => {
    it("returns correct metadata with seed URL and duration", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
        maxPages: 5,
      });

      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com", makeHtml([])));

      const result = await crawler.crawl();
      expect(result.metadata.seedUrl).toBe("https://example.com");
      expect(result.metadata.maxDepth).toBe(1);
      expect(result.metadata.totalUrls).toBe(1);
      expect(result.metadata.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("include/exclude patterns", () => {
    it("respects includePatterns filter", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
        includePatterns: ["/blog/"],
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml([
            "https://example.com/blog/post1",
            "https://example.com/about", // excluded by include pattern
          ])
        )
      );
      fetchPageMock.mockResolvedValueOnce(
        pageResult("https://example.com/blog/post1", makeHtml([]))
      );

      const result = await crawler.crawl();
      const urls = result.urls.map((u) => u.url);
      expect(urls).toContain("https://example.com/blog/post1");
      expect(urls).not.toContain("https://example.com/about");
    });

    it("respects excludePatterns filter", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
        excludePatterns: ["/admin"],
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml([
            "https://example.com/page1",
            "https://example.com/admin/dashboard", // excluded
          ])
        )
      );
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/page1", makeHtml([])));

      const result = await crawler.crawl();
      const urls = result.urls.map((u) => u.url);
      expect(urls).toContain("https://example.com/page1");
      expect(urls).not.toContain("https://example.com/admin/dashboard");
    });
  });

  // ==========================================================================
  // Per-page outcomes (pageOutcomes)
  // ==========================================================================

  describe("page outcomes", () => {
    it("records one outcome per attempted URL on the normal path (success + failure)", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml(["https://example.com/good", "https://example.com/bad"])
        )
      );
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/good", makeHtml([])));
      fetchPageMock.mockResolvedValueOnce(failedResult("network down"));

      const result = await crawler.crawl();

      // Every attempted address has exactly one outcome
      expect(result.pageOutcomes).toHaveLength(3);
      const attempted = new Set(result.pageOutcomes.map((o) => o.url));
      expect(attempted).toEqual(
        new Set(["https://example.com", "https://example.com/good", "https://example.com/bad"])
      );

      // Successful pages
      expectStatus(result, "https://example.com", "success");
      expectStatus(result, "https://example.com/good", "success");
      expect(outcomeFor(result, "https://example.com/good").reason).toBeNull();

      // Failed page keeps its reason text, and the crawl continued
      const bad = outcomeFor(result, "https://example.com/bad");
      expect(bad.status).toBe("failed");
      expect(bad.reason).toBe("network down");
      expect(bad.depth).toBe(1);

      // Original fields keep their meaning: only successes are in urls
      expect(result.urls.map((u) => u.url)).not.toContain("https://example.com/bad");
      expect(result.urls).toHaveLength(2);
      expect(result.metadata.totalUrls).toBe(2);
    });

    it("classifies timeout failures separately from generic failures", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult("https://example.com", makeHtml(["https://example.com/slow"]))
      );
      fetchPageMock.mockResolvedValueOnce({
        ok: false,
        status: "timeout",
        reason: "Navigation timeout of 30000ms exceeded",
        delayMs: 0,
      });

      const result = await crawler.crawl();
      const slow = outcomeFor(result, "https://example.com/slow");
      expect(slow.status).toBe("timeout");
      expect(slow.reason).toContain("timeout");
      expect(result.urls.map((u) => u.url)).not.toContain("https://example.com/slow");
    });

    it("classifies scraper-level timeout and empty-data failures through the real fetchPage", async () => {
      const crawler = new Crawler({
        url: "https://example.com",
        depth: 1,
        delayMs: 0,
      });
      (crawler as any).logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      // Seed succeeds, /slow times out at the scraper layer, /empty returns no data
      scrapeMock
        .mockResolvedValueOnce({
          data: [
            {
              rawHtml: makeHtml(["https://example.com/slow", "https://example.com/empty"]),
              metadata: {
                baseUrl: "https://example.com",
                website: { title: "Seed", description: null },
              },
            },
          ],
          batchMetadata: { totalUrls: 1, successfulUrls: 1, failedUrls: 0, errors: [] },
        })
        .mockResolvedValueOnce({
          data: [],
          batchMetadata: {
            totalUrls: 1,
            successfulUrls: 0,
            failedUrls: 1,
            errors: [{ url: "https://example.com/slow", error: "Request timed out after 30000ms" }],
          },
        })
        .mockResolvedValueOnce({
          data: [],
          batchMetadata: {
            totalUrls: 1,
            successfulUrls: 0,
            failedUrls: 1,
            errors: [{ url: "https://example.com/empty", error: "No content returned for page" }],
          },
        });

      const result = await crawler.crawl();

      const slow = outcomeFor(result, "https://example.com/slow");
      expect(slow.status).toBe("timeout");
      expect(slow.reason).toContain("timed out");

      const empty = outcomeFor(result, "https://example.com/empty");
      expect(empty.status).toBe("failed");
      expect(empty.reason).toContain("No content returned");

      // Neither failed page entered urls, but the seed did — crawl continued
      expect(result.urls.map((u) => u.url)).toEqual(["https://example.com"]);
    });

    it("records depth on every outcome", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 2,
      });

      fetchPageMock
        .mockResolvedValueOnce(
          pageResult("https://example.com", makeHtml(["https://example.com/a"]))
        )
        .mockResolvedValueOnce(
          pageResult("https://example.com/a", makeHtml(["https://example.com/a/b"]))
        )
        .mockResolvedValueOnce(pageResult("https://example.com/a/b", makeHtml([])));

      const result = await crawler.crawl();
      expect(outcomeFor(result, "https://example.com").depth).toBe(0);
      expect(outcomeFor(result, "https://example.com/a").depth).toBe(1);
      expect(outcomeFor(result, "https://example.com/a/b").depth).toBe(2);
    });
  });

  describe("page outcomes — maxPages boundary", () => {
    it("marks queued addresses left over after maxPages as not-processed", async () => {
      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
        maxPages: 2,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml([
            "https://example.com/p1",
            "https://example.com/p2",
            "https://example.com/p3",
            "https://example.com/p4",
          ])
        )
      );
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/p1", makeHtml([])));

      const result = await crawler.crawl();

      // Only two pages count as successful (seed + p1)
      expect(result.urls).toHaveLength(2);
      expectStatus(result, "https://example.com", "success");
      expectStatus(result, "https://example.com/p1", "success");

      // Everything still queued is recorded as not-processed, never as success
      for (const leftover of [
        "https://example.com/p2",
        "https://example.com/p3",
        "https://example.com/p4",
      ]) {
        const outcome = outcomeFor(result, leftover);
        expect(outcome.status).toBe("not-processed");
        expect(outcome.reason).toContain("maxPages");
        expect(outcome.delayMs).toBe(0);
        expect(result.urls.map((u) => u.url)).not.toContain(leftover);
      }

      // One outcome per address: 2 success + 3 not-processed
      expect(result.pageOutcomes).toHaveLength(5);
      expect(result.pageOutcomes.filter((o) => o.status === "success")).toHaveLength(2);
      expect(result.pageOutcomes.filter((o) => o.status === "not-processed")).toHaveLength(3);
    });
  });

  describe("page outcomes — robots.txt negative path", () => {
    afterEach(() => {
      vi.mocked(robotsParser.isUrlAllowed).mockReset().mockReturnValue(true);
      vi.mocked(robotsParser.fetchRobotsTxt).mockReset().mockResolvedValue(null);
    });

    it("does not place robots-blocked discovered links in urls and records them as refused", async () => {
      vi.mocked(robotsParser.fetchRobotsTxt).mockResolvedValue({
        disallowedPaths: ["/private"],
        allowedPaths: [],
        crawlDelay: null,
      });
      vi.mocked(robotsParser.isUrlAllowed).mockImplementation(
        (url: string) => !url.includes("/private")
      );

      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com",
        depth: 1,
      });

      fetchPageMock.mockResolvedValueOnce(
        pageResult(
          "https://example.com",
          makeHtml([
            "https://example.com/private/secret", // robots-blocked
            "https://example.com/public",
          ])
        )
      );
      fetchPageMock.mockResolvedValueOnce(pageResult("https://example.com/public", makeHtml([])));

      const result = await crawler.crawl();

      // Blocked address never fetched, never in urls
      expect(fetchPageMock).not.toHaveBeenCalledWith("https://example.com/private/secret");
      expect(result.urls.map((u) => u.url)).not.toContain("https://example.com/private/secret");

      // ...but it is still reported as a refused outcome with its depth
      const blocked = outcomeFor(result, "https://example.com/private/secret");
      expect(blocked.status).toBe("robots-blocked");
      expect(blocked.reason).toContain("robots.txt");
      expect(blocked.depth).toBe(1);

      // Allowed pages still succeed
      expectStatus(result, "https://example.com/public", "success");
    });

    it("records a robots-blocked seed as refused and fetches nothing", async () => {
      vi.mocked(robotsParser.fetchRobotsTxt).mockResolvedValue({
        disallowedPaths: ["/"],
        allowedPaths: [],
        crawlDelay: null,
      });
      vi.mocked(robotsParser.isUrlAllowed).mockReturnValue(false);

      const { crawler, fetchPageMock } = createTestCrawler({
        url: "https://example.com/blocked-seed",
      });

      const result = await crawler.crawl();

      expect(result.urls).toHaveLength(0);
      expect(fetchPageMock).not.toHaveBeenCalled();
      expect(result.pageOutcomes).toHaveLength(1);
      const seed = result.pageOutcomes[0];
      expect(seed.url).toBe("https://example.com/blocked-seed");
      expect(seed.status).toBe("robots-blocked");
      expect(seed.depth).toBe(0);
    });
  });

  describe("page outcomes — crawl-delay", () => {
    afterEach(() => {
      vi.mocked(robotsParser.isUrlAllowed).mockReset().mockReturnValue(true);
      vi.mocked(robotsParser.fetchRobotsTxt).mockReset().mockResolvedValue(null);
    });

    it("waits the robots.txt crawl-delay between adjacent same-host fetches and reports the wait", async () => {
      vi.mocked(robotsParser.fetchRobotsTxt).mockResolvedValue({
        disallowedPaths: [],
        allowedPaths: [],
        crawlDelay: 50, // 50ms between adjacent fetches on this host
      });

      const crawler = new Crawler({
        url: "https://example.com",
        depth: 1,
        maxPages: 20,
        delayMs: 0,
      });
      (crawler as any).logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      // Stub the timer so the test stays fast and deterministic.
      const sleepMock = vi.fn<[number], Promise<void>>().mockResolvedValue(undefined);
      (crawler as any).sleep = sleepMock;

      // Use the REAL fetchPage (delay logic lives there) with a mocked scraper.
      // The seed links to two same-host pages, giving 3 adjacent fetches.
      scrapeMock
        .mockResolvedValueOnce({
          data: [
            {
              rawHtml: makeHtml(["https://example.com/a", "https://example.com/b"]),
              metadata: {
                baseUrl: "https://example.com",
                website: { title: "Seed", description: null },
              },
            },
          ],
          batchMetadata: { totalUrls: 1, successfulUrls: 1, failedUrls: 0, errors: [] },
        })
        .mockResolvedValueOnce(scrapeDataFor("https://example.com/a"))
        .mockResolvedValueOnce(scrapeDataFor("https://example.com/b"));

      const result = await crawler.crawl();

      // All three pages succeeded
      expect(result.urls).toHaveLength(3);

      // The wait actually happened (first fetch has no predecessor, the rest do)
      expect(sleepMock).toHaveBeenCalled();
      for (const call of sleepMock.mock.calls) {
        expect(call[0]).toBeGreaterThan(0);
        expect(call[0]).toBeLessThanOrEqual(50);
      }

      // The waiting is observable in the outcomes
      const seedOutcome = outcomeFor(result, "https://example.com");
      expect(seedOutcome.delayMs).toBe(0);
      for (const url of ["https://example.com/a", "https://example.com/b"]) {
        const outcome = outcomeFor(result, url);
        expect(outcome.status).toBe("success");
        expect(outcome.delayMs).toBeGreaterThan(0);
        expect(outcome.delayMs).toBeLessThanOrEqual(50);
      }
    });
  });
});
