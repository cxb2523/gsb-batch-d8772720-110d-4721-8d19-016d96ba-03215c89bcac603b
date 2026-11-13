// Reusable, dependency-free pagination collector for the HasData Zillow MCP
// search tool `hasdata_zillow_listing_getRealEstateListings`.
//
// The hosted tool returns one page per call and points at the following page
// through `pagination.nextPage` in the scraped payload. This module walks that
// link for up to `maxPages` calls, merges every page's `properties`, and keeps
// a per-page audit trail (counts, whether another page was offered, and why a
// page failed). It talks JSON-RPC over streamable HTTP itself, so it is a
// standalone library: the npm and PyPI launchers that bridge an MCP client to
// the remote server are untouched.
//
// Everything here is plain Node ESM (Node >= 18) with no third-party code.

export const LISTINGS_TOOL = 'hasdata_zillow_listing_getRealEstateListings';
export const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=zillow';

// Why the walk stopped. `key_rejected` covers both flavours of a bad key: the
// connection-layer HTTP 401 (no key / key refused before the tool runs) and the
// tool-level 200 response whose text says "HasData API error: 401 Unauthorized".
// The page record's `errorKind` says which one it was.
export const STOP_REASON = Object.freeze({
    MAX_PAGES: 'max_pages',
    NO_NEXT_PAGE: 'no_next_page',
    PAGE_FAILED: 'page_failed',
    KEY_REJECTED: 'key_rejected',
    CONCURRENCY_LIMIT: 'concurrency_limit',
});

// Outcome recorded for a single page request.
const PAGE_STATUS = Object.freeze({
    OK: 'ok',
    EMPTY: 'empty',
    CONCURRENCY_LIMIT: 'concurrency_limit',
    KEY_REJECTED: 'key_rejected',
    METADATA_NOT_OK: 'metadata_not_ok',
    HTTP_ERROR: 'http_error',
    TOOL_ERROR: 'tool_error',
    MALFORMED: 'malformed',
    NETWORK_ERROR: 'network_error',
});

const DEFAULT_MAX_CONCURRENCY_RETRIES = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH = globalThis.fetch;
const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sleepFor = (attempt, baseDelayMs, maxDelayMs) =>
    Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));

// Pick the JSON-RPC message that answers our request id out of a streamable
// HTTP body. The body is either plain JSON/RPC text or server-sent events; one
// SSE event can span several `data:` lines, several events can share one
// response, and progress notifications without an id may arrive first.
export function parseRpcMessage(raw, id) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return JSON.parse(trimmed);
    }

    const messages = [];
    for (const event of trimmed.split(/\r?\n\r?\n+/)) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
            messages.push(JSON.parse(data));
        } catch {
            // A keep-alive comment or partial event is not our response.
        }
    }
    const match = messages.find((message) => message.id === id);
    if (!match) {
        throw new Error(`no JSON-RPC message with id ${id} in the response: ${trimmed.slice(0, 300)}`);
    }
    return match;
}

// The tool result is one text block whose text is normally itself JSON holding
// `url`, `status`, `text` and `json`, with the scraped data under `json`. An
// isError result can instead carry the reason as plain text, so error
// classification happens in the caller before envelope parsing.
function extractPayload(message) {
    if (message.error) {
        return {
            failure: {
                status: PAGE_STATUS.TOOL_ERROR,
                errorKind: 'json_rpc_error',
                error: `JSON-RPC error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`.trim(),
            },
        };
    }

    const content = message.result?.content;
    if (!Array.isArray(content) || content.length === 0) {
        return {
            failure: {
                status: PAGE_STATUS.MALFORMED,
                errorKind: 'missing_content',
                error: 'the tool result carried no content blocks',
            },
        };
    }

    const textBlock = content.find((block) => typeof block?.text === 'string') ?? content[0];
    if (typeof textBlock.text !== 'string') {
        return {
            failure: {
                status: PAGE_STATUS.MALFORMED,
                errorKind: 'missing_text',
                error: 'the tool result carried no text block',
            },
        };
    }

    let envelope;
    try {
        envelope = JSON.parse(textBlock.text);
    } catch (cause) {
        return {
            failure: {
                status: PAGE_STATUS.MALFORMED,
                errorKind: 'invalid_text_json',
                error: `the tool text block is not valid JSON: ${cause.message}`,
            },
        };
    }

    const payload = envelope?.json;
    if (!payload || typeof payload !== 'object') {
        return {
            failure: {
                status: PAGE_STATUS.MALFORMED,
                errorKind: 'missing_json',
                error: 'the tool envelope carried no scraped `json` payload',
            },
        };
    }
    return { payload };
}

// All text blocks of a tool result, joined, so an isError reason can be matched
// whether it arrives as plain text or inside a JSON envelope.
function resultText(message) {
    const content = message.result?.content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .filter(Boolean)
        .join('\n');
}

/**
 * Walk `pagination.nextPage` page by page and merge the listings.
 *
 * @param {object} options
 * @param {string} options.keyword              Location search, e.g. "Austin, TX". Sent verbatim on every page.
 * @param {string} options.type                 "forSale", "forRent" or "sold". Sent verbatim on every page.
 * @param {object} [options.filters]            Any other tool parameters (price_min_, beds_min_, homeTypes__, ...). Sent verbatim on every page.
 * @param {number} [options.maxPages=5]         Upper bound on page requests.
 * @param {string} [options.apiKey]             HasData key. Defaults to process.env.HASDATA_API_KEY.
 * @param {string} [options.endpoint]           MCP endpoint override.
 * @param {number} [options.maxConcurrencyRetries=4] Extra attempts after a 429 / concurrency_limit response.
 * @param {number} [options.retryBaseDelayMs=1000]    Base of the exponential backoff (1s, 2s, 4s, ... before the cap).
 * @param {number} [options.retryMaxDelayMs=30000]    Backoff cap per wait.
 * @param {number} [options.timeoutMs=30000]    Per-attempt fetch timeout.
 * @param {typeof fetch} [options.fetchImpl]    Injection seam for tests.
 * @param {(ms: number) => Promise<void>} [options.sleep] Injection seam for the backoff wait.
 * @returns {Promise<object>} Merged properties plus a per-page audit trail and the stop reason.
 */
export async function paginateListings(options) {
    const {
        keyword,
        type,
        filters = {},
        maxPages = 5,
        apiKey = process.env.HASDATA_API_KEY,
        endpoint = DEFAULT_ENDPOINT,
        maxConcurrencyRetries = DEFAULT_MAX_CONCURRENCY_RETRIES,
        retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
        retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        fetchImpl = DEFAULT_FETCH,
        sleep = DEFAULT_SLEEP,
    } = options ?? {};

    if (!keyword || typeof keyword !== 'string') {
        throw new TypeError('paginateListings: "keyword" is required and must be a string');
    }
    if (!type || typeof type !== 'string') {
        throw new TypeError('paginateListings: "type" is required and must be a string');
    }
    if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new TypeError('paginateListings: "maxPages" must be a positive integer');
    }
    if (!apiKey) {
        // No key means the connection itself is refused with HTTP 401. Surface
        // it as the same structured outcome instead of letting fetch send an
        // empty x-api-key header and guessing at the upstream response.
        return {
            properties: [],
            totalCount: 0,
            pagesRequested: 1,
            stopReason: STOP_REASON.KEY_REJECTED,
            pages: [
                {
                    page: 1,
                    status: PAGE_STATUS.KEY_REJECTED,
                    errorKind: 'missing_api_key',
                    propertyCount: 0,
                    hasNextPage: false,
                    nextPage: null,
                    attempts: 0,
                    retryDelaysMs: [],
                    error: 'No HasData API key was provided (set HASDATA_API_KEY or pass apiKey).',
                },
            ],
        };
    }
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('paginateListings: "fetchImpl" must be a fetch-compatible function');
    }

    // The first-screen keyword, type and every filter are frozen here and sent
    // verbatim with every later page. Pagination is driven only by nextPage;
    // the module never invents a `page` number or builds a Zillow URL itself.
    const baseArguments = { ...filters, keyword, type };
    const pages = [];
    const properties = [];
    let nextPageUrl = null;
    let nextId = 1;
    let stopReason = STOP_REASON.MAX_PAGES;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        const arguments_ = pageNumber === 1 ? { ...baseArguments } : { ...baseArguments, url: nextPageUrl };
        let raw;
        let status;
        let attempts = 0;
        const retryDelaysMs = [];

        // Retry loop: only upstream concurrency rejection (HTTP 429, or a body
        // carrying concurrency_limit) is retried. Auth failures and every other
        // error are terminal and never burn another attempt.
        for (;;) {
            attempts += 1;
            const id = nextId++;
            try {
                const response = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers: {
                        'x-api-key': apiKey,
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        method: 'tools/call',
                        params: { name: LISTINGS_TOOL, arguments: arguments_ },
                    }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                status = response.status;
                // Reading the body can fail too (a connection dropped mid-stream),
                // so it stays inside the same network-level guard.
                raw = await response.text();
            } catch (cause) {
                pages.push({
                    page: pageNumber,
                    status: PAGE_STATUS.NETWORK_ERROR,
                    errorKind: 'network',
                    propertyCount: 0,
                    hasNextPage: false,
                    nextPage: null,
                    attempts,
                    retryDelaysMs,
                    error: `the request did not reach HasData: ${cause.message}`,
                });
                stopReason = STOP_REASON.PAGE_FAILED;
                return finalize(properties, pages, stopReason);
            }

            if (status === 401) {
                pages.push({
                    page: pageNumber,
                    status: PAGE_STATUS.KEY_REJECTED,
                    errorKind: 'http_401',
                    propertyCount: 0,
                    hasNextPage: false,
                    nextPage: null,
                    attempts,
                    retryDelaysMs,
                    error: `connection refused with HTTP 401 (missing or rejected key): ${raw.slice(0, 300)}`,
                });
                stopReason = STOP_REASON.KEY_REJECTED;
                return finalize(properties, pages, stopReason);
            }

            const throttled = status === 429 || raw.includes('concurrency_limit');
            if (throttled) {
                if (attempts <= maxConcurrencyRetries) {
                    const delayMs = sleepFor(attempts, retryBaseDelayMs, retryMaxDelayMs);
                    retryDelaysMs.push(delayMs);
                    await sleep(delayMs);
                    continue;
                }
                // Retries exhausted: a plan limit, not a broken contract. Keep
                // everything already collected and stop here.
                pages.push({
                    page: pageNumber,
                    status: PAGE_STATUS.CONCURRENCY_LIMIT,
                    errorKind: 'concurrency_limit',
                    propertyCount: 0,
                    hasNextPage: false,
                    nextPage: null,
                    attempts,
                    retryDelaysMs,
                    error: `upstream concurrency limit (HTTP ${status}, concurrency_limit) persisted after ${attempts - 1} retries`,
                });
                stopReason = STOP_REASON.CONCURRENCY_LIMIT;
                return finalize(properties, pages, stopReason);
            }

            if (status !== 200) {
                pages.push({
                    page: pageNumber,
                    status: PAGE_STATUS.HTTP_ERROR,
                    errorKind: `http_${status}`,
                    propertyCount: 0,
                    hasNextPage: false,
                    nextPage: null,
                    attempts,
                    retryDelaysMs,
                    error: `unexpected HTTP ${status}: ${raw.slice(0, 300)}`,
                });
                stopReason = STOP_REASON.PAGE_FAILED;
                return finalize(properties, pages, stopReason);
            }
            break;
        }

        let message;
        try {
            message = parseRpcMessage(raw, nextId - 1);
        } catch (cause) {
            pages.push({
                page: pageNumber,
                status: PAGE_STATUS.MALFORMED,
                errorKind: 'unparseable_rpc',
                propertyCount: 0,
                hasNextPage: false,
                nextPage: null,
                attempts,
                retryDelaysMs,
                error: cause.message,
            });
            stopReason = STOP_REASON.PAGE_FAILED;
            return finalize(properties, pages, stopReason);
        }

        const isError = message.result?.isError === true;
        const messageText = resultText(message);

        // A wrong key still arrives as HTTP 200 with isError: true and this
        // exact text. It is terminal: do not retry, do not ask for another page.
        if (isError && messageText.includes('HasData API error: 401 Unauthorized')) {
            pages.push({
                page: pageNumber,
                status: PAGE_STATUS.KEY_REJECTED,
                errorKind: 'tool_401',
                propertyCount: 0,
                hasNextPage: false,
                nextPage: null,
                attempts,
                retryDelaysMs,
                error: 'tool result isError with text "HasData API error: 401 Unauthorized"',
            });
            stopReason = STOP_REASON.KEY_REJECTED;
            return finalize(properties, pages, stopReason);
        }

        // Any other tool-level error is a failed page and stops the walk.
        if (isError) {
            pages.push({
                page: pageNumber,
                status: PAGE_STATUS.TOOL_ERROR,
                errorKind: 'tool_is_error',
                propertyCount: 0,
                hasNextPage: false,
                nextPage: null,
                attempts,
                retryDelaysMs,
                error: `the tool returned isError: ${messageText.slice(0, 300)}`,
            });
            stopReason = STOP_REASON.PAGE_FAILED;
            return finalize(properties, pages, stopReason);
        }

        const extracted = extractPayload(message);
        if (extracted.failure) {
            pages.push({
                page: pageNumber,
                ...extracted.failure,
                propertyCount: 0,
                hasNextPage: false,
                nextPage: null,
                attempts,
                retryDelaysMs,
            });
            stopReason = STOP_REASON.PAGE_FAILED;
            return finalize(properties, pages, stopReason);
        }

        const { payload } = extracted;

        const metadataStatus = payload.requestMetadata?.status;
        if (metadataStatus && metadataStatus !== 'ok') {
            pages.push({
                page: pageNumber,
                status: PAGE_STATUS.METADATA_NOT_OK,
                errorKind: 'metadata_not_ok',
                propertyCount: 0,
                hasNextPage: false,
                nextPage: null,
                attempts,
                retryDelaysMs,
                error: `requestMetadata.status was "${metadataStatus}", not "ok"`,
            });
            stopReason = STOP_REASON.PAGE_FAILED;
            return finalize(properties, pages, stopReason);
        }

        if (!Array.isArray(payload.properties)) {
            pages.push({
                page: pageNumber,
                status: PAGE_STATUS.MALFORMED,
                errorKind: 'missing_properties',
                propertyCount: 0,
                hasNextPage: false,
                nextPage: null,
                attempts,
                retryDelaysMs,
                error: 'a successful payload carried no properties array',
            });
            stopReason = STOP_REASON.PAGE_FAILED;
            return finalize(properties, pages, stopReason);
        }

        // An empty properties array is success with no inventory, not an error.
        const pageProperties = payload.properties;
        properties.push(...pageProperties);

        // Only follow the link the server itself gave us. No nextPage means stop,
        // even if the page cap has not been reached.
        const offeredNextPage = typeof payload.pagination?.nextPage === 'string'
            ? payload.pagination.nextPage
            : null;
        pages.push({
            page: pageNumber,
            status: pageProperties.length === 0 ? PAGE_STATUS.EMPTY : PAGE_STATUS.OK,
            propertyCount: pageProperties.length,
            hasNextPage: Boolean(offeredNextPage),
            nextPage: offeredNextPage,
            attempts,
            retryDelaysMs,
            error: null,
        });

        if (!offeredNextPage) {
            stopReason = STOP_REASON.NO_NEXT_PAGE;
            return finalize(properties, pages, stopReason);
        }
        nextPageUrl = offeredNextPage;
    }

    return finalize(properties, pages, stopReason);
}

function finalize(properties, pages, stopReason) {
    return {
        properties,
        totalCount: properties.length,
        pagesRequested: pages.length,
        stopReason,
        pages,
    };
}
