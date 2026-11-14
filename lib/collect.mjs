// Resumable page walker for HasData's Redfin listing search.
//
// The hosted `hasdata_redfin_listing_getRealEstateListings` tool answers one page
// per call, and the same tool returns three different shapes depending on the
// keyword. This module sits on top of an MCP tool caller and walks a whole
// market, recording what happened on each page so an interrupted run can be
// resumed without paying for pages it already collected.
//
// It is a library, not a CLI: build the `callTool` function with
// `createHttpToolCaller` from ./mcp-rpc.mjs, or pass any function with the same
// `(name, args) => Promise<jsonRpcMessage>` shape (tests pass a fake).
//
// Design notes:
//
//  * Paging follows `pagination.currentPage` / `pagination.nextPage` from the
//    response, never a fixed page size. A page may hold fewer than 40 rows and
//    still have a next page; `nextPage` is the only thing that decides whether
//    to continue.
//  * Shape is explicit. A response carrying a `properties` array is a market
//    page. A response without one is a single-property hit (a street address or
//    a building name resolves to one property) and ends the walk. It is neither
//    an empty page nor a failure.
//  * A page outcome is one of `success`, `empty`, `rate_limited` or `error`.
//    A single-property hit is a `success` page with `shape: 'single'` plus
//    `singleHit: true` on the result.
//  * 429 responses and payloads containing `concurrency_limit` are retried with
//    an increasing delay. When the retries are exhausted the page is recorded as
//    `rate_limited` and paging stops, keeping every page collected so far.
//  * Listings without a usable price are dropped and counted. Rental prices are
//    `{ min, max }` objects and are kept exactly as returned; they are never
//    turned into a single averaged number.
//  * Passing a previous result resumes from the first page that is not a
//    success, so already-collected pages are not requested again.

import { createHttpToolCaller } from './mcp-rpc.mjs';

export const LISTINGS_TOOL = 'hasdata_redfin_listing_getRealEstateListings';

/** The four outcomes a page can have. */
export const PAGE_OUTCOMES = Object.freeze({
    SUCCESS: 'success',
    EMPTY: 'empty',
    RATE_LIMITED: 'rate_limited',
    ERROR: 'error',
});

/** Why a collection run stopped. */
export const STOP_REASONS = Object.freeze({
    END: 'end', // pagination.nextPage is absent: the result set is exhausted
    EMPTY: 'empty', // the page came back with an empty properties array
    SINGLE: 'single', // the keyword resolved to a single property
    RATE_LIMITED: 'rate_limited', // retries exhausted
    ERROR: 'error', // a non-rate-limit failure
    MAX_PAGES: 'max_pages', // the per-run page budget was reached
    PAGINATION_LOOP: 'pagination_loop', // nextPage points at a page already fetched
    ALREADY_COMPLETE: 'already_complete', // resume input had nothing left to fetch
});

export const DEFAULT_MAX_PAGES = 20;

export const DEFAULT_RETRY = Object.freeze({
    retries: 3, // retries after the first attempt, so up to 4 requests per page
    baseDelayMs: 1000,
    factor: 2, // delays of 1s, 2s, 4s by default
});

/** An MCP tool call that failed, carrying enough detail to classify it. */
export class ToolCallError extends Error {
    constructor(message, { status, body, data } = {}) {
        super(message);
        this.name = 'ToolCallError';
        if (status !== undefined) this.status = status;
        if (body !== undefined) this.body = body;
        if (data !== undefined) this.data = data;
    }
}

const toText = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

/**
 * True when a failure is a rate limit: an HTTP 429, or anything carrying the
 * `concurrency_limit` marker HasData uses on the free plans.
 */
export function isRateLimited(error) {
    if (!error) return false;
    if (Number(error.status) === 429) return true;
    if (Number(error.statusCode) === 429) return true;
    const haystack = [error.message, error.body, toText(error.data)].filter(Boolean).join('\n');
    return haystack.includes('concurrency_limit');
}

/**
 * True when a tool payload is a concurrency-limit notice rather than listings.
 *
 * The endpoint sometimes answers 200 with a body carrying `concurrency_limit`
 * instead of failing the request, so the marker has to be checked on the
 * payload too. A real listing or page is never treated as a limit notice.
 */
export function payloadSignalsRateLimit(payload) {
    if (!payload || typeof payload !== 'object') return false;
    // A real page or property is never a limit notice, even if an agent-written
    // description happens to contain the marker.
    if (Array.isArray(payload.properties)) return false;
    if (payload.property !== undefined || payload.id !== undefined || payload.url !== undefined) return false;
    return toText(payload).includes('concurrency_limit');
}

function parseJsonText(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false };
    }
}

/**
 * Pull the tool payload out of a JSON-RPC `tools/call` response.
 *
 * Handles `structuredContent`, one or more `text` content blocks holding JSON,
 * and a bare payload object. Throws ToolCallError for JSON-RPC errors and for
 * `result.isError` responses.
 */
export function extractToolPayload(message) {
    if (!message || typeof message !== 'object') {
        throw new ToolCallError('the tool call returned no JSON-RPC message');
    }
    if (message.error) {
        const error = message.error;
        throw new ToolCallError(
            error.message || 'the tool call returned a JSON-RPC error',
            { data: error.data ?? error }
        );
    }

    const result = message.result ?? message;

    if (result && typeof result === 'object' && result.isError) {
        const text = (Array.isArray(result.content) ? result.content : [])
            .filter((block) => block && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n');
        throw new ToolCallError(text || 'the tool returned an error result', { body: text });
    }

    if (result && typeof result === 'object' && result.structuredContent
        && typeof result.structuredContent === 'object') {
        return result.structuredContent;
    }

    const blocks = (result && Array.isArray(result.content) ? result.content : [])
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text);

    for (const text of blocks) {
        const parsed = parseJsonText(text);
        if (parsed.ok) return parsed.value;
    }
    if (blocks.length) {
        throw new ToolCallError('the tool returned text that is not JSON', { body: blocks.join('\n') });
    }

    // No content wrapper: assume the result already is the payload.
    return result;
}

function asPageNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const n = Number(value);
        return n >= 1 ? n : null;
    }
    return null;
}

/**
 * Classify a tool payload as a market page or a single-property hit.
 *
 * Presence of a `properties` array is the only test. It is deliberate: a
 * single-property response shares no fields with a market page, and guessing
 * from other keys would let an empty page be mistaken for an address hit.
 */
export function classifyPayload(payload) {
    if (payload && typeof payload === 'object' && Array.isArray(payload.properties)) {
        return {
            shape: 'market',
            items: payload.properties,
            currentPage: asPageNumber(payload.pagination?.currentPage),
            nextPage: asPageNumber(payload.pagination?.nextPage),
        };
    }
    const property = payload && typeof payload === 'object' && payload.property
        && typeof payload.property === 'object'
        ? payload.property
        : payload;
    return {
        shape: 'single',
        items: property && typeof property === 'object' ? [property] : [],
        currentPage: null,
        nextPage: null,
    };
}

function isFiniteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string' && value.trim() !== '') return Number.isFinite(Number(value));
    return false;
}

/**
 * True when a listing has a price usable for market analysis.
 *
 * Rentals carry `{ min, max }`; the range counts as present when at least one
 * bound is a number. The object is never collapsed to a scalar.
 */
export function hasUsablePrice(listing) {
    if (!listing || typeof listing !== 'object') return false;
    const price = listing.price;
    if (price && typeof price === 'object' && !Array.isArray(price)) {
        return isFiniteNumber(price.min) || isFiniteNumber(price.max);
    }
    return isFiniteNumber(price);
}

function listingKey(listing) {
    if (!listing || typeof listing !== 'object') return null;
    if (listing.id !== undefined && listing.id !== null && listing.id !== '') return `id:${listing.id}`;
    if (typeof listing.url === 'string' && listing.url) return `url:${listing.url}`;
    return null;
}

function clonePage(page) {
    return { ...page };
}

function normalisePrevious(previous, { keyword, type }) {
    if (previous === undefined || previous === null) return null;
    if (typeof previous !== 'object') throw new TypeError('previous must be a collection result object');
    if (previous.keyword !== undefined && previous.keyword !== keyword) {
        throw new Error(
            `previous result was collected for keyword ${JSON.stringify(previous.keyword)}, `
            + `not ${JSON.stringify(keyword)}`
        );
    }
    if (previous.type !== undefined && previous.type !== type) {
        throw new Error(
            `previous result was collected for type ${JSON.stringify(previous.type)}, `
            + `not ${JSON.stringify(type)}`
        );
    }
    if (previous.pages !== undefined && !Array.isArray(previous.pages)) {
        throw new TypeError('previous.pages must be an array');
    }
    return previous;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Walk the listing search page by page.
 *
 * @param {object} options
 * @param {string} options.keyword zipcode, city, neighbourhood or address
 * @param {string} options.type `forSale`, `forRent` or `sold`
 * @param {(name: string, args: object) => Promise<object>} options.callTool
 *        JSON-RPC tool caller, e.g. `createHttpToolCaller({ apiKey })`
 * @param {number} [options.maxPages] pages to request in this run (default 20).
 *        Already-collected pages are not charged against it.
 * @param {object} [options.previous] result of an earlier run, to resume from
 * @param {object} [options.filters] extra listing filters passed straight through
 * @param {object} [options.retry] `{ retries, baseDelayMs, factor }`
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable for tests
 * @returns {Promise<object>} a JSON-serialisable collection result
 */
export async function collectListings({
    keyword,
    type,
    callTool,
    maxPages = DEFAULT_MAX_PAGES,
    previous = null,
    filters = {},
    retry = {},
    sleep = defaultSleep,
} = {}) {
    if (typeof keyword !== 'string' || !keyword.trim()) {
        throw new TypeError('keyword must be a non-empty string');
    }
    if (typeof type !== 'string' || !type.trim()) {
        throw new TypeError('type must be a non-empty string, e.g. "forSale"');
    }
    if (typeof callTool !== 'function') {
        throw new TypeError('callTool must be a function: (name, args) => Promise<jsonRpcMessage>');
    }
    if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new TypeError('maxPages must be a positive integer');
    }
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');

    const retryConfig = { ...DEFAULT_RETRY, ...retry };
    if (!Number.isInteger(retryConfig.retries) || retryConfig.retries < 0) {
        throw new TypeError('retry.retries must be a non-negative integer');
    }
    if (!(retryConfig.baseDelayMs >= 0) || !(retryConfig.factor >= 1)) {
        throw new TypeError('retry.baseDelayMs must be >= 0 and retry.factor >= 1');
    }

    const prior = normalisePrevious(previous, { keyword, type });

    // ---- Carry over what the previous run already collected -----------------
    const pages = Array.isArray(prior?.pages) ? prior.pages.map(clonePage) : [];
    const listings = [];
    const seenListingKeys = new Set();
    let dropped = 0;
    let duplicatesRemoved = 0;
    let singleHit = Boolean(prior?.singleHit);
    let stoppedReason = null;

    const addListing = (listing, { countDuplicate = true } = {}) => {
        const key = listingKey(listing);
        if (key !== null && seenListingKeys.has(key)) {
            if (countDuplicate) duplicatesRemoved += 1;
            return false;
        }
        if (key !== null) seenListingKeys.add(key);
        listings.push(listing);
        return true;
    };

    for (const listing of Array.isArray(prior?.listings) ? prior.listings : []) {
        addListing(listing, { countDuplicate: false });
    }
    if (prior) dropped += Number.isFinite(prior.dropped) ? prior.dropped : 0;
    if (prior && Number.isFinite(prior.duplicatesRemoved)) duplicatesRemoved = prior.duplicatesRemoved;

    const successfulPages = new Set(pages.filter((p) => p.outcome === PAGE_OUTCOMES.SUCCESS).map((p) => p.page));
    const unsetPage = pages.find((p) => p.outcome !== PAGE_OUTCOMES.SUCCESS);

    // ---- Decide where to start ---------------------------------------------
    // Prefer the per-page records, so a hand-carried or older result without a
    // top-level `nextPage` still resumes correctly.
    const lastPage = pages.length ? pages[pages.length - 1] : null;
    const priorNextPage = asPageNumber(prior?.nextPage)
        ?? (lastPage ? asPageNumber(lastPage.nextPage) : null);

    let startPage;
    if (singleHit) {
        startPage = null;
        stoppedReason = STOP_REASONS.ALREADY_COMPLETE;
    } else if (unsetPage) {
        // First page that never succeeded: retry it, then page on from there.
        startPage = unsetPage.page;
    } else if (pages.length && lastPage.nextPage == null) {
        startPage = null;
        stoppedReason = STOP_REASONS.ALREADY_COMPLETE;
    } else if (priorNextPage != null) {
        startPage = priorNextPage;
    } else if (prior && pages.length) {
        startPage = null;
        stoppedReason = STOP_REASONS.ALREADY_COMPLETE;
    } else {
        startPage = 1;
    }

    let nextPage = stoppedReason ? null : startPage;
    let requestedPage = startPage;
    let pagesFetched = 0;
    const fetchedThisRun = new Set();
    const staleRecords = new Set();

    // A page retried after an earlier failure replaces its old record rather
    // than leaving a stale failure in the history next to the new outcome.
    // Records carry the page they were asked for, so a shifted `currentPage`
    // does not confuse the match.
    const recordPage = (record) => {
        const stale = pages.findIndex(
            (p, index) => !staleRecords.has(index)
                && p.outcome !== PAGE_OUTCOMES.SUCCESS
                && (p.requestedPage ?? p.page) === record.requestedPage
        );
        if (stale !== -1) {
            pages[stale] = record;
            staleRecords.add(stale);
        } else {
            pages.push(record);
        }
    };

    // ---- Walk ---------------------------------------------------------------
    while (stoppedReason === null) {
        if (pagesFetched >= maxPages) {
            stoppedReason = STOP_REASONS.MAX_PAGES;
            break;
        }
        if (requestedPage == null) {
            stoppedReason = STOP_REASONS.END;
            nextPage = null;
            break;
        }
        if (fetchedThisRun.has(requestedPage) || successfulPages.has(requestedPage)) {
            // The server pointed us back at a page we already have. Stop rather
            // than loop; the caller can look at the page records.
            stoppedReason = STOP_REASONS.PAGINATION_LOOP;
            nextPage = null;
            break;
        }
        fetchedThisRun.add(requestedPage);

        const { payload, attempts, waitsMs, failure } = await requestPage({
            callTool,
            keyword,
            type,
            filters,
            page: requestedPage,
            retry: retryConfig,
            sleep,
        });
        pagesFetched += 1;

        const base = {
            requestedPage,
            attempts,
            waitsMs,
        };

        if (failure) {
            const outcome = failure.rateLimited ? PAGE_OUTCOMES.RATE_LIMITED : PAGE_OUTCOMES.ERROR;
            recordPage({
                ...base,
                page: requestedPage,
                outcome,
                shape: null,
                itemCount: 0,
                kept: 0,
                dropped: 0,
                nextPage: requestedPage,
                error: failure.message,
            });
            stoppedReason = failure.rateLimited ? STOP_REASONS.RATE_LIMITED : STOP_REASONS.ERROR;
            nextPage = requestedPage;
            break;
        }

        const classified = classifyPayload(payload);

        if (classified.shape === 'single') {
            const property = classified.items[0] ?? null;
            let kept = 0;
            let pageDropped = 0;
            if (property) {
                if (hasUsablePrice(property)) {
                    if (addListing(property)) kept = 1;
                } else {
                    pageDropped = 1;
                }
            }
            dropped += pageDropped;
            recordPage({
                ...base,
                page: requestedPage,
                outcome: PAGE_OUTCOMES.SUCCESS,
                shape: 'single',
                itemCount: property ? 1 : 0,
                kept,
                dropped: pageDropped,
                nextPage: null,
            });
            singleHit = true;
            stoppedReason = STOP_REASONS.SINGLE;
            nextPage = null;
            break;
        }

        const items = classified.items;
        const currentPage = classified.currentPage ?? requestedPage;
        const responseNextPage = classified.nextPage;
        let kept = 0;
        let pageDropped = 0;
        for (const listing of items) {
            if (!hasUsablePrice(listing)) {
                pageDropped += 1;
                continue;
            }
            if (addListing(listing)) kept += 1;
        }
        dropped += pageDropped;

        const outcome = items.length === 0 ? PAGE_OUTCOMES.EMPTY : PAGE_OUTCOMES.SUCCESS;
        const record = {
            ...base,
            page: currentPage,
            outcome,
            shape: 'market',
            itemCount: items.length,
            kept,
            dropped: pageDropped,
            nextPage: outcome === PAGE_OUTCOMES.EMPTY ? currentPage : responseNextPage,
        };
        recordPage(record);

        if (outcome === PAGE_OUTCOMES.EMPTY) {
            stoppedReason = STOP_REASONS.EMPTY;
            nextPage = currentPage;
            break;
        }

        successfulPages.add(currentPage);
        if (responseNextPage == null) {
            stoppedReason = STOP_REASONS.END;
            nextPage = null;
            break;
        }
        nextPage = responseNextPage;
        requestedPage = responseNextPage;
    }

    const result = {
        keyword,
        type,
        tool: LISTINGS_TOOL,
        pages,
        listings,
        dropped,
        duplicatesRemoved,
        singleHit,
        nextPage: stoppedReason === STOP_REASONS.ALREADY_COMPLETE ? null : nextPage,
        // `done` means the search itself is exhausted (or resolved to one
        // property). A rate limit, error, empty page or page budget leaves
        // more to fetch, so `done` stays false and the result can be resumed.
        done: stoppedReason === STOP_REASONS.END
            || stoppedReason === STOP_REASONS.SINGLE
            || stoppedReason === STOP_REASONS.ALREADY_COMPLETE,
        stoppedReason,
        pagesFetched,
        resumed: Boolean(prior),
    };
    return result;
}

async function requestPage({ callTool, keyword, type, filters, page, retry, sleep }) {
    const waitsMs = [];
    const maxAttempts = retry.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const message = await callTool(LISTINGS_TOOL, {
                ...filters,
                keyword,
                type,
                page,
            });
            const payload = extractToolPayload(message);
            if (payloadSignalsRateLimit(payload)) {
                // Thrown, not returned: this goes through the same retry path as a 429.
                throw new ToolCallError('the tool responded with concurrency_limit', { data: payload });
            }
            return { payload, attempts: attempt, waitsMs };
        } catch (error) {
            const rateLimited = isRateLimited(error);
            if (!rateLimited || attempt === maxAttempts) {
                return {
                    failure: {
                        rateLimited,
                        message: error?.message || String(error),
                    },
                    attempts: attempt,
                    waitsMs,
                };
            }
            const delay = retry.baseDelayMs * retry.factor ** (attempt - 1);
            waitsMs.push(delay);
            await sleep(delay);
        }
    }

    // Unreachable: the loop always returns on its last attempt.
    return { failure: { rateLimited: false, message: 'retry loop ended unexpectedly' }, attempts: maxAttempts, waitsMs };
}

/**
 * Convenience wrapper that builds the HTTP tool caller for you.
 *
 * @param {object} options passed to collectListings, plus `apiKey`, `endpoint`,
 *        `fetchImpl` and `timeoutMs` for the transport
 */
export async function collectListingsFromApi({
    apiKey,
    endpoint,
    fetchImpl,
    timeoutMs,
    callTool,
    ...collectOptions
} = {}) {
    const caller = callTool ?? createHttpToolCaller({ apiKey, endpoint, fetchImpl, timeoutMs });
    return collectListings({ ...collectOptions, callTool: caller });
}
