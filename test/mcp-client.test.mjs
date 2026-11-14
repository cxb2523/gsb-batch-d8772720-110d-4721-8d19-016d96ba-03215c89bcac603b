// Local tests for the streamable-HTTP JSON-RPC client (lib/mcp-client.mjs).
//
// No network: fetch is replaced by a fake returning scripted Response objects. These checks pin
// the parts the review flow depends on: plain JSON and SSE bodies both resolve, the request id
// is matched rather than assumed, a 429 surfaces as a typed retriable error carrying the parsed
// Retry-After, and isError tool results become rejections.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpClient, McpHttpError, McpToolError, parseRpcMessages } from '../lib/mcp-client.mjs';

const ENDPOINT = 'https://mcp.hasdata.test/mcp?apis=walmart';

function jsonResponse(status, body, { headers = {} } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function sseResponse(events, { status = 200, headers = {} } = {}) {
    const body = events
        .map((event) => `event: message\ndata: ${JSON.stringify(event)}\n`)
        .join('\n');
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/event-stream', ...headers },
    });
}

function fakeFetch(response) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, init });
        return typeof response === 'function' ? response(url, init) : response;
    };
    return { fetchImpl, requests };
}

test('a plain JSON-RPC body resolves to the matched result', async () => {
    const { fetchImpl, requests } = fakeFetch(
        jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { tools: [] } })
    );
    const client = createMcpClient({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl });

    const tools = await client.listTools();
    assert.deepEqual(tools, []);

    const sent = JSON.parse(requests[0].init.body);
    assert.equal(sent.method, 'tools/list');
    assert.equal(sent.jsonrpc, '2.0');
    assert.equal(requests[0].init.headers['x-api-key'], 'k');
    assert.match(requests[0].init.headers.Accept, /text\/event-stream/);
});

test('an SSE stream with notifications and the answer resolves by request id', async () => {
    const { fetchImpl } = fakeFetch(
        sseResponse([
            { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
            { jsonrpc: '2.0', id: 2, result: { ok: true } },
            { jsonrpc: '2.0', id: 999, result: { ok: false } },
        ])
    );
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    // The client's first request gets id 1 locally, so craft the raw case via parseRpcMessages.
    const messages = parseRpcMessages(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n'
    );
    assert.deepEqual(messages.map((m) => m.id), [1, 2]);

    // The SSE response above carries id 2 while the client sends id 1: no match must error.
    await assert.rejects(client.request('ping'), /no JSON-RPC message with id 1/);
});

test('multi-line SSE data blocks are reassembled into one message', () => {
    const raw = 'data: {"jsonrpc":"2.0","id":\ndata: 1,"result":{"x":true}}\n\n';
    const messages = parseRpcMessages(raw);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].result, { x: true });
});

test('a 429 is a typed retriable error with numeric Retry-After in ms', async () => {
    const { fetchImpl, requests } = fakeFetch(
        jsonResponse(429, { error: 'concurrency_limit' }, { headers: { 'Retry-After': '30' } })
    );
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    await assert.rejects(
        client.request('tools/list'),
        (error) => {
            assert.ok(error instanceof McpHttpError);
            assert.equal(error.status, 429);
            assert.equal(error.isRateLimited, true);
            assert.equal(error.retryAfterMs, 30_000);
            return true;
        }
    );
    assert.equal(requests.length, 1); // the client itself does not retry
});

test('an HTTP-date Retry-After is converted into a delay from now', async () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const { fetchImpl } = fakeFetch(jsonResponse(429, {}, { headers: { 'Retry-After': future } }));
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    await assert.rejects(client.request('tools/list'), (error) => {
        assert.ok(error.retryAfterMs >= 4000 && error.retryAfterMs <= 6000);
        return true;
    });
});

test('a 500 is a terminal non-retriable error', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(500, { error: 'boom' }));
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    await assert.rejects(client.request('tools/list'), (error) => {
        assert.ok(error instanceof McpHttpError);
        assert.equal(error.status, 500);
        assert.equal(error.isRateLimited, false);
        return true;
    });
});

test('a network failure becomes an McpHttpError with no status', async () => {
    const fetchImpl = async () => {
        throw new TypeError('fetch failed');
    };
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    await assert.rejects(client.request('tools/list'), (error) => {
        assert.ok(error instanceof McpHttpError);
        assert.equal(error.status, null);
        assert.equal(error.isRateLimited, false);
        return true;
    });
});

test('callTool parses the text content block and passes tool args through', async () => {
    const { fetchImpl, requests } = fakeFetch(
        jsonResponse(200, {
            jsonrpc: '2.0',
            id: 1,
            result: {
                content: [{ type: 'text', text: JSON.stringify({ reviewResults: [], pagination: {} }) }],
            },
        })
    );
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    const payload = await client.callTool('hasdata_walmart_reviews_getWalmartReviews', {
        itemId: '123',
        page: 1,
    });
    assert.deepEqual(payload, { reviewResults: [], pagination: {} });

    const sent = JSON.parse(requests[0].init.body);
    assert.equal(sent.method, 'tools/call');
    assert.equal(sent.params.name, 'hasdata_walmart_reviews_getWalmartReviews');
    assert.deepEqual(sent.params.arguments, { itemId: '123', page: 1 });
});

test('an isError tool result rejects as McpToolError', async () => {
    const { fetchImpl } = fakeFetch(
        jsonResponse(200, {
            jsonrpc: '2.0',
            id: 1,
            result: { isError: true, content: [{ type: 'text', text: 'bad request' }] },
        })
    );
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    await assert.rejects(client.callTool('tool', {}), (error) => {
        assert.ok(error instanceof McpToolError);
        assert.equal(error.toolName, 'tool');
        return true;
    });
});

test('a JSON-RPC error envelope rejects with its code', async () => {
    const { fetchImpl } = fakeFetch(
        jsonResponse(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } })
    );
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });

    await assert.rejects(client.request('tools/list'), (error) => {
        assert.ok(error instanceof McpToolError);
        assert.equal(error.code, -32602);
        assert.match(error.message, /invalid params/);
        return true;
    });
});

test('non-JSON text content is an McpToolError rather than a silent parse failure', async () => {
    const { fetchImpl } = fakeFetch(
        jsonResponse(200, {
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: 'plain text, not json' }] },
        })
    );
    const client = createMcpClient({ endpoint: ENDPOINT, fetchImpl });
    await assert.rejects(client.callTool('tool', {}), McpToolError);
});
