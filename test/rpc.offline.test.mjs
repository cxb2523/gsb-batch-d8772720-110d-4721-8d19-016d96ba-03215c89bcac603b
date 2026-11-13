// Offline tests for the JSON-RPC transport and the call-summary logic.
//
// Nothing here touches the network: a scripted transport replays canned responses from
// test/fixtures, so the parsing, retry and bookkeeping behaviour stays verifiable on a
// fork without a key. The live suite in tools.test.mjs still uses the real endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    parseRpc,
    createRpcClient,
    createFetchTransport,
    RpcError,
    summarizeRecords,
    formatSummary,
    MAX_ATTEMPTS,
} from '../test-helpers/rpc.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const noSleep = async () => {};

// A transport that replays a fixed script of responses, in order. Every request it saw is
// captured so the tests can assert on method, params and headers the client produced. A
// real server answers with the request id, so the canned bodies (which all use id 1) are
// re-stamped with the id the client actually sent.
function scriptedTransport(script) {
    const requests = [];
    let cursor = 0;
    return {
        requests,
        async transport(request) {
            requests.push(request);
            const response = script[Math.min(cursor, script.length - 1)];
            cursor += 1;
            const raw = response.raw.replace(/"id":1\b/, `"id":${request.id}`);
            return { status: response.status, raw };
        },
    };
}

test('parseRpc reads a plain JSON body', () => {
    const body = parseRpc(fixture('tools-list.json'), 1);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.result.tools.length, 2);
    assert.equal(body.result.tools[0].name, 'hasdata_amazon_search_getSearchResults');
});

test('parseRpc reads an SSE body, skips notifications and rejoins multi-line data', () => {
    const body = parseRpc(fixture('tool-call.sse'), 1);
    assert.equal(body.id, 1);
    assert.equal(body.result.isError, false);
    // The text payload was split across two data: lines; it must be whole JSON again.
    const text = body.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.asin, 'B0DHJ7SBDR');
    assert.equal(parsed.title, 'Laptop stand');
});

test('parseRpc throws when no event carries the request id', () => {
    const sse = [
        'event: message',
        'data: {"jsonrpc":"2.0","id":99,"result":{}}',
        '',
    ].join('\n');
    assert.throws(() => parseRpc(sse, 1), /no message with id 1/);
});

test('parseRpc throws when the body holds no JSON-RPC message', () => {
    assert.throws(() => parseRpc('event: ping\ndata: keep-alive\n\n', 1), /no JSON-RPC message/);
    assert.throws(() => parseRpc('not json at all', 1), /no JSON-RPC message|JSON/);
});

test('a successful plain-JSON call is recorded once with no retries', async () => {
    const stub = scriptedTransport([{ status: 200, raw: fixture('tools-list.json') }]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    const { body, record } = await client.call('tools/list');

    assert.equal(body.result.tools.length, 2);
    assert.deepEqual(stub.requests[0], {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
    });
    assert.equal(record.method, 'tools/list');
    assert.equal(record.toolName, null);
    assert.equal(record.attempts, 1);
    assert.equal(record.retries, 0);
    assert.equal(record.concurrencyLimit, false);
    assert.equal(record.status, 200);
    assert.equal(record.ok, true);
});

test('an SSE success records the tool name and marks the call successful', async () => {
    const stub = scriptedTransport([{ status: 200, raw: fixture('tool-call.sse') }]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    const { record } = await client.call('tools/call', {
        name: 'hasdata_amazon_search_getSearchResults',
        arguments: { q: 'laptop stand' },
    });

    assert.equal(record.method, 'tools/call');
    assert.equal(record.toolName, 'hasdata_amazon_search_getSearchResults');
    assert.equal(record.attempts, 1);
    assert.equal(record.status, 200);
    assert.equal(record.ok, true);
});

test('429 concurrency_limit responses are retried with growing waits, then succeed', async () => {
    const waits = [];
    const stub = scriptedTransport([
        { status: 429, raw: fixture('concurrency-limit.json') },
        { status: 429, raw: fixture('concurrency-limit.json') },
        { status: 200, raw: fixture('tools-list.json') },
    ]);
    const client = createRpcClient({
        transport: stub.transport,
        sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
        },
    });

    const { record } = await client.call('tools/list');

    assert.equal(stub.requests.length, 3);
    assert.deepEqual(waits, [4000, 8000]);
    assert.equal(record.attempts, 3);
    assert.equal(record.retries, 2);
    assert.equal(record.concurrencyLimit, true);
    assert.equal(record.status, 200);
    assert.equal(record.ok, true);
});

test('five consecutive concurrency_limit responses exhaust the budget and fail', async () => {
    const stub = scriptedTransport(
        Array.from({ length: MAX_ATTEMPTS }, () => ({ status: 429, raw: fixture('concurrency-limit.json') }))
    );
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    await assert.rejects(
        () => client.call('tools/list'),
        (err) => {
            assert.ok(err instanceof RpcError);
            assert.equal(err.status, 429);
            assert.equal(err.code, 'concurrency_limit');
            assert.match(err.message, /after 5 attempts/);
            assert.ok(err.message.includes('concurrency_limit'));
            return true;
        }
    );

    assert.equal(stub.requests.length, MAX_ATTEMPTS);
    const record = client.records[0];
    assert.equal(record.attempts, 5);
    assert.equal(record.retries, 4);
    assert.equal(record.concurrencyLimit, true);
    assert.equal(record.status, 429);
    assert.equal(record.ok, false);
    assert.match(record.reason, /retries exhausted/);
});

test('401 fails on the first attempt, is never retried and keeps the body fragment', async () => {
    const stub = scriptedTransport([{ status: 401, raw: fixture('unauthorized-401.json') }]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    await assert.rejects(
        () => client.call('tools/call', { name: 'hasdata_amazon_search_getSearchResults' }),
        (err) => {
            assert.ok(err instanceof RpcError);
            assert.equal(err.status, 401);
            assert.equal(err.code, 'unauthorized');
            assert.match(err.message, /401/);
            assert.match(err.message, /no retry/);
            assert.ok(err.message.includes('revoked x-api-key'));
            return true;
        }
    );

    assert.equal(stub.requests.length, 1);
    const record = client.records[0];
    assert.equal(record.attempts, 1);
    assert.equal(record.retries, 0);
    assert.equal(record.concurrencyLimit, false);
    assert.equal(record.status, 401);
    assert.equal(record.ok, false);
});

test('a non-200 status other than 401/429 fails immediately with status and snippet', async () => {
    const stub = scriptedTransport([{ status: 500, raw: fixture('server-error-500.json') }]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    await assert.rejects(
        () => client.call('tools/list'),
        (err) => {
            assert.equal(err.status, 500);
            assert.match(err.message, /returned 500/);
            assert.ok(err.message.includes('upstream timed out'));
            return true;
        }
    );
    assert.equal(stub.requests.length, 1);
    assert.equal(client.records[0].status, 500);
    assert.equal(client.records[0].ok, false);
});

test('a 429 without the concurrency_limit code is not retried', async () => {
    const stub = scriptedTransport([{ status: 429, raw: '{"message":"rate limited for another reason"}' }]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    await assert.rejects(() => client.call('tools/list'), /returned 429/);
    assert.equal(stub.requests.length, 1);
    assert.equal(client.records[0].concurrencyLimit, false);
});

test('a tools/call answer with isError is a failed outcome, not a success', async () => {
    const stub = scriptedTransport([{ status: 200, raw: fixture('tool-error-result.json') }]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    const { record } = await client.call('tools/call', {
        name: 'hasdata_amazon_reviews_getProductReviews',
        arguments: { asin: 'B0DHJ7SBDR' },
    });

    assert.equal(record.status, 200);
    assert.equal(record.ok, false);
    assert.match(record.reason, /isError/);
    assert.equal(record.toolName, 'hasdata_amazon_reviews_getProductReviews');
});

test('a transport-level rejection is recorded without an HTTP status', async () => {
    const failing = async () => {
        throw new TypeError('network down');
    };
    const client = createRpcClient({ transport: failing, sleep: noSleep });

    await assert.rejects(() => client.call('tools/list'), /network down/);
    const record = client.records[0];
    assert.equal(record.status, null);
    assert.equal(record.ok, false);
    assert.match(record.reason, /transport error/);
});

test('an unparseable 200 body fails with the parse reason', async () => {
    const stub = scriptedTransport([{ status: 200, raw: 'event: ping\ndata: nothing useful\n\n' }]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    await assert.rejects(() => client.call('tools/list'), /could not be parsed/);
    assert.equal(client.records[0].status, 200);
    assert.equal(client.records[0].ok, false);
});

test('summarizeRecords groups by method and tool with totals and the final verdict', async () => {
    const stub = scriptedTransport([
        { status: 429, raw: fixture('concurrency-limit.json') },
        { status: 200, raw: fixture('tool-call.sse') },
        { status: 200, raw: fixture('tool-error-result.json') },
    ]);
    const client = createRpcClient({ transport: stub.transport, sleep: noSleep });

    await client.call('tools/call', { name: 'hasdata_amazon_search_getSearchResults' });
    await client.call('tools/call', { name: 'hasdata_amazon_reviews_getProductReviews' });

    const rows = summarizeRecords(client.records);
    assert.equal(rows.length, 2);

    const search = rows.find((r) => r.toolName === 'hasdata_amazon_search_getSearchResults');
    assert.equal(search.calls, 1);
    assert.equal(search.successes, 1);
    assert.equal(search.retries, 1);
    assert.equal(search.final.ok, true);

    const reviews = rows.find((r) => r.toolName === 'hasdata_amazon_reviews_getProductReviews');
    assert.equal(reviews.calls, 1);
    assert.equal(reviews.successes, 0);
    assert.equal(reviews.final.ok, false);

    const text = formatSummary(client.records);
    assert.match(text, /tools\/call hasdata_amazon_search_getSearchResults/);
    assert.match(text, /calls: 1, successes: 1, retries: 1/);
    assert.match(text, /final outcome: SUCCESS/);
    assert.match(text, /hasdata_amazon_reviews_getProductReviews/);
    assert.match(text, /final outcome: FAILED/);
});

test('formatSummary explicitly labels a skipped run instead of looking green', () => {
    const text = formatSummary([], { skipped: true });
    assert.match(text, /SKIPPED/);
    assert.match(text, /HASDATA_API_KEY is not set/);
    assert.doesNotMatch(text, /SUCCESS/);
});

test('the fetch transport posts the JSON-RPC envelope and the key header', async () => {
    const seen = [];
    const fakeFetch = async (url, init) => {
        seen.push({ url, init });
        return {
            status: 200,
            async text() {
                return fixture('tools-list.json');
            },
        };
    };
    const transport = createFetchTransport({
        endpoint: 'https://example.test/mcp',
        apiKey: 'secret-key',
        fetchImpl: fakeFetch,
    });
    const response = await transport({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });

    assert.equal(response.status, 200);
    assert.equal(seen[0].url, 'https://example.test/mcp');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers['x-api-key'], 'secret-key');
    assert.equal(seen[0].init.headers.Accept, 'application/json, text/event-stream');
    assert.deepEqual(JSON.parse(seen[0].init.body), {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
        params: {},
    });
});
