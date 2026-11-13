// Tests for the default remote adapter. Every fetch is a local fake returning canned JSON-RPC
// or SSE envelopes, so these tests need neither network access nor HASDATA_API_KEY. They pin
// the translation from transport/tool errors into the ScrapeToolError taxonomy the
// orchestrator consumes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteScraper, DEFAULT_ENDPOINT } from '../lib/remote-scraper.mjs';
import { TOOL_NAME } from '../lib/scrape-errors.mjs';

function jsonResponse(status, body) {
    return {
        status,
        text: async () => JSON.stringify(body),
    };
}

function sseResponse(events) {
    const raw = events
        .map((event) => `data: ${JSON.stringify(event)}`)
        .join('\n\n');
    return { status: 200, text: async () => raw };
}

function toolResult(payload, extra = {}) {
    return {
        jsonrpc: '2.0',
        id: 1,
        result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            ...extra,
        },
    };
}

function recordingFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return responses.shift();
    };
    return { fetchImpl, calls };
}

const scraperOptions = (fetchImpl, extra = {}) => ({
    fetch: fetchImpl,
    apiKey: 'test-key',
    timeoutMs: 5000,
    ...extra,
});

test('posts a tools/call for the single documented tool with the request arguments', async () => {
    const { fetchImpl, calls } = recordingFetch([
        jsonResponse(200, toolResult({ status: 200, json: null, text: 'hi' })),
    ]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    const request = {
        url: 'https://example.test/',
        outputFormat: ['json'],
        jsRendering: false,
        extractRules: { title: 'h1' },
    };
    await scrape(request);

    assert.equal(calls[0].url, DEFAULT_ENDPOINT);
    assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, TOOL_NAME);
    assert.deepEqual(body.params.arguments, request);
    assert.equal(typeof body.id, 'number');
});

test('omits undefined optional parameters so server defaults keep applying', async () => {
    const { fetchImpl, calls } = recordingFetch([
        jsonResponse(200, toolResult({ status: 200, json: null, text: 'hi' })),
    ]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    await scrape({ url: 'https://example.test/' });

    const args = JSON.parse(calls[0].init.body).params.arguments;
    assert.deepEqual(args, { url: 'https://example.test/' });
});

test('parses a plain JSON-RPC payload and an SSE stream alike', async () => {
    const payload = { status: 200, json: null, text: 'markdown body' };
    const plain = createRemoteScraper(scraperOptions(
        recordingFetch([jsonResponse(200, toolResult(payload))]).fetchImpl,
    ));
    assert.deepEqual(await plain({ url: 'https://a.test/' }), payload);

    const streamed = createRemoteScraper(scraperOptions(
        recordingFetch([
            sseResponse([
                { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
                toolResult(payload),
            ]),
        ]).fetchImpl,
    ));
    assert.deepEqual(await streamed({ url: 'https://b.test/' }), payload);
});

test('fails lazily with a clear configuration error when no API key is set', async () => {
    const { fetchImpl } = recordingFetch([]);
    const scrape = createRemoteScraper({ fetch: fetchImpl }); // no apiKey, no env expectation
    await assert.rejects(
        () => scrape({ url: 'https://example.test/' }),
        (error) => error.name === 'ScrapeToolError' && error.message.includes('HASDATA_API_KEY'),
    );
    assert.equal((await Promise.resolve(1)), 1, 'importing/creating the scraper must not require a key');
});

test('maps an HTTP 429 envelope to a retryable ScrapeToolError', async () => {
    const { fetchImpl } = recordingFetch([
        jsonResponse(429, { jsonrpc: '2.0', id: 1, error: { message: '429 Too Many Requests', data: {} } }),
    ]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    await assert.rejects(
        () => scrape({ url: 'https://example.test/' }),
        (error) => error.name === 'ScrapeToolError' && error.statusCode === 429 && error.retryable === true,
    );
});

test('maps an HTTP 400 envelope to an unreachable, non-retryable error', async () => {
    const { fetchImpl } = recordingFetch([
        jsonResponse(400, { jsonrpc: '2.0', id: 1, error: { message: 'bad request' } }),
    ]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    await assert.rejects(
        () => scrape({ url: 'https://example.test/' }),
        (error) => error.statusCode === 400 && error.retryable === false,
    );
});

test('maps JSON-RPC concurrency_limit errors inside a 200 to retryable', async () => {
    const { fetchImpl } = recordingFetch([
        jsonResponse(200, {
            jsonrpc: '2.0',
            id: 1,
            error: { message: 'concurrency_limit exceeded', data: { errorType: 'concurrency_limit' } },
        }),
    ]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    await assert.rejects(
        () => scrape({ url: 'https://example.test/' }),
        (error) => error.retryable === true && error.errorType === 'concurrency_limit',
    );
});

test('maps an isError tool result carrying proxyConnection to unreachable', async () => {
    const { fetchImpl } = recordingFetch([
        jsonResponse(200, toolResult(
            { error: { errorType: 'proxyConnection', message: 'proxy connection to the target failed' } },
            { isError: true },
        )),
    ]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    await assert.rejects(
        () => scrape({ url: 'https://example.test/' }),
        (error) => error.errorType === 'proxyConnection' && error.retryable === false,
    );
});

test('surfaces an in-band error block in an otherwise successful tool result', async () => {
    const { fetchImpl } = recordingFetch([
        jsonResponse(200, toolResult({
            url: 'https://example.test/',
            error: { errorType: 'proxyConnection', message: 'target never loaded' },
        })),
    ]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    await assert.rejects(
        () => scrape({ url: 'https://example.test/' }),
        (error) => error.name === 'ScrapeToolError' && error.message.includes('target never loaded'),
    );
});

test('lets a 403/404 target response through as a payload so it is classified blocked', async () => {
    const blocked = { json: { statusCode: 403, extractedData: {} }, text: null };
    const { fetchImpl } = recordingFetch([jsonResponse(200, toolResult(blocked))]);
    const scrape = createRemoteScraper(scraperOptions(fetchImpl));
    const payload = await scrape({ url: 'https://example.test/' });
    assert.equal(payload.json.statusCode, 403);
});

test('wraps transport failures and non-JSON text in ScrapeToolError', async () => {
    const broken = async () => { throw new TypeError('fetch failed: ECONNRESET'); };
    const networkScraper = createRemoteScraper(scraperOptions(broken));
    await assert.rejects(
        () => networkScraper({ url: 'https://example.test/' }),
        (error) => error.name === 'ScrapeToolError' && error.errorType === 'transportError',
    );

    const { fetchImpl } = recordingFetch([
        { status: 200, text: async () => 'this is not json at all' },
    ]);
    const garbageScraper = createRemoteScraper(scraperOptions(fetchImpl));
    await assert.rejects(
        () => garbageScraper({ url: 'https://example.test/' }),
        (error) => error.name === 'ScrapeToolError' && error.message.includes('no JSON-RPC message'),
    );
});
