// Review collection flow for hasdata_walmart_reviews_getWalmartReviews.
//
// Why a flow rather than a single tool call: Walmart review filters (star rating, topic
// aspectId, condition, verified-purchase-only) only accept values the item actually supports.
// Guessing an aspectId is the standard way to earn an empty page, so the flow always sends one
// unfiltered request first, keeps the filters block verbatim (every parameter/value pair), and
// only then issues filtered requests using values read from that block.
//
// Outcomes per page are deliberately distinguished:
//   ok               - HTTP 200 with reviews (an empty page from an unfiltered probe is still ok)
//   empty_no_matches - HTTP 200, zero reviews while filters were applied (a filter matched nothing)
//   rate_limited     - 429 on every attempt including the retries; the retry trail is reported too
//   error            - any other non-200 / transport / tool failure
// An empty_no_matches page and a rate_limited page must never both read as "no reviews".
//
// Billing: only a 200 response is billed, including a successful empty page. Every non-200
// attempt (each 429, each other failure) is counted as a failed request and never billed, even
// when a later retry of the same page succeeds.
//
// Review dates arrive as M/D/YYYY strings ("8/1/2026" = August 1st). They are parsed against
// that format explicitly rather than handed to a date parser that guesses the order.

export const REVIEW_TOOL = 'hasdata_walmart_reviews_getWalmartReviews';

export const PAGE_OUTCOMES = Object.freeze({
    OK: 'ok',
    EMPTY_NO_MATCHES: 'empty_no_matches',
    RATE_LIMITED: 'rate_limited',
    ERROR: 'error',
});

export const STOP_REASONS = Object.freeze({
    MAX_PAGES: 'max_pages',
    NO_NEXT_PAGE: 'no_next_page',
    EMPTY_NO_MATCHES: 'empty_no_matches',
    RATE_LIMITED: 'rate_limited',
    ERROR: 'error',
});

// Fields that name a human reviewer. Stripped unless the caller explicitly opts in.
const AUTHOR_FIELDS = ['author', 'authorName', 'reviewer', 'reviewerName', 'user', 'userName', 'nickname'];

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(month, year) {
    if (month === 2 && isLeapYear(year)) return 29;
    return MONTH_DAYS[month - 1];
}

/**
 * Parse a Walmart review date in strict M/D/YYYY form (no leading zeros required).
 * Returns a UTC Date, or null when the input is not exactly that shape or is not a real date.
 * A date library is deliberately not used: "8/1/2026" must be August 1st, never January 8th.
 */
export function parseReviewDate(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
    if (!match) return null;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) return null;
    return new Date(Date.UTC(year, month - 1, day));
}

function reviewDateIso(value) {
    const parsed = parseReviewDate(value);
    return parsed ? parsed.toISOString().slice(0, 10) : null;
}

// An empty reviewResults on a filtered request means the filter matched nothing. An empty
// unfiltered page means the item has no reviews at all, which is a normal successful feed.
function isFilterEmpty(payload) {
    return !Array.isArray(payload.reviewResults) || payload.reviewResults.length === 0;
}

function sanitizeReview(review, includeAuthor) {
    const entries = Object.entries(review).filter(([key]) => includeAuthor || !AUTHOR_FIELDS.includes(key));
    const clean = Object.fromEntries(entries);
    const dateParsed = reviewDateIso(review.date);
    return {
        ...clean,
        dateParsed,
        // Explicit even when null, so a caller can distinguish unparseable from missing.
        ...(dateParsed === null && review.date != null
            ? { dateParseError: `date ${JSON.stringify(review.date)} is not M/D/YYYY or is not a real date` }
            : {}),
    };
}

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeAttempts(localAttempts) {
    const billed = localAttempts.filter((event) => event.outcome === PAGE_OUTCOMES.OK).length;
    return { billed, failed: localAttempts.length - billed };
}

/**
 * Retry an MCP tool call with exponential backoff on HTTP 429 only. Every other failure ends
 * the attempt immediately. `onAttempt` lets the collector audit and bill each try.
 *
 * maxRetries counts retries *after* the first attempt, so maxRetries = 2 allows 3 attempts.
 */
async function callWithRetries(callTool, name, args, { maxRetries, baseBackoffMs, sleep, onAttempt }) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const result = await callTool(name, args);
            onAttempt?.({ attempt, retried: attempt - 1, outcome: PAGE_OUTCOMES.OK });
            return { result, attempts: attempt, retries: attempt - 1, lastError: null, rateLimited: false };
        } catch (error) {
            lastError = error;
            const retriable = error?.isRateLimited === true;
            if (retriable && attempt <= maxRetries) {
                const retryAfter = typeof error.retryAfterMs === 'number' ? error.retryAfterMs : null;
                const delay = retryAfter ?? baseBackoffMs * 2 ** (attempt - 1);
                onAttempt?.({ attempt, retried: attempt - 1, outcome: PAGE_OUTCOMES.RATE_LIMITED, delayMs: delay });
                await sleep(delay);
                continue;
            }
            onAttempt?.({
                attempt,
                retried: attempt - 1,
                outcome: retriable ? PAGE_OUTCOMES.RATE_LIMITED : PAGE_OUTCOMES.ERROR,
            });
            return {
                result: null,
                attempts: attempt,
                retries: attempt - 1,
                lastError: error,
                rateLimited: retriable,
            };
        }
    }
    // Unreachable in practice: the loop always returns, but keeps the contract explicit.
    return { result: null, attempts: maxRetries + 1, retries: maxRetries, lastError, rateLimited: true };
}

function serializeError(error) {
    return {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        status: error?.status ?? null,
        isRateLimited: error?.isRateLimited === true,
    };
}

/**
 * Turn caller filter selectors into argument pairs using only values the filters block offers.
 * Nothing is guessed: an unknown parameter or value is an error before any filtered call.
 *
 * Selector forms:
 *   { parameter: 'rating', value: '5' }                    - value taken verbatim from filters
 *   { parameter: 'aspectId', name: 'Battery Life' }        - value looked up by the value name
 *   { parameter: 'verifiedPurchasesOnly', value: 'true' }  - coerced to boolean at send time
 */
export function resolveFilterSelectors(selectors, filtersBlock) {
    const groups = new Map();
    for (const group of filtersBlock ?? []) {
        if (group?.parameter) groups.set(group.parameter, group);
    }

    const resolved = [];
    for (const selector of selectors ?? []) {
        const parameter = selector?.parameter;
        if (!parameter || (selector.value === undefined && selector.name === undefined)) {
            throw new Error(`filter selector needs a parameter and a value or name: ${JSON.stringify(selector)}`);
        }
        const group = groups.get(parameter);
        if (!group) {
            throw new Error(
                `this item has no filter parameter ${JSON.stringify(parameter)}; offered: ${
                    [...groups.keys()].join(', ') || 'none'
                }`
            );
        }

        let valueEntry;
        if (selector.value !== undefined) {
            valueEntry = (group.values ?? []).find((entry) => String(entry.value) === String(selector.value));
            if (!valueEntry) {
                throw new Error(
                    `parameter ${JSON.stringify(parameter)} does not offer value ${JSON.stringify(
                        selector.value
                    )}; offered: ${(group.values ?? []).map((entry) => JSON.stringify(entry.value)).join(', ') || 'none'}`
                );
            }
        } else {
            valueEntry = (group.values ?? []).find((entry) => entry.name === selector.name);
            if (!valueEntry) {
                throw new Error(
                    `parameter ${JSON.stringify(parameter)} does not offer a value named ${JSON.stringify(
                        selector.name
                    )}; offered: ${(group.values ?? []).map((entry) => JSON.stringify(entry.name)).join(', ') || 'none'}`
                );
            }
        }

        resolved.push({
            parameter,
            // The block's name/value/count are kept exactly as received; only the key needed to
            // call the tool is projected back onto request arguments.
            value: valueEntry.value,
            valueName: valueEntry.name,
            count: valueEntry.count ?? null,
        });
    }
    return resolved;
}

// Build tool arguments. Filter values are sent verbatim. verifiedPurchasesOnly is a boolean
// tool parameter even though the filters block advertises it as a string value, so that one
// known parameter is coerced; every other value passes through untouched.
function buildToolArgs(baseArgs, page, resolvedFilters) {
    const args = { ...baseArgs, page };
    for (const filter of resolvedFilters) {
        if (filter.parameter === 'verifiedPurchasesOnly') {
            args[filter.parameter] = filter.value === true || String(filter.value).toLowerCase() === 'true';
        } else {
            args[filter.parameter] = filter.value;
        }
    }
    return args;
}

/**
 * Collect Walmart reviews with a filter-discovery probe and nextPage-driven paging.
 *
 * @param {object}   options
 * @param {Function} options.callTool          - (name, args) => parsed tool payload (injectable)
 * @param {string}   [options.itemId]          - Walmart item id
 * @param {string}   [options.url]             - product URL instead of itemId
 * @param {object}   [options.baseArgs={}]     - extra tool args (domain, language, sort, ...)
 * @param {Array}    [options.filters=[]]      - selectors resolved against the filters block
 * @param {number}   [options.maxPages=3]      - collected review pages at most (probe not counted)
 * @param {number}   [options.maxRetries=3]    - 429 retries per request, after the first attempt
 * @param {number}   [options.baseBackoffMs=1000] - exponential backoff base
 * @param {Function} [options.sleep]           - injectable sleeper for deterministic tests
 * @param {boolean}  [options.includeAuthor=false] - keep reviewer identity fields
 */
export async function collectReviews({
    callTool,
    itemId,
    url,
    baseArgs = {},
    filters: selectors = [],
    maxPages = 3,
    maxRetries = 3,
    baseBackoffMs = 1000,
    sleep = defaultSleep,
    includeAuthor = false,
} = {}) {
    if (typeof callTool !== 'function') throw new Error('collectReviews needs a callTool function');
    if (!itemId && !url) throw new Error('collectReviews needs an itemId or a url');
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('maxPages must be a positive integer');
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('maxRetries must be a non-negative integer');

    const baseToolArgs = { ...baseArgs };
    if (itemId) baseToolArgs.itemId = String(itemId);
    if (url) baseToolArgs.url = url;

    // Global audit + billing counters. Every attempt lands here; a 200 bills, anything else fails.
    const attempts = [];
    let requestsBilled = 0;
    let requestsFailed = 0;
    const recordAttempt = (event) => {
        attempts.push(event);
        if (event.outcome === PAGE_OUTCOMES.OK) requestsBilled += 1;
        else requestsFailed += 1;
    };

    const runPage = async (args) => {
        const localAttempts = [];
        const call = await callWithRetries(callTool, REVIEW_TOOL, args, {
            maxRetries,
            baseBackoffMs,
            sleep,
            onAttempt: (event) => {
                recordAttempt(event);
                localAttempts.push(event);
            },
        });
        const { billed, failed } = summarizeAttempts(localAttempts);
        return { call, billed, failed };
    };

    // Step 1: one unfiltered request. It carries the filters block and is also review page 1.
    const probeRun = await runPage({ ...baseToolArgs, page: 1 });

    if (probeRun.call.lastError) {
        const rateLimited = probeRun.call.rateLimited;
        const outcome = rateLimited ? PAGE_OUTCOMES.RATE_LIMITED : PAGE_OUTCOMES.ERROR;
        return {
            stopReason: rateLimited ? STOP_REASONS.RATE_LIMITED : STOP_REASONS.ERROR,
            totalRatings: null,
            totalReviews: null,
            filters: [],
            appliedFilters: [],
            probe: {
                role: 'probe',
                page: 1,
                outcome,
                attempts: probeRun.call.attempts,
                retries: probeRun.call.retries,
                requestsBilled: probeRun.billed,
                requestsFailed: probeRun.failed,
                error: serializeError(probeRun.call.lastError),
            },
            pages: [],
            reviews: [],
            pagesCollected: 0,
            requestsBilled,
            requestsFailed,
            totalAttempts: attempts.length,
            attempts,
        };
    }

    const probePayload = probeRun.call.result;
    const filtersBlock = Array.isArray(probePayload.filters) ? probePayload.filters : [];
    const information = probePayload.reviewsInformation ?? {};

    // Validate every selector against the block before spending a filtered call.
    const resolvedFilters = resolveFilterSelectors(selectors, filtersBlock);
    const filtersApplied = resolvedFilters.length > 0;

    const probeRecord = {
        role: 'probe',
        page: 1,
        outcome: PAGE_OUTCOMES.OK,
        attempts: probeRun.call.attempts,
        retries: probeRun.call.retries,
        requestsBilled: probeRun.billed,
        requestsFailed: probeRun.failed,
        totalResults: probePayload.pagination?.totalResults ?? null,
        nextPage: probePayload.pagination?.nextPage ?? null,
        reviewCount: Array.isArray(probePayload.reviewResults) ? probePayload.reviewResults.length : 0,
    };

    const finish = (pages, stopReason) => ({
        stopReason,
        // The two totals stay separate: totalRatings counts star ratings, totalReviews written reviews.
        totalRatings: information.totalRatings ?? null,
        totalReviews: information.totalReviews ?? null,
        // The filters block, with every parameter and value preserved exactly as received.
        filters: filtersBlock,
        appliedFilters: resolvedFilters.map(({ parameter, value, valueName, count }) => ({
            parameter,
            value,
            valueName,
            count,
        })),
        probe: probeRecord,
        pages,
        reviews: pages.flatMap((pageRecord) => pageRecord.reviews),
        // A rate-limited/error page is in `pages` for its audit trail but is not a collected page.
        pagesCollected: pages.filter((pageRecord) => pageRecord.outcome === PAGE_OUTCOMES.OK).length,
        requestsBilled,
        requestsFailed,
        totalAttempts: attempts.length,
        attempts,
    });

    // Unfiltered mode: the probe itself is the first collected page.
    if (!filtersApplied) {
        const pages = [];
        const probeReviews = (probePayload.reviewResults ?? []).map((review) =>
            sanitizeReview(review, includeAuthor)
        );
        pages.push({ ...probeRecord, role: 'page', reviews: probeReviews });

        // No reviews at all is a successful empty feed, not a filter mismatch.
        let nextPage = probeReviews.length ? probePayload.pagination?.nextPage ?? null : null;
        const seenCursors = new Set([1]);

        while (nextPage != null && pages.length < maxPages) {
            if (seenCursors.has(nextPage)) break; // defensive: a stuck cursor must not loop forever
            seenCursors.add(nextPage);

            const { call, billed, failed } = await runPage({ ...baseToolArgs, page: nextPage });

            if (call.lastError) {
                const rateLimited = call.rateLimited;
                pages.push({
                    role: 'page',
                    page: nextPage,
                    outcome: rateLimited ? PAGE_OUTCOMES.RATE_LIMITED : PAGE_OUTCOMES.ERROR,
                    attempts: call.attempts,
                    retries: call.retries,
                    requestsBilled: billed,
                    requestsFailed: failed,
                    error: serializeError(call.lastError),
                    reviews: [],
                });
                return finish(pages, rateLimited ? STOP_REASONS.RATE_LIMITED : STOP_REASONS.ERROR);
            }

            const payload = call.result;
            const pageReviews = (payload.reviewResults ?? []).map((review) =>
                sanitizeReview(review, includeAuthor)
            );
            pages.push({
                role: 'page',
                page: nextPage,
                outcome: PAGE_OUTCOMES.OK,
                attempts: call.attempts,
                retries: call.retries,
                requestsBilled: billed,
                requestsFailed: failed,
                totalResults: payload.pagination?.totalResults ?? null,
                nextPage: payload.pagination?.nextPage ?? null,
                reviews: pageReviews,
            });
            nextPage = pageReviews.length ? payload.pagination?.nextPage ?? null : null;
        }

        return finish(
            pages,
            pages.length >= maxPages && nextPage != null ? STOP_REASONS.MAX_PAGES : STOP_REASONS.NO_NEXT_PAGE
        );
    }

    // Filtered mode: the probe was discovery only; re-request page 1 with the resolved filters.
    const pages = [];
    let nextPage = 1;
    const seenCursors = new Set();

    while (nextPage != null && pages.length < maxPages) {
        if (seenCursors.has(nextPage)) break;
        seenCursors.add(nextPage);

        const { call, billed, failed } = await runPage(buildToolArgs(baseToolArgs, nextPage, resolvedFilters));

        if (call.lastError) {
            const rateLimited = call.rateLimited;
            pages.push({
                role: 'page',
                page: nextPage,
                outcome: rateLimited ? PAGE_OUTCOMES.RATE_LIMITED : PAGE_OUTCOMES.ERROR,
                attempts: call.attempts,
                retries: call.retries,
                requestsBilled: billed,
                requestsFailed: failed,
                error: serializeError(call.lastError),
                reviews: [],
            });
            return finish(pages, rateLimited ? STOP_REASONS.RATE_LIMITED : STOP_REASONS.ERROR);
        }

        const payload = call.result;

        // A 200 with no reviews while filtering means the filter matched nothing: billed, not failed.
        if (isFilterEmpty(payload)) {
            pages.push({
                role: 'page',
                page: nextPage,
                outcome: PAGE_OUTCOMES.EMPTY_NO_MATCHES,
                attempts: call.attempts,
                retries: call.retries,
                requestsBilled: billed,
                requestsFailed: failed,
                totalResults: payload.pagination?.totalResults ?? null,
                nextPage: null,
                reviews: [],
            });
            return finish(pages, STOP_REASONS.EMPTY_NO_MATCHES);
        }

        const pageReviews = (payload.reviewResults ?? []).map((review) =>
            sanitizeReview(review, includeAuthor)
        );
        pages.push({
            role: 'page',
            page: nextPage,
            outcome: PAGE_OUTCOMES.OK,
            attempts: call.attempts,
            retries: call.retries,
            requestsBilled: billed,
            requestsFailed: failed,
            totalResults: payload.pagination?.totalResults ?? null,
            nextPage: payload.pagination?.nextPage ?? null,
            reviews: pageReviews,
        });
        nextPage = payload.pagination?.nextPage ?? null;
    }

    return finish(
        pages,
        pages.length >= maxPages && nextPage != null ? STOP_REASONS.MAX_PAGES : STOP_REASONS.NO_NEXT_PAGE
    );
}
