// Transport-layer tests for lib/jsonrpc.mjs. Everything here runs against a scripted
// in-process fetch double — no network, no API key, no real HasData responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, callToolWithRetry, RemoteCallError, HASDATA_YELP_ENDPOINT } from '../lib/jsonrpc.mjs';

const fakeResponse = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
});

const rpcEnvelope = (textContent) =>
    JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(textContent) }] },
    });

const baseOptions = { apiKey: 'test-key', args: { placeId: 'biz', num: 49 }, id: 1 };

test('callTool posts JSON-RPC to the documented endpoint with x-api-key and the reviews tool', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
        seen = { url, init };
        return fakeResponse(200, rpcEnvelope({ reviews: [] }));
    };
    await callTool({ ...baseOptions, fetchImpl });

    assert.equal(seen.url, HASDATA_YELP_ENDPOINT);
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers['x-api-key'], 'test-key');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'hasdata_yelp_reviews_getPlaceReviews');
    assert.deepEqual(body.params.arguments, { placeId: 'biz', num: 49 });
});

test('callTool unwraps a plain JSON envelope and returns the tool payload', async () => {
    const payload = { pagination: { hasNextPage: false }, reviews: [{ id: 'r1' }] };
    const result = await callTool({ ...baseOptions, fetchImpl: async () => fakeResponse(200, rpcEnvelope(payload)) });
    assert.deepEqual(result, payload);
});

test('callTool parses a server-sent-event stream and finds the message matching its id', async () => {
    const sse = [
        'event: message',
        'data: {"jsonrpc":"2.0","id":99,"method":"notifications/progress","params":{}}',
        '',
        'event: message',
        'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"reviews\\":[]}"}]}}',
        '',
    ].join('\n');
    const result = await callTool({ ...baseOptions, fetchImpl: async () => fakeResponse(200, sse) });
    assert.deepEqual(result, { reviews: [] });
});

test('HTTP 429 is classified as a retryable concurrency_limit error', async () => {
    await assert.rejects(
        () => callTool({ ...baseOptions, fetchImpl: async () => fakeResponse(429, 'slow down', { 'retry-after': '5' }) }),
        (error) => {
            assert.ok(error instanceof RemoteCallError);
            assert.equal(error.retryable, true);
            assert.equal(error.reason, 'concurrency_limit');
            assert.equal(error.statusCode, 429);
            assert.equal(error.retryAfterMs, 5000);
            return true;
        }
    );
});

test('a 200 body carrying concurrency_limit is still classified as retryable rate limiting', async () => {
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'concurrency_limit exceeded' },
    });
    await assert.rejects(
        () => callTool({ ...baseOptions, fetchImpl: async () => fakeResponse(200, body) }),
        (error) => error.retryable === true && error.reason === 'concurrency_limit'
    );
});

test('HTTP 401 is not retryable and carries a stable http_401 reason', async () => {
    await assert.rejects(
        () => callTool({ ...baseOptions, fetchImpl: async () => fakeResponse(401, 'unauthorized') }),
        (error) => error.retryable === false && error.reason === 'http_401'
    );
});

test('a transport failure (fetch rejects) is retryable as network_error', async () => {
    await assert.rejects(
        () => callTool({ ...baseOptions, fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
        (error) => error.retryable === true && error.reason === 'network_error'
    );
});

test('a JSON-RPC error envelope is surfaced as a non-retryable jsonrpc_error', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } });
    await assert.rejects(
        () => callTool({ ...baseOptions, fetchImpl: async () => fakeResponse(200, body) }),
        (error) => error.retryable === false && error.reason === 'jsonrpc_error'
    );
});

test('callToolWithRetry retries retryable failures with increasing delays and returns attempts', async () => {
    const sleeps = [];
    let calls = 0;
    const payload = { reviews: [{ id: 'r1' }], pagination: { hasNextPage: false } };
    const fetchImpl = async () => {
        calls += 1;
        if (calls <= 2) return fakeResponse(429, 'concurrency_limit');
        return fakeResponse(200, rpcEnvelope(payload));
    };
    const result = await callToolWithRetry(
        { ...baseOptions, fetchImpl },
        { maxAttempts: 4, baseDelayMs: 100 },
        async (ms) => sleeps.push(ms)
    );
    assert.equal(calls, 3);
    assert.deepEqual(result, { payload, attempts: 3 });
    // 100, 200: exponential backoff between attempts 1->2 and 2->3.
    assert.deepEqual(sleeps, [100, 200]);
});

test('callToolWithRetry does not retry non-retryable errors', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return fakeResponse(401, 'nope');
    };
    await assert.rejects(() =>
        callToolWithRetry({ ...baseOptions, fetchImpl }, { maxAttempts: 5, baseDelayMs: 1 }, async () => {
            throw new Error('sleep must not be called');
        })
    );
    assert.equal(calls, 1);
});

test('callToolWithRetry exhausts the budget on a stubborn limiter and reports attempts', async () => {
    let calls = 0;
    await assert.rejects(
        () =>
            callToolWithRetry(
                { ...baseOptions, fetchImpl: async () => { calls += 1; return fakeResponse(429, 'concurrency_limit'); } },
                { maxAttempts: 3, baseDelayMs: 1 },
                async () => {}
            ),
        (error) => error.reason === 'concurrency_limit' && error.attempts === 3
    );
    assert.equal(calls, 3);
});
