import test from "node:test";
import assert from "node:assert/strict";
import { crawlSite, resumeCrawl, isRetryableCrawlError } from "../src/crawler.js";
import type { CrawlFetch } from "../src/crawler.js";
import { schemaFor } from "../src/mcp.js";
import type { SafeFetchResult } from "../src/net.js";
import type { CrawlResult } from "../src/types.js";

const ORIGIN = "https://crawl.test";

type PageFixture = { html?: string; status?: number; contentType?: string; throws?: string };

function htmlPage(title: string, links: string[] = []): string {
  const anchors = links.map(href => `<a href="${href}">${href}</a>`).join("");
  return `<html lang="en"><head><title>${title}</title><meta name="description" content="${title} page"></head><body><h1>${title}</h1>${anchors}</body></html>`;
}

function result(url: string, status: number, text: string, contentType = "text/html; charset=utf-8"): SafeFetchResult {
  const headers = new Headers({ "content-type": contentType });
  return {
    url,
    status,
    headers,
    text,
    trace: {
      requestedUrl: url,
      finalUrl: url,
      status,
      elapsedMs: 1,
      bytes: text.length,
      contentType,
      redirectChain: [],
      headers: { "content-type": contentType }
    }
  };
}

/** Deterministic stand-in for the network layer. Records each URL it is asked for. */
function stubSite(site: Record<string, PageFixture>, calls: string[]): CrawlFetch {
  return async (url, opts) => {
    calls.push(url);
    const fixture = site[url];
    if (fixture?.throws) throw new Error(fixture.throws);
    if (!fixture) throw new Error(`Unexpected fetch: ${url}${opts?.method ? ` (${opts.method})` : ""}`);
    return result(url, fixture.status ?? 200, fixture.html ?? "", fixture.contentType ?? "text/html; charset=utf-8");
  };
}

function standardSite(overrides: Record<string, PageFixture> = {}): Record<string, PageFixture> {
  return {
    [`${ORIGIN}/`]: { html: htmlPage("Home", ["/about", "/contact", "/pricing", "/docs", "/blog/post", "/about"]) },
    [`${ORIGIN}/about`]: { html: htmlPage("About", ["/team"]) },
    [`${ORIGIN}/contact`]: { html: htmlPage("Contact") },
    [`${ORIGIN}/pricing`]: { html: htmlPage("Pricing") },
    [`${ORIGIN}/docs`]: { html: htmlPage("Docs") },
    [`${ORIGIN}/blog/post`]: { html: htmlPage("Post") },
    [`${ORIGIN}/team`]: { html: htmlPage("Team") },
    [`${ORIGIN}/robots.txt`]: { html: "User-agent: *\nDisallow: /private\n", contentType: "text/plain" },
    [`${ORIGIN}/sitemap.xml`]: { html: `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/pricing</loc></url></urlset>`, contentType: "application/xml" },
    ...overrides
  };
}

function fetchedPaths(calls: string[]): string[] {
  return calls.map(url => new URL(url).pathname);
}

test("crawl truncation is explicit and the pending queue is prioritized and deduplicated", async () => {
  const calls: string[] = [];
  const result = await crawlSite(`${ORIGIN}/`, { maxPages: 2, maxDepth: 3, concurrency: 2, obeyRobots: true }, { fetch: stubSite(standardSite(), calls) });

  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].url, `${ORIGIN}/`);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedByMaxPages, true);
  assert.equal(result.outcome, "truncated");
  assert.equal(result.complete, false);
  assert.ok(result.pendingUrls.length > 0);

  const pendingPaths = result.pendingUrls.map(item => new URL(item.url).pathname);
  // Priority order (about > contact > team > pricing > docs > blog); the /team
  // link discovered on /about outranks shallower, lower-priority URLs.
  assert.deepEqual(pendingPaths, ["/contact", "/team", "/pricing", "/docs", "/blog/post"]);
  assert.equal(new Set(pendingPaths).size, pendingPaths.length, "pending queue must stay deduplicated");
  assert.equal(result.pendingUrls[0].depth, 1);
  assert.equal(result.pendingUrls[1].depth, 2, "deeper links keep their depth");
  assert.ok(result.pendingUrls.every(item => typeof item.priority === "number"));
});

test("a crawl that drains the queue reports completion instead of truncation", async () => {
  const calls: string[] = [];
  const result = await crawlSite(`${ORIGIN}/`, { maxPages: 30, maxDepth: 3, concurrency: 4, obeyRobots: true }, { fetch: stubSite(standardSite(), calls) });

  assert.equal(result.truncated, false);
  assert.equal(result.truncatedByMaxPages, false);
  assert.equal(result.outcome, "complete");
  assert.deepEqual(result.pendingUrls, []);
  assert.equal(result.complete, true);
  assert.equal(fetchedPaths(calls).filter(path => path === "/about").length, 1, "duplicate links must be fetched once");
});

test("resume collects only pending links and never re-fetches visited pages", async () => {
  const site = standardSite();
  const firstCalls: string[] = [];
  const first = await crawlSite(`${ORIGIN}/`, { maxPages: 2, maxDepth: 3, concurrency: 1, obeyRobots: true }, { fetch: stubSite(site, firstCalls) });

  const collectedBefore = new Set(first.pages.map(page => page.url));
  assert.equal(collectedBefore.size, 2);

  const resumeCalls: string[] = [];
  const resumed = await resumeCrawl(first, { maxPages: 10, maxDepth: 3, concurrency: 1, obeyRobots: true }, { fetch: stubSite(site, resumeCalls) });

  const resumedPaths = fetchedPaths(resumeCalls);
  for (const pageUrl of collectedBefore) {
    assert.ok(!resumeCalls.includes(pageUrl), `resume must not re-fetch ${pageUrl}`);
  }
  assert.ok(resumedPaths.includes("/contact"));
  assert.ok(!resumedPaths.includes("/"), "the root must not be fetched again");
  assert.ok(!resumedPaths.includes("/robots.txt"), "robots.txt should come from the previous run when retained");

  // Pages from both runs are available, and no URL appears twice.
  const pageUrls = resumed.pages.map(page => page.url);
  assert.equal(new Set(pageUrls).size, pageUrls.length);
  assert.ok(resumed.pages.length > first.pages.length);
  assert.equal(resumed.truncated, false);
  assert.equal(resumed.complete, true);

  // visitedUrls summarises what each run already fetched.
  assert.deepEqual(first.visitedUrls.sort(), first.pages.map(page => page.url).sort());
  assert.ok(resumed.visitedUrls.includes(`${ORIGIN}/about`));

  // Every URL that was fetched in the first run is also present in the resumed page set.
  for (const pageUrl of collectedBefore) assert.ok(pageUrls.includes(pageUrl));
});

test("resume is bounded by maxPages and reports a fresh pending queue when truncated again", async () => {
  const site = standardSite();
  const firstCalls: string[] = [];
  const first = await crawlSite(`${ORIGIN}/`, { maxPages: 2, maxDepth: 3, concurrency: 1, obeyRobots: true }, { fetch: stubSite(site, firstCalls) });

  const resumeCalls: string[] = [];
  const resumed = await resumeCrawl(first, { maxPages: 2, maxDepth: 3, concurrency: 1, obeyRobots: true }, { fetch: stubSite(site, resumeCalls) });

  assert.equal(resumed.truncated, true);
  assert.equal(resumed.truncatedByMaxPages, true);
  assert.ok(resumed.pendingUrls.length > 0);
  assert.equal(resumeCalls.filter(url => new URL(url).pathname === "/").length, 0);
  assert.equal(resumed.pages.length, first.pages.length + 2, "maxPages bounds newly collected pages");
  // No page fetched twice across the two runs.
  const allFetched = [...firstCalls, ...resumeCalls].filter(url => !/\/(robots\.txt|sitemap\.xml)$/.test(new URL(url).pathname));
  assert.equal(allFetched.length, new Set(allFetched).size);
});

test("resume revalidates links and reports every policy rejection with a reason", async () => {
  const calls: string[] = [];
  const resumeInput = {
    rootUrl: `${ORIGIN}/`,
    robotsText: "User-agent: *\nDisallow: /private\n",
    visitedUrls: [`${ORIGIN}/`],
    pendingUrls: [
      { url: `${ORIGIN}/private/secret`, depth: 1 },
      { url: "https://elsewhere.test/page", depth: 1 },
      { url: `${ORIGIN}/brochure.pdf`, depth: 1 },
      { url: `${ORIGIN}/logout`, depth: 1 },
      { url: `${ORIGIN}/too-deep/page`, depth: 9 },
      { url: `${ORIGIN}/`, depth: 1 }
    ]
  };

  const resumed = await resumeCrawl(resumeInput, { maxPages: 10, maxDepth: 3, concurrency: 1, obeyRobots: true }, { fetch: stubSite(standardSite(), calls) });

  const skipped = new Map(resumed.skipped.map(item => [item.url, item.reason]));
  assert.equal(skipped.get(`${ORIGIN}/private/secret`), "robots-disallow");
  assert.equal(skipped.get("https://elsewhere.test/page"), "external-origin");
  assert.equal(skipped.get(`${ORIGIN}/brochure.pdf`), "non-html-asset");
  assert.equal(skipped.get(`${ORIGIN}/logout`), "deny-pattern");
  assert.equal(skipped.get(`${ORIGIN}/too-deep/page`), "depth-exceeded");
  assert.equal(skipped.get(`${ORIGIN}/`), "already-visited");
  assert.deepEqual(fetchedPaths(calls), [], "no rejected link may be fetched");
  assert.deepEqual(resumed.pendingUrls, []);
  assert.equal(resumed.pages.length, 0);
});

test("resume retries only retryable failures and surfaces remaining queue", async () => {
  const failingSite = standardSite({
    [`${ORIGIN}/about/flaky`]: { throws: "Request timed out after 10000ms" },
    [`${ORIGIN}/about/broken`]: { throws: "Invalid URL" },
    [`${ORIGIN}/`]: { html: htmlPage("Home", ["/about/flaky", "/about/broken", "/contact", "/pricing", "/docs"]) }
  });
  const firstCalls: string[] = [];
  const first = await crawlSite(`${ORIGIN}/`, { maxPages: 2, maxDepth: 2, concurrency: 1, obeyRobots: true }, { fetch: stubSite(failingSite, firstCalls) });

  assert.equal(first.retryableErrors.length, 1);
  assert.equal(first.retryableErrors[0].url, `${ORIGIN}/about/flaky`);
  assert.match(first.retryableErrors[0].error, /timed out/);
  assert.equal(first.complete, false);
  assert.equal(first.truncated, true);
  assert.ok(first.pendingUrls.length > 0, "the capped first run left queued work to report");
  // The deterministic failure is recorded but never offered for retry.
  assert.ok(first.errors.some(item => item.url === `${ORIGIN}/about/broken` && item.retryable === false));
  assert.ok(!first.retryableErrors.some(item => item.url === `${ORIGIN}/about/broken`));

  // Second run: the flaky page now succeeds; the deterministic failure is absent.
  const recovered = standardSite({ [`${ORIGIN}/about/flaky`]: { html: htmlPage("Flaky") } });
  const secondCalls: string[] = [];
  const second = await resumeCrawl(first, { maxPages: 5, maxDepth: 2, concurrency: 1, obeyRobots: true }, { fetch: stubSite(recovered, secondCalls) });

  assert.ok(secondCalls.includes(`${ORIGIN}/about/flaky`), "retryable failures are retried");
  assert.ok(!secondCalls.includes(`${ORIGIN}/about/broken`), "terminal failures are not retried");
  for (const page of first.pages) assert.ok(!secondCalls.includes(page.url), `already visited page ${page.url} must not be re-collected`);
  assert.ok(secondCalls.includes(`${ORIGIN}/pricing`) && secondCalls.includes(`${ORIGIN}/docs`), "pending links are collected");
  assert.deepEqual(second.retryableErrors, []);
  assert.equal(second.complete, true);
  assert.deepEqual(second.pendingUrls, []);
});

test("non-retryable failure classification is stable", () => {
  assert.equal(isRetryableCrawlError("Invalid URL"), false);
  assert.equal(isRetryableCrawlError("Private/reserved IP blocked"), false);
  assert.equal(isRetryableCrawlError("Response exceeds 3000000 bytes"), false);
  assert.equal(isRetryableCrawlError("Request timed out after 10000ms"), true);
  assert.equal(isRetryableCrawlError("connect ECONNREFUSED"), true);
  assert.equal(isRetryableCrawlError("socket hang up"), true);
});

test("pending queue ordering follows priority then depth", async () => {
  const calls: string[] = [];
  const site = standardSite({
    [`${ORIGIN}/`]: { html: htmlPage("Home", ["/blog/post", "/about", "/pricing", "/about"]) },
    [`${ORIGIN}/about`]: { html: htmlPage("About", ["/about/team", "/pricing"]) }
  });
  const result: CrawlResult = await crawlSite(`${ORIGIN}/`, { maxPages: 2, maxDepth: 3, concurrency: 1, obeyRobots: true }, { fetch: stubSite(site, calls) });

  // /about and /about/team are collected, so /team (priority 92) outranks
  // /pricing (88) and /blog/post (50); priority dominates depth.
  assert.deepEqual(result.pendingUrls.map(item => new URL(item.url).pathname), ["/about/team", "/pricing", "/blog/post"]);
  assert.deepEqual(result.pendingUrls.map(item => item.depth), [2, 1, 1]);
  assert.ok(result.pendingUrls[0].priority > result.pendingUrls[1].priority);
});

test("MCP schemas expose the resume input and the crawl outcome status", () => {
  const deepCrawl = schemaFor("deep_crawl") as any;
  const resume = deepCrawl.properties.resume;
  assert.ok(resume, "deep_crawl must accept a resume input");
  assert.ok(resume.properties.pendingUrls && resume.properties.retryableErrors);
  assert.ok(resume.properties.visitedUrls);
  assert.equal(resume.additionalProperties, false);

  // Existing crawl overrides keep their historical shape and bounds.
  const crawl = deepCrawl.properties.crawl;
  assert.deepEqual(Object.keys(crawl.properties).sort(), ["allowPatterns", "concurrency", "denyPatterns", "maxDepth", "maxPages", "obeyRobots", "renderMode", "sameOrigin"]);
  assert.deepEqual(crawl.properties.maxPages, { type: "integer", minimum: 1, maximum: 500 });

  // map_site shares the same contract.
  const mapSite = schemaFor("map_site") as any;
  assert.ok(mapSite.properties.resume);
});
