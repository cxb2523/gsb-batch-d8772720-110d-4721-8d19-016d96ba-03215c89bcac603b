import { safeFetch } from "./net.js";
import type { SafeFetchOptions, SafeFetchResult } from "./net.js";
import { parsePage, pagePriority, classifyImportant } from "./extract.js";
import { analyzeRepresentation } from "./provenance.js";
import { renderUrl, shouldRender } from "./render.js";
import type { CrawlError, CrawlPendingUrl, CrawlPolicy, CrawlResumeInput, CrawlResult, CrawlRetryableError, PageRepresentation, PageSignal } from "./types.js";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] || fallback);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}

export function defaultCrawlPolicy(overrides: Partial<CrawlPolicy> = {}): CrawlPolicy {
  return {
    maxPages: envInt("URL_AGENT_MAX_PAGES", 30, 1, 500),
    maxDepth: envInt("URL_AGENT_MAX_DEPTH", 3, 0, 10),
    concurrency: envInt("URL_AGENT_CONCURRENCY", 4, 1, 20),
    sameOrigin: process.env.URL_AGENT_SAME_ORIGIN !== "false",
    obeyRobots: process.env.URL_AGENT_OBEY_ROBOTS !== "false",
    allowPatterns: (process.env.URL_AGENT_ALLOW_PATTERNS || "").split(",").map(x => x.trim()).filter(Boolean),
    denyPatterns: (process.env.URL_AGENT_DENY_PATTERNS || "logout,signout,delete,unsubscribe,cart,checkout").split(",").map(x => x.trim()).filter(Boolean),
    renderMode: ((process.env.URL_AGENT_RENDER_MODE || "off").toLowerCase() as CrawlPolicy["renderMode"]),
    ...overrides
  };
}

/** Network layer used by the crawler. Tests can inject a deterministic stub instead of the real network. */
export type CrawlFetch = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

export type CrawlSiteOptions = {
  /** Replacement for `safeFetch`; the SSRF guard still applies to the default implementation. */
  fetch?: CrawlFetch;
};

function robotsDisallows(text: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*" || /url-intelligence-agent/i.test(value);
    if (key === "disallow" && applies && value) rules.push(value);
  }
  return rules;
}

function robotsSitemaps(text: string): string[] {
  return [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(m => m[1]);
}

function isAllowed(url: string, rootOrigin: string, policy: CrawlPolicy, disallow: string[]): { ok: boolean; reason?: string } {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: "unsupported-protocol" };
    if (policy.sameOrigin && u.origin !== rootOrigin) return { ok: false, reason: "external-origin" };
    if (/\.(?:pdf|zip|rar|7z|gz|tar|jpg|jpeg|png|gif|svg|webp|avif|ico|mp4|mov|avi|mp3|wav|css|js|woff2?|ttf|eot)(?:$|\?)/i.test(u.pathname + u.search)) return { ok: false, reason: "non-html-asset" };
    if (policy.allowPatterns.length && !policy.allowPatterns.some(p => u.href.includes(p))) return { ok: false, reason: "not-allowlisted" };
    if (policy.denyPatterns.some(p => u.href.toLowerCase().includes(p.toLowerCase()))) return { ok: false, reason: "deny-pattern" };
    if (policy.obeyRobots && disallow.some(rule => rule !== "/" && u.pathname.startsWith(rule))) return { ok: false, reason: "robots-disallow" };
    if (policy.obeyRobots && disallow.includes("/")) return { ok: false, reason: "robots-disallow-all" };
    return { ok: true };
  } catch { return { ok: false, reason: "invalid-url" }; }
}

/**
 * Whether a failed URL is worth retrying.
 *
 * Deterministic failures (malformed/non-public destinations, redirect loops and
 * oversized responses) are final. Transport errors, timeouts and other transient
 * failures stay retryable so a caller can feed them back into a resumed crawl.
 */
export function isRetryableCrawlError(error: string): boolean {
  const text = String(error || "");
  if (/invalid url|only http\/https|credentials in urls|local\/private host is blocked|private\/reserved ip blocked|private\/reserved destination blocked|ssrf|response exceeds|too many redirects|redirect without location/i.test(text)) return false;
  return true;
}

async function fetchSitemapUrls(url: string, fetchFn: CrawlFetch, seen = new Set<string>(), depth = 0): Promise<string[]> {
  if (depth > 3 || seen.has(url) || seen.size > 30) return [];
  seen.add(url);
  try {
    const response = await fetchFn(url, { maxBytes: 5_000_000, timeoutMs: 15000 });
    const xml = response.text;
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, "&").trim());
    if (/<sitemapindex\b/i.test(xml)) {
      const nested: string[] = [];
      for (const loc of locs.slice(0, 30)) nested.push(...await fetchSitemapUrls(loc, fetchFn, seen, depth + 1));
      return nested;
    }
    return locs;
  } catch { return []; }
}

function requestVariant(): PageRepresentation["requestVariant"] {
  return {
    language: (process.env.URL_AGENT_ACCEPT_LANGUAGE || "en,*;q=0.5").split(",")[0],
    userAgentClass: "url-intelligence-agent",
    region: process.env.URL_AGENT_REQUEST_REGION || undefined,
    device: "server"
  };
}

async function collectPage(url: string, renderMode: CrawlPolicy["renderMode"], fetchFn: CrawlFetch): Promise<PageSignal> {
  const fetched = await fetchFn(url, { headers: { "accept-language": process.env.URL_AGENT_ACCEPT_LANGUAGE || "en,*;q=0.5" } });
  const sourceParsed = parsePage(fetched.text, fetched.url, fetched.status, fetched);
  const render = shouldRender(fetched.text, sourceParsed.textSample.length, renderMode) ? await renderUrl(fetched.url, { captureNetwork: true }) : undefined;
  const finalUrl = render?.url || fetched.url;
  const includeHtml = process.env.URL_AGENT_INCLUDE_RAW_REPRESENTATIONS === "true";
  const sourceRepresentation = analyzeRepresentation(fetched.text, fetched.url, "source_html", {
    finalUrl,
    observedAt: new Date().toISOString(),
    headers: fetched.trace.headers,
    requestVariant: requestVariant(),
    includeHtml
  });
  let page = sourceParsed;
  const representations: PageRepresentation[] = [sourceRepresentation];
  if (render) {
    page = parsePage(render.html, render.url, fetched.status, fetched);
    page.rendered = true;
    representations.push(analyzeRepresentation(render.html, render.url, "rendered_dom", {
      finalUrl: render.url,
      observedAt: new Date().toISOString(),
      requestVariant: { ...requestVariant(), device: "chromium" },
      networkEvidence: render.networkEvidence,
      includeHtml
    }));
  }
  page.representations = representations;
  page.observations = [...new Map(representations.flatMap(rep => rep.observations).map(observation => [observation.id, observation])).values()];
  return page;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

function normalizeDepth(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 1;
}

/** Frontier order: priority descending, then shallower depth first, then stable URL order. */
function compareFrontier(a: CrawlPendingUrl, b: CrawlPendingUrl): number {
  return b.priority - a.priority || a.depth - b.depth || a.url.localeCompare(b.url);
}

type ResolvedResume = {
  rootUrl: string;
  pages: PageSignal[];
  visited: string[];
  pending: CrawlPendingUrl[];
  failed: { url: string; error: string; depth: number }[];
  robotsText?: string;
  sitemapUrls: string[];
};

function resolveResume(input: CrawlResumeInput, seedUrl: string): ResolvedResume {
  const pages = (input.pages || []) as PageSignal[];
  const pendingEntries = [...(input.pendingUrls || []), ...(input.pending || [])];
  const explicitFailures = [...(input.retryableErrors || []), ...(input.failed || [])];
  const failedEntries = explicitFailures.length
    ? explicitFailures
    // A full previous error list is reduced to the entries worth retrying.
    : (input.errors || []).filter(entry => isRetryableCrawlError(entry.error || ""));

  const visited = [
    ...(input.visitedUrls || []),
    ...(input.visited || []),
    ...pages.map(page => page.url)
  ].filter((url): url is string => typeof url === "string" && Boolean(url));

  const rootUrl = input.rootUrl || pages[0]?.url || pendingEntries[0]?.url || failedEntries[0]?.url || seedUrl;

  return {
    rootUrl,
    pages,
    visited,
    pending: pendingEntries
      .filter(entry => entry && typeof entry.url === "string" && Boolean(entry.url))
      .map(entry => ({ url: entry.url, depth: normalizeDepth(entry.depth), priority: pagePriority(entry.url) })),
    failed: failedEntries
      .filter(entry => entry && typeof entry.url === "string" && Boolean(entry.url))
      .map(entry => ({ url: entry.url, error: entry.error || "unknown", depth: normalizeDepth(entry.depth) })),
    robotsText: typeof input.robotsText === "string" ? input.robotsText : undefined,
    sitemapUrls: [...new Set(input.sitemapUrls || [])]
  };
}

type CrawlState = {
  policy: CrawlPolicy;
  rootUrl: string;
  origin: string;
  disallow: string[];
  pages: PageSignal[];
  /** Pages collected by this invocation; bounds `maxPages` on resumed runs. */
  collectedThisRun: number;
  importantPages: Record<string, string>;
  errors: CrawlError[];
  skipped: { url: string; reason: string }[];
  visited: Set<string>;
  attempted: Set<string>;
  queued: Set<string>;
  queue: CrawlPendingUrl[];
};

function createState(policy: CrawlPolicy, rootUrl: string, robotsText: string): CrawlState {
  return {
    policy,
    rootUrl,
    origin: originOf(rootUrl),
    disallow: robotsDisallows(robotsText),
    pages: [],
    collectedThisRun: 0,
    importantPages: {},
    errors: [],
    skipped: [],
    visited: new Set<string>(),
    attempted: new Set<string>(),
    queued: new Set<string>(),
    queue: []
  };
}

/**
 * Validate a URL and place it on the frontier.
 *
 * `explicit` marks caller-supplied resume links: every rejection is reported in
 * `skipped` because the caller asked for that URL specifically. Links discovered
 * during the crawl keep the historical behavior of dropping off-origin links.
 */
function enqueue(state: CrawlState, url: string, depth: number, explicit: boolean): void {
  const d = normalizeDepth(depth);
  if (state.visited.has(url) || state.attempted.has(url)) {
    if (explicit) state.skipped.push({ url, reason: "already-visited" });
    return;
  }
  if (state.queued.has(url)) return;
  const allowed = isAllowed(url, state.origin, state.policy, state.disallow);
  if (!allowed.ok) {
    if (explicit || allowed.reason !== "external-origin") state.skipped.push({ url, reason: allowed.reason || "blocked" });
    return;
  }
  if (d > state.policy.maxDepth) {
    // Resume entries are revalidated explicitly; discovered links beyond maxDepth
    // were never queued in the original crawler either.
    if (explicit) state.skipped.push({ url, reason: "depth-exceeded" });
    return;
  }
  state.queued.add(url);
  state.queue.push({ url, depth: d, priority: pagePriority(url) });
}

function recordPage(state: CrawlState, page: PageSignal, requestedUrl: string): void {
  state.pages.push(page);
  state.collectedThisRun++;
  state.visited.add(requestedUrl);
  if (page.url) state.visited.add(page.url);
  const kind = classifyImportant(page.url);
  if (kind && !state.importantPages[kind]) state.importantPages[kind] = page.url;
}

async function crawlLoop(state: CrawlState, fetchFn: CrawlFetch): Promise<void> {
  while (state.queue.length && state.collectedThisRun < state.policy.maxPages) {
    state.queue.sort(compareFrontier);
    const budget = state.policy.maxPages - state.collectedThisRun;
    if (budget <= 0) break;
    const batch = state.queue.splice(0, Math.min(state.policy.concurrency, budget));
    await Promise.all(batch.map(async item => {
      state.queued.delete(item.url);
      if (state.visited.has(item.url) || state.attempted.has(item.url)) return;
      if (item.depth > state.policy.maxDepth) { state.skipped.push({ url: item.url, reason: "depth-exceeded" }); return; }
      state.attempted.add(item.url);
      try {
        const page = await collectPage(item.url, state.policy.renderMode, fetchFn);
        recordPage(state, page, item.url);
        if (item.depth < state.policy.maxDepth) page.links.forEach(link => enqueue(state, link, item.depth + 1, false));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.errors.push({ url: item.url, error: message, depth: item.depth, retryable: isRetryableCrawlError(message) });
      }
    }));
  }
}

function buildResult(state: CrawlState, robotsText: string, sitemapUrls: string[]): CrawlResult {
  for (const page of state.pages) {
    const kind = classifyImportant(page.url);
    if (kind && !state.importantPages[kind]) state.importantPages[kind] = page.url;
  }
  const pendingUrls = state.queue
    .filter(item => !state.visited.has(item.url) && !state.attempted.has(item.url))
    .sort(compareFrontier);
  const retryableErrors: CrawlRetryableError[] = state.errors
    .filter(error => error.retryable !== false && isRetryableCrawlError(error.error))
    .map(error => ({ url: error.url, error: error.error, ...(typeof error.depth === "number" ? { depth: error.depth } : {}) }))
    .slice(0, 500);
  // Truncation means the run stopped at maxPages while work was still queued.
  const truncated = pendingUrls.length > 0 && state.collectedThisRun >= state.policy.maxPages;
  const outcome: CrawlResult["outcome"] = truncated ? "truncated" : retryableErrors.length ? "retryable-errors" : "complete";
  return {
    rootUrl: state.rootUrl,
    pages: state.pages,
    importantPages: state.importantPages,
    sitemapUrls,
    robotsUrl: state.origin ? new URL("/robots.txt", state.origin).toString() : undefined,
    robotsText: robotsText || undefined,
    skipped: state.skipped.slice(0, 500),
    errors: state.errors.slice(0, 500),
    policy: state.policy,
    outcome,
    truncated,
    truncatedByMaxPages: truncated,
    complete: pendingUrls.length === 0 && retryableErrors.length === 0,
    // Successfully collected URLs only. Failed URLs are carried by retryableErrors,
    // so a resumed run does not mistake them for already-visited pages.
    visitedUrls: [...state.visited],
    pendingUrls,
    retryableErrors
  };
}

async function collectRobots(origin: string, fetchFn: CrawlFetch): Promise<string> {
  try { return (await fetchFn(new URL("/robots.txt", origin).toString(), { maxBytes: 300_000, timeoutMs: 6000 })).text; } catch { return ""; }
}

async function runFreshCrawl(seedUrl: string, policy: CrawlPolicy, fetchFn: CrawlFetch): Promise<CrawlResult> {
  const root = await collectPage(seedUrl, policy.renderMode, fetchFn);
  const origin = originOf(root.url);
  const robotsText = await collectRobots(origin, fetchFn);
  const sitemapSeeds = [...new Set([...robotsSitemaps(robotsText), new URL("/sitemap.xml", origin).toString()])];
  const sitemapUrls = [...new Set((await Promise.all(sitemapSeeds.map(x => fetchSitemapUrls(x, fetchFn)))).flat())].slice(0, 5000);

  const state = createState(policy, root.url, robotsText);
  recordPage(state, root, root.url);
  root.links.forEach(url => enqueue(state, url, 1, false));
  sitemapUrls.slice(0, Math.max(policy.maxPages * 5, 100)).forEach(url => enqueue(state, url, Math.min(policy.maxDepth, 1), false));

  await crawlLoop(state, fetchFn);
  return buildResult(state, robotsText, sitemapUrls);
}

async function runResume(input: CrawlResumeInput, policy: CrawlPolicy, fetchFn: CrawlFetch): Promise<CrawlResult> {
  const resume = resolveResume(input, "");
  if (!resume.rootUrl) throw new Error("Resume requires a rootUrl or at least one pending/retryable URL");
  // A resumed run reuses the previous robots snapshot when available so queued
  // links are validated against the same policy as the original run.
  const robotsText = resume.robotsText ?? (policy.obeyRobots ? await collectRobots(originOf(resume.rootUrl), fetchFn) : "");
  const state = createState(policy, resume.rootUrl, robotsText);

  // Carried pages are part of the result and the visited set, but do not consume
  // this run's maxPages budget.
  const seenPages = new Set<string>();
  for (const page of resume.pages) {
    if (!page?.url || seenPages.has(page.url)) continue;
    seenPages.add(page.url);
    state.pages.push(page);
    state.visited.add(page.url);
    const kind = classifyImportant(page.url);
    if (kind && !state.importantPages[kind]) state.importantPages[kind] = page.url;
  }
  resume.visited.forEach(url => state.visited.add(url));
  if (input.importantPages) Object.assign(state.importantPages, input.importantPages);

  for (const entry of resume.pending) enqueue(state, entry.url, entry.depth, true);
  // Failed URLs are retried under the same validation rules as fresh links.
  for (const entry of resume.failed) enqueue(state, entry.url, entry.depth, true);

  await crawlLoop(state, fetchFn);
  return buildResult(state, robotsText, resume.sitemapUrls);
}

export async function crawlSite(rawUrl: string, overrides: Partial<CrawlPolicy> = {}, options: CrawlSiteOptions = {}): Promise<CrawlResult> {
  return runFreshCrawl(rawUrl, defaultCrawlPolicy(overrides), options.fetch || safeFetch);
}

/**
 * Resume a previous crawl from its unprocessed frontier and retryable failures.
 *
 * Previously visited URLs are never fetched again. Every resumed URL is revalidated
 * against same-origin, robots, allow/deny, non-HTML asset and maxDepth rules; links
 * that now violate the policy are reported in `skipped` with an explicit reason.
 * A resumed run is still bounded by `maxPages` (counted against pages collected in
 * this run) and reports its own remaining queue when it hits the bound again.
 */
export async function resumeCrawl(previous: CrawlResult | CrawlResumeInput, overrides: Partial<CrawlPolicy> = {}, options: CrawlSiteOptions = {}): Promise<CrawlResult> {
  const input: CrawlResumeInput = isCrawlResult(previous) ? {
    rootUrl: previous.rootUrl,
    pendingUrls: previous.pendingUrls || [],
    // Only retryable failures are carried; terminal failures stay terminal.
    retryableErrors: previous.retryableErrors || [],
    pages: previous.pages || [],
    visitedUrls: previous.visitedUrls?.length ? previous.visitedUrls : (previous.pages || []).map(page => page.url),
    robotsText: previous.robotsText,
    sitemapUrls: previous.sitemapUrls || [],
    importantPages: previous.importantPages || {}
  } : previous;
  return runResume(input, defaultCrawlPolicy(overrides), options.fetch || safeFetch);
}

function isCrawlResult(value: CrawlResult | CrawlResumeInput): value is CrawlResult {
  // CrawlResult always carries the effective policy; a resume input never does.
  return typeof value === "object" && value !== null && "policy" in value && "pages" in value;
}
