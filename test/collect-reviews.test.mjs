// Offline tests for the collectPlaceReviews paging collector in index.mjs.
//
// Every test injects a fetch-compatible fake, so no request ever leaves the machine and no
// HasData credits are spent. The fakes cover both response shapes the streamable-HTTP MCP
// endpoint uses (plain JSON and server-sent events), the MCP-level isError envelope, raw
// HTTP status failures and thrown network errors.
//
// Run: node --test test/collect-reviews.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectPlaceReviews,
    HASDATA_ENDPOINT,
    REASONS,
    REVIEWS_TOOL,
    STOP_REASONS,
} from '../index.mjs';

const KEY = 'test-key-not-a-real-credential';
process.env.HASDATA_API_KEY = KEY;

let reviewSeq = 0;
function makeReview(overrides = {}) {
    reviewSeq += 1;
    return {
        reviewId: `review-${reviewSeq}`,
        rating: 5,
        snippet: `snippet ${reviewSeq}`,
        isoDate: '2026-07-06T19:49:00.657Z',
        user: { name: `Reviewer ${reviewSeq}`, contributorId: `contrib-${reviewSeq}` },
        ...overrides,
    };
}

// A response factory receives the parsed request body so the JSON-RPC id it echoes back
// matches whatever request id the collector assigned.
function pageResponse(reviews, nextPageToken = null, { sse = false } = {}) {
    return (body) => {
        const payload = {
            placeInfo: { title: 'Test Place' },
            topics: [],
            reviews,
            pagination: nextPageToken ? { nextPageToken } : {},
        };
        const message = {
            jsonrpc: '2.0',
            id: body.id,
            result: {
                content: [
                    { type: 'text', text: JSON.stringify({ url: 'https://example.test/x', status: 'ok', text: '', json: payload }) },
                ],
            },
        };
        const raw = sse
            ? `event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`
            : JSON.stringify(message);
        return { ok: true, status: 200, text: async () => raw };
    };
}

// MCP-level failure: HTTP 200, isError inside the result, reason in the text block.
function mcpErrorResponse(text) {
    return (body) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { isError: true, content: [{ type: 'text', text }] },
        }),
    });
}

// A genuine HTTP-level failure (the missing-key case, or a gateway 429).
function httpErrorResponse(status, text) {
    return () => ({ ok: false, status, text: async () => text });
}

function throwingResponse(error) {
    return () => {
        throw error;
    };
}

// Builds a fetch fake from a script of response factories and records every call made.
function fakeFetch(script) {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            const body = JSON.parse(init.body);
            calls.push({ url, init, body });
            const factory = script[calls.length - 1];
            assert.ok(factory, `unexpected extra request #${calls.length}`);
            return factory(body);
        },
    };
}

const FAST = { maxRetries: 2, backoffMs: 0, timeoutMs: 1000 };

test('normal multi-page run walks nextPageToken until the feed ends', async () => {
    const page1 = [makeReview(), makeReview()];
    const page2 = [makeReview(), makeReview(), makeReview()];
    const page3 = [makeReview()];
    const fake = fakeFetch([
        pageResponse(page1, 'token-1'),
        pageResponse(page2, 'token-2', { sse: true }), // exercise the SSE parsing branch
        pageResponse(page3, null),
    ]);

    const result = await collectPlaceReviews({
        placeId: 'ChIJAb0KE0RrkFQRuI4X0By5Mcw',
        sortBy: 'newestFirst',
        hl: 'en',
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 3);
    for (const call of fake.calls) {
        assert.equal(call.url, HASDATA_ENDPOINT);
        assert.equal(call.init.headers['x-api-key'], KEY);
        assert.equal(call.body.method, 'tools/call');
        assert.equal(call.body.params.name, REVIEWS_TOOL);
    }
    assert.deepEqual(fake.calls[0].body.params.arguments, {
        placeId: 'ChIJAb0KE0RrkFQRuI4X0By5Mcw',
        sortBy: 'newestFirst',
        hl: 'en',
    });
    assert.equal(fake.calls[1].body.params.arguments.nextPageToken, 'token-1');
    assert.equal(fake.calls[2].body.params.arguments.nextPageToken, 'token-2');

    assert.equal(result.completed, true);
    assert.equal(result.stopReason, STOP_REASONS.NO_NEXT_PAGE);
    assert.equal(result.reviewCount, 6);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.failureReason, null);
    assert.equal(result.failureMessage, null);
    assert.equal(result.truncatedByMaxReviews, false);
    assert.deepEqual(result.reviews.map((r) => r.reviewId), [...page1, ...page2, ...page3].map((r) => r.reviewId));

    assert.deepEqual(
        result.pageRecords.map((r) => [r.page, r.reviewCount, r.success, r.attempts, r.hasNextPage, r.failureReason]),
        [
            [1, 2, true, 1, true, null],
            [2, 3, true, 1, true, null],
            [3, 1, true, 1, false, null],
        ]
    );
});

test('an empty page ends the batch cleanly as real end-of-data', async () => {
    const fake = fakeFetch([
        pageResponse([makeReview(), makeReview()], 'token-1'),
        pageResponse([], null),
    ]);

    const result = await collectPlaceReviews({ placeId: 'ChIJ', fetchImpl: fake.fetch });

    assert.equal(fake.calls.length, 2);
    assert.equal(result.completed, true);
    assert.equal(result.stopReason, STOP_REASONS.EMPTY_PAGE);
    assert.equal(result.reviewCount, 2);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.failureReason, null);
    assert.equal(result.pageRecords[1].reviewCount, 0);
    assert.equal(result.pageRecords[1].success, true);
    assert.equal(result.pageRecords[1].hasNextPage, false);
});

test('an empty first page is also a clean finish', async () => {
    const fake = fakeFetch([pageResponse([], null)]);
    const result = await collectPlaceReviews({ placeId: 'ChIJ', fetchImpl: fake.fetch });

    assert.equal(fake.calls.length, 1);
    assert.equal(result.completed, true);
    assert.equal(result.stopReason, STOP_REASONS.EMPTY_PAGE);
    assert.equal(result.reviewCount, 0);
    assert.equal(result.pageRecords[0].reviewCount, 0);
});

test('retry exhaustion on the concurrency limit stops paging and marks the batch incomplete', async () => {
    const fake = fakeFetch([
        mcpErrorResponse('HasData API error: 429 concurrency_limit, retry later'),
        mcpErrorResponse('HasData API error: 429 concurrency_limit, retry later'),
        mcpErrorResponse('HasData API error: 429 concurrency_limit, retry later'),
    ]);

    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        ...FAST,
        fetchImpl: fake.fetch,
    });

    // maxRetries: 2 means one initial attempt plus two retries, then it gives up.
    assert.equal(fake.calls.length, 3);
    assert.equal(result.completed, false);
    assert.equal(result.stopReason, STOP_REASONS.RETRY_EXHAUSTED);
    assert.equal(result.failureReason, REASONS.CONCURRENCY_LIMIT);
    assert.ok(result.failureMessage.includes('concurrency_limit'));
    assert.equal(result.reviewCount, 0);
    assert.equal(result.pagesFetched, 0);
    assert.equal(result.pageRecords.length, 1);
    assert.deepEqual(
        {
            page: result.pageRecords[0].page,
            success: result.pageRecords[0].success,
            attempts: result.pageRecords[0].attempts,
            failureReason: result.pageRecords[0].failureReason,
            hasNextPage: result.pageRecords[0].hasNextPage,
        },
        { page: 1, success: false, attempts: 3, failureReason: REASONS.CONCURRENCY_LIMIT, hasNextPage: false }
    );
});

test('a concurrency failure that later succeeds is retried and the page is kept', async () => {
    const fake = fakeFetch([
        mcpErrorResponse('HasData API error: 429 concurrency_limit'),
        mcpErrorResponse('HasData API error: 429 concurrency_limit'),
        pageResponse([makeReview(), makeReview()], null),
    ]);

    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        ...FAST,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 3);
    assert.equal(result.completed, true);
    assert.equal(result.stopReason, STOP_REASONS.NO_NEXT_PAGE);
    assert.equal(result.reviewCount, 2);
    assert.equal(result.pageRecords[0].attempts, 3);
    assert.equal(result.pageRecords[0].success, true);
    assert.equal(result.pageRecords[0].failureReason, null);
});

test('a raw HTTP 429 is classified as the concurrency limit', async () => {
    const fake = fakeFetch([httpErrorResponse(429, 'concurrency_limit')]);
    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        maxRetries: 0,
        backoffMs: 0,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 1);
    assert.equal(result.completed, false);
    assert.equal(result.stopReason, STOP_REASONS.RETRY_EXHAUSTED);
    assert.equal(result.failureReason, REASONS.CONCURRENCY_LIMIT);
});

test('a 401 is reported as unauthorized and is not retried', async () => {
    const fake = fakeFetch([mcpErrorResponse('HasData API error: 401 Unauthorized')]);
    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        ...FAST,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 1);
    assert.equal(result.completed, false);
    assert.equal(result.stopReason, STOP_REASONS.PAGE_FAILED);
    assert.equal(result.failureReason, REASONS.UNAUTHORIZED);
    assert.equal(result.pageRecords[0].attempts, 1);
});

test('a 400 bad request is reported as an invalid place and is not retried', async () => {
    const fake = fakeFetch([mcpErrorResponse('HasData API error: 400 Bad Request, requestMetadata.status=error')]);
    const result = await collectPlaceReviews({
        placeId: 'ChIJ-does-not-exist',
        ...FAST,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 1);
    assert.equal(result.completed, false);
    assert.equal(result.stopReason, STOP_REASONS.PAGE_FAILED);
    assert.equal(result.failureReason, REASONS.INVALID_PLACE);
    assert.equal(result.pageRecords[0].attempts, 1);
});

test('a network timeout is reported as a timeout failure', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    const fake = fakeFetch([throwingResponse(timeoutError)]);

    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        ...FAST,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 1);
    assert.equal(result.completed, false);
    assert.equal(result.stopReason, STOP_REASONS.PAGE_FAILED);
    assert.equal(result.failureReason, REASONS.TIMEOUT);
    assert.ok(result.failureMessage.includes('timeout'));
    assert.equal(result.pageRecords[0].success, false);
});

test('maxReviews truncates a page and says so explicitly', async () => {
    const fake = fakeFetch([
        pageResponse([makeReview(), makeReview(), makeReview()], 'token-1'),
        pageResponse([makeReview(), makeReview(), makeReview()], 'token-2'),
    ]);

    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        maxReviews: 4,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 2);
    assert.equal(result.reviewCount, 4);
    assert.equal(result.completed, true);
    assert.equal(result.stopReason, STOP_REASONS.MAX_REVIEWS);
    assert.equal(result.truncatedByMaxReviews, true);
    assert.equal(result.failureReason, null);
    assert.equal(result.pageRecords[0].collectedCount, 3);
    assert.equal(result.pageRecords[0].truncated, false);
    assert.equal(result.pageRecords[1].reviewCount, 3);
    assert.equal(result.pageRecords[1].collectedCount, 1);
    assert.equal(result.pageRecords[1].truncated, true);
});

test('an exact maxReviews boundary is not marked truncated', async () => {
    const fake = fakeFetch([
        pageResponse([makeReview(), makeReview()], 'token-1'),
        pageResponse([makeReview(), makeReview()], null),
    ]);
    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        maxReviews: 2,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 1);
    assert.equal(result.reviewCount, 2);
    assert.equal(result.stopReason, STOP_REASONS.MAX_REVIEWS);
    assert.equal(result.truncatedByMaxReviews, false);
    assert.equal(result.pageRecords[0].truncated, false);
});

test('maxPages stops at the cap while the feed still has another page', async () => {
    const fake = fakeFetch([
        pageResponse([makeReview()], 'token-1'),
        pageResponse([makeReview()], 'token-2'),
        pageResponse([makeReview()], null),
    ]);

    const result = await collectPlaceReviews({
        placeId: 'ChIJ',
        maxPages: 2,
        fetchImpl: fake.fetch,
    });

    assert.equal(fake.calls.length, 2);
    assert.equal(result.completed, true);
    assert.equal(result.stopReason, STOP_REASONS.MAX_PAGES);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.pageRecords[1].hasNextPage, true);
    assert.equal(result.truncatedByMaxReviews, false);
});

test('dataId is accepted in place of placeId and forwarded as the only place identifier', async () => {
    const fake = fakeFetch([pageResponse([makeReview()], null)]);
    const result = await collectPlaceReviews({ dataId: '0x54906b:0xcc31b91c', fetchImpl: fake.fetch });

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].body.params.arguments.dataId, '0x54906b:0xcc31b91c');
    assert.equal('placeId' in fake.calls[0].body.params.arguments, false);
    assert.equal(result.completed, true);
    assert.equal(result.reviewCount, 1);
});

test('missing placeId and dataId throws before any request is made', async () => {
    const fake = fakeFetch([]);
    await assert.rejects(
        () => collectPlaceReviews({ fetchImpl: fake.fetch }),
        /placeId or a dataId/
    );
    assert.equal(fake.calls.length, 0);
});

test('a missing HASDATA_API_KEY throws before any request is made', async () => {
    const previous = process.env.HASDATA_API_KEY;
    delete process.env.HASDATA_API_KEY;
    try {
        const fake = fakeFetch([]);
        await assert.rejects(
            () => collectPlaceReviews({ placeId: 'ChIJ', fetchImpl: fake.fetch }),
            /HASDATA_API_KEY/
        );
        assert.equal(fake.calls.length, 0);
    } finally {
        process.env.HASDATA_API_KEY = previous;
    }
});

test('non-positive maxPages or maxReviews is rejected without a request', async () => {
    const fake = fakeFetch([]);
    await assert.rejects(() => collectPlaceReviews({ placeId: 'ChIJ', maxPages: 0, fetchImpl: fake.fetch }), /maxPages/);
    await assert.rejects(() => collectPlaceReviews({ placeId: 'ChIJ', maxReviews: -1, fetchImpl: fake.fetch }), /maxReviews/);
    assert.equal(fake.calls.length, 0);
});
