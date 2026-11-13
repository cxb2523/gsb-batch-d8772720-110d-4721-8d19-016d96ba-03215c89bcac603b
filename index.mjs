#!/usr/bin/env node
// Thin launcher: connects an MCP client to HasData's hosted Google Maps MCP server
// (streamable HTTP) through the mcp-remote stdio bridge. The server runs remotely;
// this package only proxies, so nothing here scrapes anything.
//
// When imported (rather than executed), the stdio bridge is not started and the module
// instead exposes collectPlaceReviews(): a self-paging collector for a single place's
// full Google Maps review feed, with per-page bookkeeping and explicit stop reasons.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HASDATA_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=google_maps';
export const REVIEWS_TOOL = 'hasdata_google_maps_reviews_getMapReviews';

// Stable reason codes returned on page records and on the summary's stopReason.
export const REASONS = Object.freeze({
    CONCURRENCY_LIMIT: 'concurrency_limit',
    UNAUTHORIZED: 'unauthorized',
    INVALID_PLACE: 'invalid_place',
    TIMEOUT: 'timeout',
    NETWORK_ERROR: 'network_error',
    INVALID_RESPONSE: 'invalid_response',
    UNKNOWN: 'unknown',
});

// Why the collector stopped paging. The three *_LIMIT reasons are deliberate local
// caps; the rest mark either natural end-of-data or a failure.
export const STOP_REASONS = Object.freeze({
    NO_NEXT_PAGE: 'no_next_page',
    EMPTY_PAGE: 'empty_page',
    MAX_PAGES: 'max_pages',
    MAX_REVIEWS: 'max_reviews',
    RETRY_EXHAUSTED: 'retry_exhausted',
    PAGE_FAILED: 'page_failed',
});

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3; // retries after the first attempt, so 4 attempts in total
const DEFAULT_BACKOFF_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A streamable HTTP body arrives either as plain JSON or as server-sent events. One SSE
// event can span several data: lines, several events can share one response, and a server
// is free to send progress notifications before the answer. So collect every event and
// pick the message carrying our request id.
function parseRpcMessage(raw, id) {
    const trimmed = raw.trim();
    let messages;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        messages = [JSON.parse(trimmed)];
    } else {
        messages = [];
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
                // A keep-alive or a partial event is not our response.
            }
        }
    }
    const match = messages.find((message) => message.id === id);
    if (!match) {
        const error = new Error(`no JSON-RPC message with id ${id} in response: ${raw.slice(0, 300)}`);
        error.reason = REASONS.INVALID_RESPONSE;
        throw error;
    }
    return match;
}

// Map any failure to one of the documented reason codes. The concurrency check goes
// first because a 429 body can carry either an HTTP status or MCP-level error text.
function classifyError(status, text, fallbackReason = REASONS.UNKNOWN) {
    const body = `${status ?? ''} ${text ?? ''}`;
    if (status === 429 || /concurrency[_ ]limit/i.test(body) || /\b429\b/.test(body)) {
        return REASONS.CONCURRENCY_LIMIT;
    }
    if (status === 401 || /401\s*Unauthorized/i.test(body)) {
        return REASONS.UNAUTHORIZED;
    }
    if (status === 400 || /400\s*Bad\s*Request/i.test(body)) {
        return REASONS.INVALID_PLACE;
    }
    if (status === 422 && !/429|401|400/.test(body)) {
        return REASONS.INVALID_PLACE;
    }
    return fallbackReason;
}

function failureFromException(error) {
    // AbortSignal.timeout() rejects with a TimeoutError; a manually aborted request
    // lands here with name AbortError. Only the former is a network timeout.
    if (error?.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(error?.message ?? '')) {
        return { reason: REASONS.TIMEOUT, message: `network timeout: ${error.message}` };
    }
    if (error?.reason) {
        return { reason: error.reason, message: error.message };
    }
    return { reason: REASONS.NETWORK_ERROR, message: `network error: ${error.message}` };
}

// One tools/call against the reviews tool, with the envelope fully unwrapped.
// Returns { ok, reviews, nextPageToken } on success or { ok:false, reason, message, status }.
async function requestReviewsPage({ endpoint, key, toolName, args, requestId, timeoutMs, fetchImpl }) {
    try {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                'x-api-key': key,
                'Content-Type': 'application/json',
                // The server answers over streamable HTTP, so accept both a plain body and a stream.
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                method: 'tools/call',
                params: { name: toolName, arguments: args },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });

        const raw = await response.text();

        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                reason: classifyError(response.status, raw),
                message: `HTTP ${response.status}: ${raw.slice(0, 300)}`,
            };
        }

        const message = parseRpcMessage(raw, requestId);

        // JSON-RPC level failure (e.g. MCP error -32602 input validation).
        if (message.error) {
            const text = typeof message.error === 'object'
                ? JSON.stringify(message.error)
                : String(message.error);
            return {
                ok: false,
                reason: classifyError(null, text),
                message: text,
            };
        }

        const result = message.result;
        // The MCP layer answers 200 and puts tool failures inside the result.
        if (result?.isError) {
            const text = result.content?.map((block) => block.text).filter(Boolean).join(' ') ?? raw;
            return {
                ok: false,
                reason: classifyError(null, text),
                message: text.slice(0, 500),
            };
        }

        const textBlock = result?.content?.[0]?.text;
        if (!textBlock) {
            return {
                ok: false,
                reason: REASONS.INVALID_RESPONSE,
                message: 'tools/call returned no text block',
            };
        }

        let envelope;
        try {
            envelope = JSON.parse(textBlock);
        } catch (error) {
            return {
                ok: false,
                reason: REASONS.INVALID_RESPONSE,
                message: `text block is not JSON: ${error.message}`,
            };
        }

        const payload = envelope.json;
        if (!payload) {
            return {
                ok: false,
                reason: REASONS.INVALID_RESPONSE,
                message: 'response envelope carried no json payload',
            };
        }

        const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
        const nextPageToken = payload.pagination?.nextPageToken
            ? String(payload.pagination.nextPageToken)
            : null;
        return { ok: true, reviews, nextPageToken, raw: payload };
    } catch (error) {
        return { ok: false, ...failureFromException(error) };
    }
}

/**
 * @typedef {Object} ReviewPageRecord
 * @property {number} page                 1-based page number
 * @property {number} reviewCount          reviews returned on this page
 * @property {number} collectedCount       reviews from this page actually kept (can be lower under maxReviews)
 * @property {boolean} success             whether the page was fetched and unwrapped successfully
 * @property {number} attempts             HTTP attempts made for this page (1 + retries)
 * @property {string|null} failureReason   one of REASONS, or null on success
 * @property {string|null} failureMessage  raw failure detail, or null on success
 * @property {boolean} hasNextPage         whether the response carried a nextPageToken
 * @property {boolean} truncated           true when the page was cut short by maxReviews
 */

/**
 * @typedef {Object} CollectPlaceReviewsResult
 * @property {Array} reviews               every collected review, in page order
 * @property {number} reviewCount          total collected reviews
 * @property {number} pagesFetched         number of pages successfully fetched
 * @property {ReviewPageRecord[]} pageRecords  one record per attempted page
 * @property {boolean} completed           true only when paging reached natural end-of-data or a local cap
 * @property {string} stopReason           one of STOP_REASONS
 * @property {boolean} truncatedByMaxReviews true when maxReviews cut the feed short
 * @property {string|null} failureReason   REASONS code when the batch stopped on a failure, else null
 * @property {string|null} failureMessage  detail for failureReason, else null
 * @property {string|null} nextPageToken   token for the un-fetched page when the batch is incomplete
 */

/**
 * Collect every Google Maps review for one place, following nextPageToken until the
 * feed ends or a local cap / failure stops paging.
 *
 * @param {Object} [options]
 * @param {string} [options.placeId]       place id; either placeId or dataId is required
 * @param {string} [options.dataId]        data id; accepted instead of placeId
 * @param {string} [options.sortBy]        mostRelevant (default), newestFirst, ratingHigh, ratingLow
 * @param {string} [options.hl]            two-letter language code
 * @param {number} [options.maxPages]      stop after this many pages
 * @param {number} [options.maxReviews]    stop once this many reviews are collected
 * @param {number} [options.timeoutMs]     per-request timeout (default 60000)
 * @param {number} [options.maxRetries]    retries for 429 concurrency limits (default 3)
 * @param {number} [options.backoffMs]     base backoff; attempt n waits backoffMs * 2^(n-1)
 * @param {Function} [options.fetchImpl]   fetch-compatible transport, for testing
 * @returns {Promise<CollectPlaceReviewsResult>}
 */
export async function collectPlaceReviews(options = {}) {
    const {
        placeId,
        dataId,
        sortBy,
        hl,
        maxPages,
        maxReviews,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxRetries = DEFAULT_MAX_RETRIES,
        backoffMs = DEFAULT_BACKOFF_MS,
        fetchImpl = fetch,
    } = options;

    // Both preconditions fail fast, before any network work.
    if (!placeId && !dataId) {
        throw new Error('collectPlaceReviews requires a placeId or a dataId; pass at least one.');
    }
    const key = process.env.HASDATA_API_KEY;
    if (!key) {
        throw new Error('HASDATA_API_KEY is not set. Create a free key at https://app.hasdata.com and set HASDATA_API_KEY.');
    }
    for (const [name, value] of [['maxPages', maxPages], ['maxReviews', maxReviews]]) {
        if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
            throw new Error(`${name} must be a positive integer when provided, got ${String(value)}`);
        }
    }

    const baseArgs = {};
    if (placeId) baseArgs.placeId = placeId;
    else baseArgs.dataId = dataId;
    if (sortBy) baseArgs.sortBy = sortBy;
    if (hl) baseArgs.hl = hl;

    const reviews = [];
    const pageRecords = [];
    let nextPageToken = null;
    let requestId = 0;
    let stopReason = null;
    let failureReason = null;
    let failureMessage = null;
    let truncatedByMaxReviews = false;

    while (true) {
        const page = pageRecords.length + 1;
        const args = { ...baseArgs };
        if (nextPageToken) args.nextPageToken = nextPageToken;

        let attempt = 0;
        let outcome;
        while (true) {
            attempt += 1;
            outcome = await requestReviewsPage({
                endpoint: HASDATA_ENDPOINT,
                key,
                toolName: REVIEWS_TOOL,
                args,
                requestId: ++requestId,
                timeoutMs,
                fetchImpl,
            });
            if (outcome.ok || outcome.reason !== REASONS.CONCURRENCY_LIMIT || attempt > maxRetries) {
                break;
            }
            // Back off on the concurrency ceiling (free plans allow very few parallel
            // requests) and try the same page again.
            await sleep(backoffMs * 2 ** (attempt - 1));
        }

        if (!outcome.ok) {
            const exhausted = outcome.reason === REASONS.CONCURRENCY_LIMIT && attempt > maxRetries;
            pageRecords.push({
                page,
                reviewCount: 0,
                collectedCount: 0,
                success: false,
                attempts: attempt,
                failureReason: outcome.reason,
                failureMessage: outcome.message,
                hasNextPage: false,
                truncated: false,
            });
            stopReason = exhausted ? STOP_REASONS.RETRY_EXHAUSTED : STOP_REASONS.PAGE_FAILED;
            failureReason = outcome.reason;
            failureMessage = outcome.message;
            break;
        }

        const pageReviews = outcome.reviews;
        const room = maxReviews !== undefined ? maxReviews - reviews.length : Infinity;
        const kept = pageReviews.slice(0, Math.max(0, room));
        const truncated = kept.length < pageReviews.length;
        reviews.push(...kept);
        truncatedByMaxReviews = truncatedByMaxReviews || truncated;

        const hasNextPage = Boolean(outcome.nextPageToken);
        pageRecords.push({
            page,
            reviewCount: pageReviews.length,
            collectedCount: kept.length,
            success: true,
            attempts: attempt,
            failureReason: null,
            failureMessage: null,
            hasNextPage,
            truncated,
        });

        // Local caps and natural endings, checked in the order they become relevant.
        if (maxReviews !== undefined && reviews.length >= maxReviews) {
            stopReason = STOP_REASONS.MAX_REVIEWS;
            break;
        }
        if (pageReviews.length === 0) {
            stopReason = STOP_REASONS.EMPTY_PAGE;
            break;
        }
        if (maxPages !== undefined && page >= maxPages) {
            stopReason = STOP_REASONS.MAX_PAGES;
            break;
        }
        if (!hasNextPage) {
            stopReason = STOP_REASONS.NO_NEXT_PAGE;
            break;
        }
        nextPageToken = outcome.nextPageToken;
    }

    const failed = stopReason === STOP_REASONS.RETRY_EXHAUSTED || stopReason === STOP_REASONS.PAGE_FAILED;
    return {
        reviews,
        reviewCount: reviews.length,
        pagesFetched: pageRecords.filter((record) => record.success).length,
        pageRecords,
        // A local cap or end-of-data is a completed batch; a failed page is not.
        completed: !failed,
        stopReason,
        truncatedByMaxReviews,
        failureReason,
        failureMessage,
        nextPageToken: failed ? nextPageToken : null,
    };
}

// Running the file as the bin starts the stdio bridge. Importing it (the collector
// tests do this) must leave the bridge untouched.
const invokedDirectly = (() => {
    try {
        return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
    } catch {
        return false;
    }
})();

if (invokedDirectly) {
    const URL = HASDATA_ENDPOINT;
    const key = process.env.HASDATA_API_KEY;
    if (!key) {
        process.stderr.write('HASDATA_API_KEY is not set. Create a free key at https://app.hasdata.com and set HASDATA_API_KEY.\n');
        process.exit(1);
    }
    // Resolve mcp-remote's CLI from its own package.json bin, so a future layout change
    // or an exports map does not break a hardcoded deep path.
    const require = createRequire(import.meta.url);
    const pkg = require('mcp-remote/package.json');
    const proxy = join(dirname(require.resolve('mcp-remote/package.json')), pkg.bin['mcp-remote']);
    const child = spawn(process.execPath, [proxy, URL, '--header', `x-api-key:${key}`], { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 0);
    });
}
