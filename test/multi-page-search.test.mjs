// Local, network-free tests for the resumable multi-page search in
// lib/multi-page-search.mjs. Every remote answer is hand-built: a fake fetch records the
// request and returns either plain JSON-RPC or a server-sent-event body, so no HasData
// key and no real connection are involved.
//
// Run: npm test   (the live contract checks in tools.test.mjs skip without a key)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    searchAllListings,
    createSearchState,
    parseStreamableHttp,
    extractToolPayload,
    LISTINGS_TOOL,
} from '../lib/multi-page-search.mjs';

const ENDPOINT = 'https://mcp.example.invalid/mcp';
const API_KEY = 'test-key-not-real';
const BASE_ARGS = { location: 'Austin, Texas', checkIn: '2026-12-10', checkOut: '2026-12-13' };

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

function listing(id, extra = {}) {
    return {
        id,
        url: `https://www.airbnb.com/rooms/${id}`,
        title: `Home ${id}`,
        ...extra,
    };
}

// A tools/call success envelope: result.content[0].text is itself JSON wrapping the data.
function toolMessage(requestId, payload, { isError = false } = {}) {
    const message = {
        jsonrpc: '2.0',
        id: requestId,
        result: {
            isError,
            content: [{ type: 'text', text: JSON.stringify({ url: 'https://x', status: 'ok', text: '', json: payload }) }],
        },
    };
    return message;
}

function sseBody(requestId, payload, { progress = false, isError = false } = {}) {
    const events = [];
    if (progress) {
        // Progress notifications share the stream with the answer and must be ignored.
        events.push(`event: progress\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: 99, progress: 50 },
        })}`);
    }
    // A JSON value can itself span several data: lines. Split at a top-level structural
    // comma so the newline lands between tokens; splitting inside a string would produce
    // JSON no real SSE producer ever emits.
    const serialized = JSON.stringify(toolMessage(requestId, payload, { isError }));
    let depth = 0;
    let inString = false;
    let escaped = false;
    let cut = -1;
    for (let i = 0; i < serialized.length; i += 1) {
        const ch = serialized[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ']') depth -= 1;
        else if (ch === ',' && depth <= 2) { cut = i + 1; break; }
    }
    if (cut < 0) cut = Math.floor(serialized.length / 2);
    events.push(`data: ${serialized.slice(0, cut)}\ndata: ${serialized.slice(cut)}`);
    return events.join('\n\n');
}

function jsonBody(message) {
    return JSON.stringify(message);
}

// Build a fetch stand-in. `handler({ args, requestId, callIndex })` returns a response spec:
//   { status, body, contentType }
function makeFetch(handler) {
    const calls = [];
    const fetchImpl = async (endpoint, init) => {
        const request = JSON.parse(init.body);
        const args = request.params.arguments;
        calls.push({ endpoint, init, request, args });
        const spec = await handler({ args, requestId: request.id, callIndex: calls.length - 1 });
        return new Response(spec.body, {
            status: spec.status ?? 200,
            headers: { 'content-type': spec.contentType ?? 'application/json' },
        });
    };
    return { fetchImpl, calls };
}

// No real timers: collect the backoff delays the runner sleeps for.
function fakeSleep() {
    const delays = [];
    return { delays, sleepImpl: (ms) => delays.push(ms) };
}

async function run(handler, options = {}) {
    const { fetchImpl, calls } = makeFetch(handler);
    const { delays, sleepImpl } = fakeSleep();
    const result = await searchAllListings({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        fetchImpl,
        sleepImpl,
        ...options,
    });
    return { result, calls, delays };
}

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

test('parseStreamableHttp handles plain JSON, SSE progress noise and multi-line events', () => {
    const id = 7;
    const plain = parseStreamableHttp(jsonBody({ jsonrpc: '2.0', id, result: {} }), id);
    assert.equal(plain.id, id);

    const sse = parseStreamableHttp(
        sseBody(id, { properties: [], pagination: {} }, { progress: true }),
        id
    );
    assert.equal(sse.id, id);
    assert.ok(sse.result.content[0].text.includes('properties'));

    assert.throws(
        () => parseStreamableHttp('data: {"jsonrpc":"2.0","id":999,"result":{}}', id),
        /no JSON-RPC message with id 7/
    );
});

test('extractToolPayload unwraps the text envelope and rejects tool errors', () => {
    const payload = { properties: [listing('1')], pagination: {} };
    const ok = extractToolPayload(toolMessage(1, payload));
    assert.deepEqual(ok.properties.map((p) => p.id), ['1']);

    assert.throws(
        () => extractToolPayload(toolMessage(1, {}, { isError: true })),
        (err) => err.name === 'ToolError',
    );
    assert.throws(
        () => extractToolPayload({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
        /boom/,
    );

    const structured = extractToolPayload({
        jsonrpc: '2.0',
        id: 1,
        result: { structuredContent: payload },
    });
    assert.equal(structured.properties.length, 1);
});

// ---------------------------------------------------------------------------
// Scenario 1: two healthy pages merge and de-duplicate
// ---------------------------------------------------------------------------

test('two successful pages are merged, de-duplicated and recorded', async () => {
    const handler = ({ args, requestId }) => {
        if (!args.nextPageToken) {
            // Page one comes back as a plain JSON body.
            return {
                body: jsonBody(toolMessage(requestId, {
                    properties: [listing('a'), listing('b'), listing('c')],
                    pagination: { nextPageToken: 'tok-1' },
                    requestMetadata: { id: 'req-page-1', status: 'ok' },
                })),
            };
        }
        assert.equal(args.nextPageToken, 'tok-1');
        // Page two is SSE, carries a duplicate (c) plus two new ids and no token: last page.
        return {
            contentType: 'text/event-stream',
            body: sseBody(requestId, {
                properties: [listing('c'), listing('d'), listing('e')],
                pagination: {},
                requestMetadata: { id: 'req-page-2', status: 'ok' },
            }, { progress: true }),
        };
    };

    const { result, calls } = await run(handler, { searchArgs: BASE_ARGS, maxPages: 5 });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.properties.map((p) => p.id), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(result.requestMetadataId, 'req-page-2');

    assert.deepEqual(result.pages, [
        { page: 1, status: 'success', newProperties: 3, totalProperties: 3, attempts: 1 },
        { page: 2, status: 'success', newProperties: 2, totalProperties: 5, attempts: 1 },
    ]);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].request.method, 'tools/call');
    assert.equal(calls[0].request.params.name, LISTINGS_TOOL);
    assert.equal(calls[0].init.headers['x-api-key'], API_KEY);
    assert.equal(calls[0].args.nextPageToken, undefined);
    assert.equal(calls[1].args.nextPageToken, 'tok-1');

    assert.equal(result.state.complete, true);
    assert.equal(result.state.pagesFetched, 2);
    assert.deepEqual(result.state.propertyIds, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(result.state.nextPageToken, null);
});

// ---------------------------------------------------------------------------
// Scenario 2: an empty properties array terminates the search cleanly
// ---------------------------------------------------------------------------

test('an empty page means no more results, even when a token is still present', async () => {
    const handler = ({ args, requestId }) => {
        if (!args.nextPageToken) {
            return {
                body: jsonBody(toolMessage(requestId, {
                    properties: [listing('a')],
                    pagination: { nextPageToken: 'tok-empty' },
                    requestMetadata: { id: 'req-1' },
                })),
            };
        }
        // The server hands back another token, but the empty array wins.
        return {
            body: jsonBody(toolMessage(requestId, {
                properties: [],
                pagination: { nextPageToken: 'tok-should-not-be-used' },
                requestMetadata: { id: 'req-2' },
            })),
        };
    };

    const { result, calls } = await run(handler, { searchArgs: BASE_ARGS, maxPages: 5 });

    assert.equal(result.status, 'no_more_results');
    assert.equal(calls.length, 2, 'the empty page must stop the run immediately');
    assert.deepEqual(result.properties.map((p) => p.id), ['a']);
    assert.deepEqual(result.pages.map((p) => p.status), ['success', 'no_more_results']);
    assert.equal(result.pages[1].totalProperties, 1);
    assert.equal(result.pages[1].newProperties, 0);
    assert.equal(result.state.complete, true);
    assert.equal(result.state.nextPageToken, null);
});

// ---------------------------------------------------------------------------
// Scenario 3: concurrency limiting / 429, then a retry succeeds
// ---------------------------------------------------------------------------

test('concurrency_limit and HTTP 429 are retried with backoff and then succeed', async () => {
    const handler = ({ callIndex, requestId }) => {
        if (callIndex === 0) {
            // A 200 whose tool text names the plan limit, as the hosted server does.
            return {
                contentType: 'text/event-stream',
                body: sseBody(requestId, {
                    error: 'concurrency_limit: plan allows 1 concurrent request',
                }, { isError: true }),
            };
        }
        if (callIndex === 1) {
            // An outright 429 on the next attempt.
            return { status: 429, contentType: 'text/plain', body: 'Too Many Requests' };
        }
        return {
            body: jsonBody(toolMessage(requestId, {
                properties: [listing('a'), listing('b')],
                pagination: {},
                requestMetadata: { id: 'req-after-retry' },
            })),
        };
    };

    const { result, calls, delays } = await run(handler, {
        searchArgs: BASE_ARGS,
        maxPages: 3,
        maxRetries: 3,
        baseDelayMs: 1000,
    });

    assert.equal(calls.length, 3, 'two rate-limited attempts plus the successful retry');
    assert.deepEqual(delays, [1000, 2000], 'exponential backoff: base then 2x base');
    assert.equal(result.status, 'complete');
    assert.equal(result.pages[0].status, 'success');
    assert.equal(result.pages[0].attempts, 3, 'the page record reports every attempt');
    assert.equal(result.requestMetadataId, 'req-after-retry');
});

// ---------------------------------------------------------------------------
// Scenario 4: retries exhausted -> failed page, token retained, then resume
// ---------------------------------------------------------------------------

test('a page that exhausts retries is marked failed and stays resumable', async () => {
    const pageOne = {
        properties: [listing('a'), listing('b')],
        pagination: { nextPageToken: 'tok-retry-me' },
        requestMetadata: { id: 'req-1' },
    };
    const handler = ({ args, requestId }) => {
        if (!args.nextPageToken) return { body: jsonBody(toolMessage(requestId, pageOne)) };
        return { status: 429, contentType: 'text/plain', body: 'concurrency_limit' };
    };

    const first = await run(handler, { searchArgs: BASE_ARGS, maxPages: 3, maxRetries: 2 });

    assert.equal(first.result.status, 'failed');
    assert.equal(first.calls.length, 4, 'page one plus one initial try and two retries on page two');
    assert.equal(first.result.pages[0].status, 'success');
    const failedPage = first.result.pages[1];
    assert.equal(failedPage.page, 2);
    assert.equal(failedPage.status, 'failed');
    assert.equal(failedPage.newProperties, 0);
    assert.equal(failedPage.totalProperties, 2);
    assert.equal(failedPage.resumable, true);
    assert.match(failedPage.reason, /rate limited/);
    assert.equal(failedPage.attempts, 3);
    assert.equal(first.result.state.nextPageToken, 'tok-retry-me');
    assert.equal(first.result.state.pagesFetched, 1);
    assert.deepEqual(first.result.state.propertyIds, ['a', 'b']);

    // Resume: the remote now answers. Page one must never be pulled again. Use a
    // stateful switch: the first resumed call serves page two, the rest the empty end.
    const { fetchImpl: resumeFetch, calls: resumeCalls } = makeFetch(({ callIndex, requestId }) => {
        if (callIndex === 0) {
            return {
                body: jsonBody(toolMessage(requestId, {
                    properties: [listing('b'), listing('c')],
                    pagination: { nextPageToken: 'tok-final' },
                    requestMetadata: { id: 'req-2' },
                })),
            };
        }
        return {
            body: jsonBody(toolMessage(requestId, {
                properties: [],
                pagination: {},
                requestMetadata: { id: 'req-3' },
            })),
        };
    });
    const { delays: resumeDelays, sleepImpl } = fakeSleep();
    const second = await searchAllListings({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        fetchImpl: resumeFetch,
        sleepImpl,
        state: first.result.state,
        maxPages: 3,
    });

    assert.equal(resumeCalls.length, 2, 'page one is not re-fetched on resume');
    assert.equal(resumeCalls[0].args.nextPageToken, 'tok-retry-me');
    assert.equal(resumeCalls[1].args.nextPageToken, 'tok-final');
    assert.deepEqual(second.properties.map((p) => p.id), ['c'], 'the repeated id b is dropped');
    assert.deepEqual(second.pages.map((p) => ({ page: p.page, status: p.status })), [
        { page: 2, status: 'success' },
        { page: 3, status: 'no_more_results' },
    ]);
    assert.equal(second.status, 'no_more_results');
    assert.equal(second.state.complete, true);
    assert.equal(second.state.pagesFetched, 3);
    assert.deepEqual(second.state.propertyIds, ['a', 'b', 'c']);
    assert.deepEqual(resumeDelays, [], 'a healthy resume does not sleep');
});

// ---------------------------------------------------------------------------
// Scenario 5: a failure on the very first page is not falsely called resumable
// ---------------------------------------------------------------------------

test('a page-one failure reports resumable false and a later retry restarts at page one', async () => {
    const alwaysLimited = () => ({ status: 429, contentType: 'text/plain', body: 'concurrency_limit' });
    const first = await run(alwaysLimited, { searchArgs: BASE_ARGS, maxPages: 2, maxRetries: 0 });

    assert.equal(first.result.status, 'failed');
    assert.equal(first.calls.length, 1, 'maxRetries 0 means a single attempt');
    assert.equal(first.result.pages[0].page, 1);
    assert.equal(first.result.pages[0].status, 'failed');
    assert.equal(first.result.pages[0].resumable, false, 'there is no token to continue from');
    assert.equal(first.result.state.nextPageToken, null);
    assert.equal(first.result.state.complete, false);

    // The rate limit clears. Resuming the state must send no token and start at page one.
    const { fetchImpl, calls } = makeFetch(({ requestId }) => ({
        body: jsonBody(toolMessage(requestId, {
            properties: [listing('a')],
            pagination: {},
            requestMetadata: { id: 'req-late' },
        })),
    }));
    const { sleepImpl } = fakeSleep();
    const second = await searchAllListings({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        fetchImpl,
        sleepImpl,
        state: first.result.state,
        maxPages: 2,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.nextPageToken, undefined);
    assert.equal(second.pages[0].page, 1);
    assert.equal(second.status, 'complete');
});

// ---------------------------------------------------------------------------
// Scenario 6: hard tool errors fail immediately instead of burning retries
// ---------------------------------------------------------------------------

test('a 401-style tool error fails the page without retrying', async () => {
    const handler = ({ requestId }) => ({
        body: jsonBody({
            jsonrpc: '2.0',
            id: requestId,
            result: {
                isError: true,
                content: [{ type: 'text', text: 'HasData API error: 401 Unauthorized' }],
            },
        }),
    });
    const { result, calls, delays } = await run(handler, { searchArgs: BASE_ARGS, maxRetries: 3 });

    assert.equal(calls.length, 1, 'a bad key is not transient and must not be retried');
    assert.deepEqual(delays, []);
    assert.equal(result.status, 'failed');
    assert.equal(result.pages[0].status, 'failed');
    assert.equal(result.pages[0].resumable, false);
    assert.match(result.pages[0].reason, /401/);
});

// ---------------------------------------------------------------------------
// Scenario 7: the per-run page budget is reached, then a resume continues
// ---------------------------------------------------------------------------

test('hitting maxPages parks the token and a resume fetches the remaining pages', async () => {
    const handler = ({ args, requestId }) => {
        if (!args.nextPageToken) {
            return {
                body: jsonBody(toolMessage(requestId, {
                    properties: [listing('a')],
                    pagination: { nextPageToken: 'tok-2' },
                    requestMetadata: { id: 'req-1' },
                })),
            };
        }
        return {
            body: jsonBody(toolMessage(requestId, {
                properties: [listing('b')],
                pagination: {},
                requestMetadata: { id: 'req-2' },
            })),
        };
    };

    const first = await run(handler, { searchArgs: BASE_ARGS, maxPages: 1 });
    assert.equal(first.result.status, 'max_pages_reached');
    assert.equal(first.result.state.complete, false);
    assert.equal(first.result.state.nextPageToken, 'tok-2');

    const { fetchImpl, calls } = makeFetch(handler);
    const { sleepImpl } = fakeSleep();
    const second = await searchAllListings({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        fetchImpl,
        sleepImpl,
        state: first.result.state,
        maxPages: 1,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.nextPageToken, 'tok-2');
    assert.deepEqual(second.properties.map((p) => p.id), ['b']);
    assert.equal(second.status, 'complete');
    assert.deepEqual(second.state.propertyIds, ['a', 'b']);
});

test('a dropped connection is retried and then succeeds', async () => {
    let attempts = 0;
    const fetchImpl = async (endpoint, init) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed: ECONNRESET');
        const request = JSON.parse(init.body);
        return new Response(jsonBody(toolMessage(request.id, {
            properties: [listing('a')],
            pagination: {},
            requestMetadata: { id: 'req-net' },
        })), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { sleepImpl } = fakeSleep();
    const result = await searchAllListings({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        fetchImpl,
        sleepImpl,
        searchArgs: BASE_ARGS,
    });
    assert.equal(attempts, 2);
    assert.equal(result.status, 'complete');
    assert.equal(result.pages[0].attempts, 2);
    assert.equal(result.requestMetadataId, 'req-net');
});

test('createSearchState owns the token and rejects nextPageToken in the seed args', () => {
    const state = createSearchState({ ...BASE_ARGS, nextPageToken: 'ignored' });
    assert.equal(state.searchArgs.nextPageToken, undefined);
    assert.equal(state.nextPageToken, null);
    assert.equal(state.pagesFetched, 0);
    assert.deepEqual(state.propertyIds, []);
    assert.equal(state.complete, false);
});

test('resuming an already-complete state spends no remote call', async () => {
    const done = createSearchState(BASE_ARGS);
    done.complete = true;
    done.pagesFetched = 2;
    done.requestMetadataId = 'req-done';
    const { fetchImpl, calls } = makeFetch(() => {
        throw new Error('should never be called');
    });
    const result = await searchAllListings({ endpoint: ENDPOINT, apiKey: API_KEY, fetchImpl, state: done });
    assert.equal(calls.length, 0);
    assert.equal(result.status, 'complete');
    assert.equal(result.requestMetadataId, 'req-done');
});
