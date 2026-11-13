// Offline tests for the pagination collector in lib/paginate.mjs.
//
// Every test injects a fake fetch, so nothing here opens a socket and nothing
// reads HASDATA_API_KEY: each call passes an explicit dummy key. The live
// contract suite in test/tools.test.mjs is deliberately untouched and keeps its
// skip-without-key / hit-the-network-with-key behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    paginateListings,
    parseRpcMessage,
    STOP_REASON,
    LISTINGS_TOOL,
    DEFAULT_ENDPOINT,
} from '../lib/paginate.mjs';

const DUMMY_KEY = 'test-key-offline';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function listing(id) {
    return {
        id: String(id),
        url: `https://www.zillow.com/homedetails/${id}_zpid/`,
        price: 300_000 + id,
        beds: 3,
        baths: 2,
    };
}

// The scraped payload lives under envelope.json, exactly as the README documents.
function toolEnvelope(payload) {
    return JSON.stringify({
        url: 'https://www.zillow.com/austin-tx/',
        status: 200,
        text: '',
        json: payload,
    });
}

function successMessage(id, payload) {
    return {
        jsonrpc: '2.0',
        id,
        result: {
            isError: false,
            content: [{ type: 'text', text: toolEnvelope(payload) }],
        },
    };
}

function errorTextMessage(id, text) {
    return {
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text }] },
    };
}

function pagePayload({ properties, nextPage = null, metadataStatus = 'ok' }) {
    return {
        requestMetadata: { id: 'req-1', status: metadataStatus },
        searchInformation: { totalResults: properties.length },
        properties,
        pagination: nextPage ? { nextPage } : {},
    };
}

function jsonResponse(message, status = 200) {
    return {
        status,
        headers: { 'content-type': 'application/json' },
        text: async () => JSON.stringify(message),
    };
}

// A streamable HTTP SSE body: a progress notification first, then the answer,
// with one event split across two data: lines to exercise the parser too.
function sseResponse(message) {
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
    const answer = JSON.stringify(message);
    const [first, ...rest] = answer;
    const body = [
        `event: message\ndata: ${notification}`,
        `event: message\ndata: ${first}\ndata: ${rest.join('')}`,
        '',
    ].join('\n\n');
    return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        text: async () => body,
    };
}

function concurrencyResponse(status = 429) {
    return {
        status,
        headers: { 'content-type': 'application/json' },
        text: async () => JSON.stringify({
            error: { code: 'concurrency_limit', message: 'concurrency limit exceeded' },
            concurrency_limit: 5,
        }),
    };
}

// Build a fetch whose queued responses are consumed in call order. It records
// every request so tests can assert on arguments and headers.
function makeFetch(responses) {
    const calls = [];
    const queue = [...responses];
    const fetchImpl = async (url, init) => {
        const sent = JSON.parse(init.body);
        calls.push({ url, init, sent });
        const next = queue.shift();
        if (typeof next === 'function') return next(calls.length);
        return next;
    };
    return { fetchImpl, calls };
}

const noWait = async () => {};

function run(responses, options = {}) {
    const { fetchImpl, calls } = makeFetch(responses);
    const sleeps = [];
    const resultPromise = paginateListings({
        keyword: 'Austin, TX',
        type: 'forSale',
        filters: { price_max_: 600_000, beds_min_: 3 },
        maxPages: 5,
        apiKey: DUMMY_KEY,
        fetchImpl,
        sleep: async (ms) => {
            sleeps.push(ms);
            return noWait();
        },
        retryBaseDelayMs: 1000,
        ...options,
    });
    return { resultPromise, calls, sleeps };
}

// ---------------------------------------------------------------------------
// Response-shape parsing
// ---------------------------------------------------------------------------

test('parseRpcMessage reads a plain JSON-RPC body', () => {
    const message = parseRpcMessage(JSON.stringify(successMessage(7, pagePayload({ properties: [] }))), 7);
    assert.equal(message.id, 7);
    assert.equal(message.result.isError, false);
});

test('parseRpcMessage picks the matching message out of an SSE stream', () => {
    const message = successMessage(9, pagePayload({ properties: [] }));
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' });
    const answer = JSON.stringify(message);
    const [first, ...rest] = answer;
    const raw = [
        `data: ${notification}`,
        `data: ${first}\ndata: ${rest.join('')}`,
    ].join('\n\n');
    const parsed = parseRpcMessage(raw, 9);
    assert.equal(parsed.id, 9);
    assert.ok(parsed.result.content[0].text.includes('requestMetadata'));
});

// ---------------------------------------------------------------------------
// Happy paths: JSON, SSE, merging and filter fidelity
// ---------------------------------------------------------------------------

test('plain JSON responses walk every page, merge properties and keep the audit trail', async () => {
    const page2Url = 'https://www.zillow.com/austin-tx/2_p/';
    const page3Url = 'https://www.zillow.com/austin-tx/3_p/';
    const { resultPromise, calls } = run([
        jsonResponse(successMessage(1, pagePayload({
            properties: [listing(1), listing(2)],
            nextPage: page2Url,
        }))),
        jsonResponse(successMessage(2, pagePayload({
            properties: [listing(3)],
            nextPage: page3Url,
        }))),
        jsonResponse(successMessage(3, pagePayload({
            properties: [listing(4), listing(5), listing(6)],
        }))),
    ]);

    const result = await resultPromise;

    assert.equal(result.stopReason, STOP_REASON.NO_NEXT_PAGE);
    assert.equal(result.pagesRequested, 3);
    assert.equal(result.totalCount, 6);
    assert.deepEqual(result.properties.map((p) => p.id), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(result.pages.map((p) => p.propertyCount), [2, 1, 3]);
    assert.deepEqual(result.pages.map((p) => p.status), ['ok', 'ok', 'ok']);
    assert.deepEqual(result.pages.map((p) => p.hasNextPage), [true, true, false]);
    assert.equal(result.pages[0].nextPage, page2Url);
    assert.equal(result.pages[2].error, null);

    // First-screen keyword, type and filters are carried verbatim onto every page.
    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.equal(call.url, DEFAULT_ENDPOINT);
        assert.equal(call.init.headers['x-api-key'], DUMMY_KEY);
        assert.equal(call.sent.method, 'tools/call');
        assert.equal(call.sent.params.name, LISTINGS_TOOL);
        const args = call.sent.params.arguments;
        assert.equal(args.keyword, 'Austin, TX');
        assert.equal(args.type, 'forSale');
        assert.equal(args.price_max_, 600_000);
        assert.equal(args.beds_min_, 3);
    }

    // Pagination follows only the server-provided nextPage URL; no guessed page number.
    assert.equal(calls[0].sent.params.arguments.url, undefined);
    assert.equal(calls[1].sent.params.arguments.url, page2Url);
    assert.equal(calls[2].sent.params.arguments.url, page3Url);
    for (const call of calls) {
        assert.equal(call.sent.params.arguments.page, undefined);
    }
});

test('SSE responses with a leading progress notification parse like plain JSON', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise } = run([
        sseResponse(successMessage(1, pagePayload({
            properties: [listing(10), listing(11)],
            nextPage: nextUrl,
        }))),
        sseResponse(successMessage(2, pagePayload({ properties: [listing(12)] }))),
    ]);

    const result = await resultPromise;
    assert.equal(result.pagesRequested, 2);
    assert.equal(result.totalCount, 3);
    assert.equal(result.stopReason, STOP_REASON.NO_NEXT_PAGE);
    assert.deepEqual(result.pages.map((p) => p.status), ['ok', 'ok']);
});

test('an empty properties array is success with no inventory, not an error', async () => {
    const { resultPromise, calls } = run([
        jsonResponse(successMessage(1, pagePayload({ properties: [] }))),
    ]);

    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.NO_NEXT_PAGE);
    assert.equal(result.pagesRequested, 1);
    assert.equal(result.totalCount, 0);
    assert.deepEqual(result.properties, []);
    assert.equal(result.pages[0].status, 'empty');
    assert.equal(result.pages[0].propertyCount, 0);
    assert.equal(result.pages[0].hasNextPage, false);
    assert.equal(result.pages[0].error, null);
    assert.equal(calls.length, 1);
});

test('a populated page followed by an empty page keeps the listings already collected', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise } = run([
        jsonResponse(successMessage(1, pagePayload({ properties: [listing(1)], nextPage: nextUrl }))),
        jsonResponse(successMessage(2, pagePayload({ properties: [] }))),
    ]);

    const result = await resultPromise;
    assert.equal(result.pages[0].status, 'ok');
    assert.equal(result.pages[1].status, 'empty');
    assert.equal(result.totalCount, 1);
    assert.equal(result.stopReason, STOP_REASON.NO_NEXT_PAGE);
});

// ---------------------------------------------------------------------------
// Pagination controls: missing nextPage and the page cap
// ---------------------------------------------------------------------------

test('missing pagination.nextPage stops the walk without another request', async () => {
    const { resultPromise, calls } = run([
        jsonResponse(successMessage(1, pagePayload({ properties: [listing(1), listing(2)] }))),
        new Error('a second page must never be requested'),
    ]);

    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.NO_NEXT_PAGE);
    assert.equal(calls.length, 1);
    assert.equal(result.pages[0].hasNextPage, false);
    assert.equal(result.pages[0].nextPage, null);
});

test('reaching maxPages stops even though another page is offered', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise, calls } = run(
        [
            jsonResponse(successMessage(1, pagePayload({ properties: [listing(1)], nextPage: nextUrl }))),
            jsonResponse(successMessage(2, pagePayload({ properties: [listing(2)], nextPage: nextUrl }))),
        ],
        { maxPages: 2 }
    );

    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.MAX_PAGES);
    assert.equal(result.pagesRequested, 2);
    assert.equal(result.totalCount, 2);
    assert.equal(calls.length, 2);
    assert.equal(result.pages[1].hasNextPage, true);
});

// ---------------------------------------------------------------------------
// concurrency_limit: backoff and retry, then the exhausted limit
// ---------------------------------------------------------------------------

test('a 429 concurrency_limit response is retried with backoff and then succeeds', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise, calls, sleeps } = run([
        concurrencyResponse(429),
        concurrencyResponse(429),
        jsonResponse(successMessage(3, pagePayload({ properties: [listing(1)], nextPage: nextUrl }))),
        jsonResponse(successMessage(4, pagePayload({ properties: [listing(2)] }))),
    ]);

    const result = await resultPromise;
    assert.equal(calls.length, 4);
    assert.equal(result.stopReason, STOP_REASON.NO_NEXT_PAGE);
    assert.equal(result.totalCount, 2);
    assert.equal(result.pages[0].attempts, 3);
    assert.equal(result.pages[0].status, 'ok');
    // Exponential backoff from the 1s base, one wait per throttled attempt.
    assert.deepEqual(sleeps, [1000, 2000]);
    assert.deepEqual(result.pages[0].retryDelaysMs, [1000, 2000]);
    // The retried page re-sends the identical first-screen arguments.
    const firstPageArgs = calls[0].sent.params.arguments;
    assert.deepEqual(calls[1].sent.params.arguments, firstPageArgs);
    assert.deepEqual(calls[2].sent.params.arguments, firstPageArgs);
});

test('a 200 body carrying concurrency_limit is throttling too, not a contract failure', async () => {
    const throttled = {
        status: 200,
        text: async () => JSON.stringify({ concurrency_limit: 5, message: 'slow down' }),
    };
    const { resultPromise, sleeps } = run([
        throttled,
        jsonResponse(successMessage(2, pagePayload({ properties: [listing(1)] }))),
    ]);

    const result = await resultPromise;
    assert.equal(result.pages[0].status, 'ok');
    assert.deepEqual(sleeps, [1000]);
    assert.equal(result.stopReason, STOP_REASON.NO_NEXT_PAGE);
});

test('exhausting the retry budget records a concurrency-limit failure and keeps prior pages', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise, calls, sleeps } = run(
        [
            jsonResponse(successMessage(1, pagePayload({ properties: [listing(1)], nextPage: nextUrl }))),
            concurrencyResponse(429),
            concurrencyResponse(429),
            concurrencyResponse(429),
        ],
        { maxConcurrencyRetries: 2, retryBaseDelayMs: 1000, retryMaxDelayMs: 30_000 }
    );

    const result = await resultPromise;
    // 1 success, then 1 initial attempt + 2 retries on the throttled second page.
    assert.equal(calls.length, 4);
    assert.equal(result.stopReason, STOP_REASON.CONCURRENCY_LIMIT);
    assert.equal(result.pagesRequested, 2);
    assert.equal(result.totalCount, 1);
    assert.equal(result.pages[1].status, 'concurrency_limit');
    assert.equal(result.pages[1].errorKind, 'concurrency_limit');
    assert.equal(result.pages[1].attempts, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
    assert.deepEqual(result.pages[1].retryDelaysMs, [1000, 2000]);
});

test('the backoff delay is capped at retryMaxDelayMs', async () => {
    const { resultPromise, sleeps } = run(
        [
            concurrencyResponse(429),
            concurrencyResponse(429),
            concurrencyResponse(429),
            concurrencyResponse(429),
        ],
        { maxConcurrencyRetries: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 1500 }
    );

    await resultPromise;
    assert.deepEqual(sleeps, [1000, 1500, 1500]);
});

// ---------------------------------------------------------------------------
// Keys: tool-level 401 text, connection-level HTTP 401, and no key at all
// ---------------------------------------------------------------------------

test('a 200 isError result naming a 401 marks the key rejected and never retries', async () => {
    const { resultPromise, calls, sleeps } = run([
        jsonResponse(errorTextMessage(1, 'HasData API error: 401 Unauthorized')),
        new Error('the rejected key must not be retried'),
    ]);

    const result = await resultPromise;
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(result.stopReason, STOP_REASON.KEY_REJECTED);
    assert.equal(result.pagesRequested, 1);
    assert.equal(result.totalCount, 0);
    assert.equal(result.pages[0].status, 'key_rejected');
    assert.equal(result.pages[0].errorKind, 'tool_401');
});

test('the 401 string inside a JSON envelope text block is still a rejected key', async () => {
    const message = {
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ status: 401, text: 'HasData API error: 401 Unauthorized' }) }],
        },
    };
    const { resultPromise } = run([jsonResponse(message)]);
    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.KEY_REJECTED);
    assert.equal(result.pages[0].errorKind, 'tool_401');
});

test('a connection-layer HTTP 401 is classified as a rejected key and stops', async () => {
    const { resultPromise, calls } = run([
        { status: 401, text: async () => 'Unauthorized' },
    ]);

    const result = await resultPromise;
    assert.equal(calls.length, 1);
    assert.equal(result.stopReason, STOP_REASON.KEY_REJECTED);
    assert.equal(result.pages[0].status, 'key_rejected');
    assert.equal(result.pages[0].errorKind, 'http_401');
});

test('a non-401 isError tool result fails the page and stops the walk', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise } = run([
        jsonResponse(successMessage(1, pagePayload({ properties: [listing(1)], nextPage: nextUrl }))),
        jsonResponse(errorTextMessage(2, 'MCP error -32602: Input validation error')),
    ]);

    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.PAGE_FAILED);
    assert.equal(result.pagesRequested, 2);
    assert.equal(result.totalCount, 1);
    assert.equal(result.pages[1].status, 'tool_error');
});

// ---------------------------------------------------------------------------
// Other failure paths and argument validation
// ---------------------------------------------------------------------------

test('requestMetadata.status other than ok fails the page but keeps earlier listings', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise } = run([
        jsonResponse(successMessage(1, pagePayload({ properties: [listing(1)], nextPage: nextUrl }))),
        jsonResponse(successMessage(2, pagePayload({ properties: [], metadataStatus: 'error' }))),
    ]);

    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.PAGE_FAILED);
    assert.equal(result.totalCount, 1);
    assert.equal(result.pages[1].status, 'metadata_not_ok');
    assert.match(result.pages[1].error, /requestMetadata\.status/);
});

test('an unexpected HTTP status fails the page without retrying', async () => {
    const { resultPromise, sleeps } = run([{ status: 500, text: async () => 'boom' }]);
    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.PAGE_FAILED);
    assert.equal(result.pages[0].status, 'http_error');
    assert.equal(result.pages[0].errorKind, 'http_500');
    assert.deepEqual(sleeps, []);
});

test('a network error fails the page and preserves listings collected earlier', async () => {
    const nextUrl = 'https://www.zillow.com/austin-tx/2_p/';
    const { resultPromise } = run([
        jsonResponse(successMessage(1, pagePayload({ properties: [listing(1)], nextPage: nextUrl }))),
        {
            status: 0,
            text: async () => {
                throw new TypeError('fetch failed');
            },
        },
    ]);

    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.PAGE_FAILED);
    assert.equal(result.totalCount, 1);
    assert.equal(result.pages[1].status, 'network_error');
});

test('a response with no parseable JSON-RPC message is a malformed-page failure', async () => {
    const { resultPromise } = run([{ status: 200, text: async () => 'not json at all' }]);
    const result = await resultPromise;
    assert.equal(result.stopReason, STOP_REASON.PAGE_FAILED);
    assert.equal(result.pages[0].status, 'malformed');
});

test('a JSON-RPC error envelope is reported as a tool error', async () => {
    const message = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad request' } };
    const { resultPromise } = run([jsonResponse(message)]);
    const result = await resultPromise;
    assert.equal(result.pages[0].status, 'tool_error');
    assert.equal(result.pages[0].errorKind, 'json_rpc_error');
    assert.equal(result.stopReason, STOP_REASON.PAGE_FAILED);
});

test('missing keyword or type is a programmer error, not a network call', async () => {
    const { fetchImpl, calls } = makeFetch([]);
    await assert.rejects(
        () => paginateListings({ keyword: '', type: 'forSale', apiKey: DUMMY_KEY, fetchImpl }),
        /keyword/
    );
    await assert.rejects(
        () => paginateListings({ keyword: 'Austin, TX', type: '', apiKey: DUMMY_KEY, fetchImpl }),
        /type/
    );
    await assert.rejects(
        () => paginateListings({ keyword: 'Austin, TX', type: 'forSale', maxPages: 0, apiKey: DUMMY_KEY, fetchImpl }),
        /maxPages/
    );
    assert.equal(calls.length, 0);
});

// The suite must be hermetic: even if the machine exporting this run has a real
// key configured, these tests never consult it.
test('the offline suite does not depend on HASDATA_API_KEY', async () => {
    const saved = process.env.HASDATA_API_KEY;
    delete process.env.HASDATA_API_KEY;
    try {
        const { resultPromise, calls } = run([
            jsonResponse(successMessage(1, pagePayload({ properties: [listing(1)] }))),
        ]);
        const result = await resultPromise;
        assert.equal(result.totalCount, 1);
        assert.equal(calls[0].init.headers['x-api-key'], DUMMY_KEY);
    } finally {
        if (saved !== undefined) process.env.HASDATA_API_KEY = saved;
    }
});

test('calling without any key returns a structured key_rejected result and makes no request', async () => {
    const saved = process.env.HASDATA_API_KEY;
    delete process.env.HASDATA_API_KEY;
    try {
        const { fetchImpl, calls } = makeFetch([]);
        const result = await paginateListings({
            keyword: 'Austin, TX',
            type: 'forSale',
            fetchImpl,
        });
        assert.equal(calls.length, 0);
        assert.equal(result.stopReason, STOP_REASON.KEY_REJECTED);
        assert.equal(result.pagesRequested, 1);
        assert.equal(result.pages[0].errorKind, 'missing_api_key');
        assert.deepEqual(result.properties, []);
    } finally {
        if (saved !== undefined) process.env.HASDATA_API_KEY = saved;
    }
});
