// Turning fetched search results into the markdown the model reads. Everything here is a pure
// function over strings and plain data: no network, no disk, no pi API. index.ts fetches the
// pages and calls renderToolResult on what comes back.

/** One search result: the page title, and the URL with DuckDuckGo's redirect wrapper removed. */
export interface SearchResultLink {
  title: string;
  url: string;
}

/**
 * How one query ended, fine-grained enough to tell the four fetch failures apart:
 *
 *  - `success`       results were read off the page
 *  - `rate-limited`  DDG answered with an HTTP 202 challenge page (soft ban)
 *  - `http-error`    any other non-2xx response
 *  - `fetch-error`   the request never produced a parseable response (network/parsing throw)
 */
export type QueryOutcome = "success" | "rate-limited" | "http-error" | "fetch-error";

/** The three outcomes that mean the query failed. */
export type FailureOutcome = Exclude<QueryOutcome, "success">;

/** The outcome of one fetch. `requestedUrl` and `finalUrl` differ when the request was redirected. */
export type PageFetchResult =
  | {
      ok: true;
      outcome: "success";
      requestedUrl: string;
      finalUrl: string;
      title: string;
      readableText: string;
      links: SearchResultLink[];
    }
  | {
      ok: false;
      outcome: FailureOutcome;
      requestedUrl: string;
      error: string;
      /** Present for `rate-limited`: the seconds the engine suggests waiting before retrying. */
      retryAfterSeconds?: number;
    };

export type QueryStatus = "queued" | "loading" | "done" | "error";

/**
 * One query: where it has got to, and what it found once done. The functions below only read
 * `result`; `status` is here because index.ts draws a progress row per query from the same list.
 * `outcome` is the finished query's verdict; it stays undefined while the query is queued or
 * loading, and on progress restored from a session saved before outcomes existed.
 */
export interface QueryProgress {
  query: string;
  status: QueryStatus;
  outcome?: QueryOutcome;
  result: PageFetchResult | undefined;
}

/** The wait a 202 soft-ban recommends, in seconds. The fetch side waits this long before retrying. */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

// =============================================================================
// Tidying up one extracted page
// =============================================================================

// Number each result heading, so the snippets state DuckDuckGo's ranking instead of merely
// following it, and a result can be pointed at by number. Runs before demoteHeadings, while
// result titles are still the `##` Defuddle gives them. On a results page these are the only
// headings there are, because the page is nothing but results.
export function numberResultHeadings(markdown: string): string {
  let resultNumber = 0;
  return markdown.replace(/^## /gm, () => {
    resultNumber += 1;
    return `## ${resultNumber}. `;
  });
}

// Push every heading down one level, so result titles sit under the query heading added later.
// An `h6` stays where it is, because markdown has nothing below it.
export function demoteHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,5}) /gm, "#$1 ");
}

// A bare URL never contains a space, so a space is what separates a real label from one.
function labelReadsAsProse(label: string): boolean {
  return /\s/.test(label.trim());
}

// Turn every markdown link into plain text, keeping whichever half says something. DuckDuckGo
// repeats each URL three times: once as the title heading, once as the visible link text, and
// once wrapped around the snippet. Keeping the label when it is prose, and the address when the
// label is just the URL again, leaves each result reading as title, URL, snippet.
export function flattenMarkdownLinks(markdown: string): string {
  const markdownLink = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  return markdown.replace(markdownLink, (_whole, label: string, address: string) =>
    labelReadsAsProse(label) ? label : address,
  );
}

// Replace DuckDuckGo's redirect links with where they actually go. They look like
// `https://duckduckgo.com/l/?uddg=<escaped-url>&rut=...`, sometimes with the `https:` left off
// the front.
export function expandRedirectLinks(markdown: string): string {
  const redirectLink =
    /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi;

  return markdown.replace(redirectLink, (_whole, escapedUrl: string) =>
    decodeURIComponent(escapedUrl),
  );
}

// Both link fixes in the order they have to run: resolve the redirects, then drop the markup.
export function cleanUpLinks(markdown: string): string {
  return flattenMarkdownLinks(expandRedirectLinks(markdown));
}

// =============================================================================
// Building the answer handed back to the model
//
// Two sections, built separately and joined:
//
//   # Search results by query      renderSearchResults
//   ## Query: "..."                  renderQuerySection, once per query
//   ### 1. <result title>              the tidied, numbered snippets
//
//   # Read these pages             renderLinkSummary
//   <instruction>                    FETCH_INSTRUCTION
//   ## <query>                       that query's links
//   1. [title](url)
//
// Both sections count DuckDuckGo's results in the same order, so result 1 above is link 1 below.
// Queries themselves are never numbered; only the results within one are ranked.
// =============================================================================

// The tools that open result links. Both come from pi-smart-fetch, which is required.
export const FETCH_TOOL_NAME = "web_fetch";
export const BATCH_FETCH_TOOL_NAME = "batch_web_fetch";

export const SEARCH_RESULTS_HEADER = "# Search results by query";
export const LINK_SUMMARY_HEADER = "# Read these pages";

// =============================================================================
// Naming each outcome
//
// Two renderings of the same four-way verdict: a compact label for the progress card's row,
// and the category sentence the model reads inside the `_search failed: ..._` line.
// =============================================================================

/**
 * The verdict a finished query carries. Progress restored from an older session has no
 * `outcome` field, so it is derived from the result when needed.
 */
export function outcomeOf(entry: QueryProgress): QueryOutcome | undefined {
  if (entry.outcome) return entry.outcome;
  if (!entry.result) return undefined;
  return entry.result.ok ? "success" : entry.result.outcome;
}

/** The compact per-row label shown next to the status badge, or "" while the query is pending. */
export function describeOutcome(entry: QueryProgress): string {
  const outcome = outcomeOf(entry);
  if (!outcome) return "";
  switch (outcome) {
    case "success":
      return "success";
    case "rate-limited":
      return `rate-limited · wait ~${RATE_LIMIT_RETRY_AFTER_SECONDS}s`;
    case "http-error":
      return "HTTP error";
    case "fetch-error":
      return "network/parse error";
  }
}

// The failure category as the model reads it, with the retry hint spelled out for a soft ban.
function failureOutcomeText(outcome: FailureOutcome): string {
  switch (outcome) {
    case "rate-limited":
      return (
        `rate-limited by the search engine (HTTP 202 soft-ban) -- ` +
        `wait ~${RATE_LIMIT_RETRY_AFTER_SECONDS} seconds before retrying`
      );
    case "http-error":
      return "HTTP error (non-2xx response)";
    case "fetch-error":
      return "network or parsing error";
  }
}

// The sentence telling the model what to do with the links.
export const FETCH_INSTRUCTION =
  `Open the most relevant links below before answering -- ${FETCH_TOOL_NAME} for a single page, ` +
  `${BATCH_FETCH_TOOL_NAME} for two or three. Pick the few that best answer the question rather ` +
  "than the whole list. These previews are brief and may be out of date; skip fetching only if " +
  "they already fully answer the question.";

export function renderQuerySection(entry: QueryProgress): string {
  const heading = `## Query: "${entry.query}"`;
  const result = entry.result;

  if (!result?.ok) {
    // The failure line names the category, then keeps the raw error after it. A soft ban also
    // carries the wait in the category itself, so the model knows when a retry stands a chance.
    // A query with no result at all gets the generic network/parse category.
    const outcome: FailureOutcome = result?.outcome ?? "fetch-error";
    return `${heading}\n_search failed: ${failureOutcomeText(outcome)} -- ${result?.error ?? "unknown"}_\n`;
  }

  const withPlainLinks = cleanUpLinks(result.readableText);
  const withNumberedResults = numberResultHeadings(withPlainLinks);
  const snippets = demoteHeadings(withNumberedResults);

  return `${heading}\n${snippets || "_no content extracted_"}\n`;
}

export function renderSearchResults(searches: QueryProgress[]): string {
  return [SEARCH_RESULTS_HEADER, ...searches.map(renderQuerySection)].join("\n");
}

// The second section: the instruction, then each query's links as a numbered list. Comes back
// empty when no query found anything, and the caller then leaves the section out.
export function renderLinkSummary(searches: QueryProgress[]): string {
  const blocks: string[] = [];

  for (const entry of searches) {
    if (!entry.result?.ok || entry.result.links.length === 0) continue;
    const links = entry.result.links.map(
      (link, index) => `${index + 1}. [${link.title}](${link.url})`,
    );
    blocks.push(`## ${entry.query}\n${links.join("\n")}`);
  }

  if (blocks.length === 0) return "";

  return [LINK_SUMMARY_HEADER, "", FETCH_INSTRUCTION, "", blocks.join("\n\n")].join("\n");
}

export function renderToolResult(searches: QueryProgress[]): string {
  const summary = renderLinkSummary(searches);
  const sections = [renderSearchResults(searches)];
  if (summary) sections.push(summary);
  return sections.join("\n");
}
