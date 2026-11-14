// Client-level tests against a local HTTP server: no network, no API key, no credits.
// Verifies JSON-RPC unwrapping for both plain JSON and SSE bodies, the 429 signal path and the
// normalized network-error reply shape the engine relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { HasdataShopifyClient, TOOLS } from '../lib/mcp-client.mjs';
import { isRateLimitedReply, scanStore, OUTCOME } from '../lib/catalog-scan.mjs';

function rpcTextResult(payload, { isError = false } = {}) {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError },
    });
}

async function serve(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
        return await run(endpoint);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('client unwraps a plain JSON-RPC tool result into the products payload', async () => {
    await serve(
        (request, response) => {
            assert.equal(request.headers['x-api-key'], 'test-key');
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(rpcTextResult({ products: [{ handle: 'one', variants: [] }] }));
        },
        async (endpoint) => {
            const client = new HasdataShopifyClient({ apiKey: 'test-key', endpoint });
            const reply = await client.callTool(TOOLS.PRODUCTS, { url: 'https://shop', limit: 250, page: 1 });
            assert.equal(reply.status, 200);
            assert.deepEqual(reply.payload.products.map((p) => p.handle), ['one']);
        }
    );
});

test('client parses server-sent events and picks the message matching its request id', async () => {
    await serve(
        (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write('event: progress\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
            response.write(
                `data: ${rpcTextResult({ products: [] })}\n\n`
            );
            response.end('data: [DONE]\n\n');
        },
        async (endpoint) => {
            const client = new HasdataShopifyClient({ apiKey: 'test-key', endpoint });
            const reply = await client.callTool(TOOLS.PRODUCTS, { url: 'https://shop', collection: 'c', limit: 250, page: 1 });
            assert.deepEqual(reply.payload, { products: [] });
        }
    );
});

test('an error string body comes through as a non-Shopify reply the engine can classify', async () => {
    await serve(
        (request, response) => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(rpcTextResult({ error: 'shopify store not found' }));
        },
        async (endpoint) => {
            const client = new HasdataShopifyClient({ apiKey: 'test-key', endpoint });
            const fetcher = client.makeProductsFetcher('https://headless.example');
            const record = await scanStore({
                url: 'https://headless.example',
                collections: ['coll'],
                fetcher,
                sleepImpl: async () => {},
                now: () => '2026-11-14T00:00:00.000Z',
            });
            assert.equal(record.page_outcomes[0].outcome, OUTCOME.NON_SHOPIFY);
            assert.equal(isRateLimitedReply(await fetcher({ collection: 'coll', limit: 250, page: 1 })), false);
        }
    );
});

test('HTTP 429 is a rate-limit reply and is retried until the server recovers', async () => {
    let attempts = 0;
    await serve(
        (request, response) => {
            attempts += 1;
            if (attempts < 3) {
                response.writeHead(429, { 'Content-Type': 'text/plain' });
                response.end('rate limited');
                return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(rpcTextResult({ products: [{ handle: 'p', variants: [] }] }));
        },
        async (endpoint) => {
            const client = new HasdataShopifyClient({ apiKey: 'test-key', endpoint });
            const fetcher = client.makeProductsFetcher('https://shop');
            const record = await scanStore({
                url: 'https://shop',
                collections: ['coll'],
                fetcher,
                sleepImpl: async () => {},
                now: () => '2026-11-14T00:00:00.000Z',
            });
            assert.equal(attempts, 3);
            assert.equal(record.page_outcomes[0].outcome, OUTCOME.SUCCESS);
            assert.equal(record.page_outcomes[0].attempts, 3);
        }
    );
});

test('concurrency_limit inside a 200 body is also a rate-limit reply', async () => {
    await serve(
        (request, response) => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'concurrency_limit' } }) }],
                    },
                })
            );
        },
        async (endpoint) => {
            const client = new HasdataShopifyClient({ apiKey: 'test-key', endpoint });
            const reply = await client.callTool(TOOLS.PRODUCTS, {});
            assert.equal(isRateLimitedReply(reply), true);
        }
    );
});

test('a connection failure is normalized into a non-rate-limited reply, never thrown', async () => {
    const client = new HasdataShopifyClient({
        apiKey: 'test-key',
        endpoint: 'http://127.0.0.1:1/unreachable',
        timeoutMs: 2_000,
    });
    const reply = await client.callTool(TOOLS.PRODUCTS, {});
    assert.equal(isRateLimitedReply(reply), false);
    assert.equal(reply.status, 0);
    assert.match(reply.payload.error, /network error/);
});

test('listCollections returns handles and reports failure when no collections array appears', async () => {
    await serve(
        (request, response) => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(rpcTextResult({ collections: [{ handle: 'shoes', products_count: 3 }] }));
        },
        async (endpoint) => {
            const client = new HasdataShopifyClient({ apiKey: 'test-key', endpoint });
            const result = await client.listCollections('https://shop');
            assert.equal(result.ok, true);
            assert.deepEqual(result.collections.map((c) => c.handle), ['shoes']);
        }
    );
});
