// Tool contract test.
//
// The README promises four tools with specific names and required parameters. The upstream list
// can change without a single commit here, and the README would start lying silently. These
// checks catch that before a user does.
//
// The server also lists a fifth tool, the reviews one, whose upstream endpoint is retired. It is
// deliberately absent from the README, and the last test pins that state instead of ignoring it:
// if the endpoint comes back, or the server stops listing it, the run goes red and the README
// needs a decision rather than a silent drift.
//
// One test calls a tool for real. Listing tools accepts any non-empty key, so a contract check
// that only lists tools stays green with a revoked or mistyped key. That call costs 5 credits,
// which is the price of a canary that can fail for the right reason.
//
// A bare pass/fail cannot tell a changed tool list, a dead key and a concurrency cap apart.
// Every real call therefore goes through the recording client in test-helpers/rpc.mjs, and a
// top-level hook prints a per-tool summary (calls, successes, retries, final HTTP status and
// verdict) at the end. Without HASDATA_API_KEY the live checks are skipped and the summary says
// so explicitly, instead of looking like an all-green run. The parsing, retry and summary logic
// has its own offline suite in rpc.offline.test.mjs driven by canned JSON-RPC responses.
//
// Run: HASDATA_API_KEY=your_key_here npm test

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    ENDPOINT,
    TIMEOUT_MS,
    createRpcClient,
    createFetchTransport,
    parseRpc,
    formatSummary,
} from '../test-helpers/rpc.mjs';

const KEY = process.env.HASDATA_API_KEY;

const EXPECTED = {
    hasdata_amazon_search_getSearchResults: ['q'],
    hasdata_amazon_product_getProductDetails: ['asin'],
    hasdata_amazon_seller_getSellerDetails: ['sellerId'],
    hasdata_amazon_seller_products_getSellerProducts: ['sellerId'],
};

// Listed by the server, retired upstream. Not documented in the README on purpose.
const RETIRED = {
    hasdata_amazon_reviews_getProductReviews: ['asin'],
};

// The recording client: the real endpoint over fetch, with the concurrency_limit retry budget
// and one record appended per call. Offline tests inject a fake transport instead.
const rpcClient = createRpcClient({
    transport: createFetchTransport({ endpoint: ENDPOINT, apiKey: KEY, timeoutMs: TIMEOUT_MS }),
});

async function rpc(method, params = {}) {
    const { body, raw, record } = await rpcClient.call(method, params);
    return { body, raw, record };
}

// One network round trip for every test that needs the list.
let toolsPromise;
function listTools() {
    toolsPromise ??= rpc('tools/list').then(({ body }) => {
        assert.ok(body.result?.tools, 'the response carried no result.tools');
        return body.result.tools;
    });
    return toolsPromise;
}

const live = { skip: KEY ? false : 'HASDATA_API_KEY is not set, skipping the live checks' };

const ALL = { ...EXPECTED, ...RETIRED };

// Runs after every test, including skipped and failing ones, so the summary is always emitted.
after(() => {
    process.stdout.write(formatSummary(rpcClient.records, { skipped: !KEY }));
    process.stdout.write('\n');
});

test('apis=amazon exposes the documented tools and nothing else', live, async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name).sort().join(', ');
    assert.equal(
        tools.length,
        Object.keys(ALL).length,
        `expected ${Object.keys(ALL).length} tools, got ${tools.length}: ${names}`
    );
});

test('the tool names have not changed', live, async () => {
    const tools = await listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const expected of Object.keys(ALL)) {
        assert.ok(names.has(expected), `tool ${expected} is missing from the list`);
    }
});

test('every tool still declares its required parameter', live, async () => {
    const tools = await listTools();
    for (const tool of tools) {
        const required = tool.inputSchema?.required ?? [];
        const want = ALL[tool.name];
        assert.ok(want, `tool ${tool.name} is not covered by this test`);
        for (const param of want) {
            assert.ok(
                required.includes(param),
                `${tool.name} should require ${param}, declares: ${required.join(', ') || 'nothing'}`
            );
        }
    }
});

test('every tool carries a description', live, async () => {
    const tools = await listTools();
    for (const tool of tools) {
        assert.ok(
            (tool.description || '').trim().length > 20,
            `${tool.name} has an empty or near-empty description`
        );
    }
});

test('the key is accepted by HasData', live, async () => {
    const { raw, record } = await rpc('tools/call', {
        name: 'hasdata_amazon_search_getSearchResults',
        arguments: { q: 'laptop stand' },
    });
    assert.ok(!raw.includes('401 Unauthorized'), 'HasData rejected the key');
    assert.ok(!raw.includes('"isError":true'), `the tool call failed: ${raw.slice(0, 300)}`);
    // The same facts the assertions just checked must be visible in the record as well.
    assert.equal(record.method, 'tools/call');
    assert.equal(record.toolName, 'hasdata_amazon_search_getSearchResults');
    assert.equal(record.status, 200);
    assert.equal(record.ok, true);
});

// The reviews endpoint is retired upstream and answers 400. The README does not document the
// tool for that reason. This check exists so the omission stays deliberate: the day the call
// succeeds, or the day the server drops the tool, this fails and the README gets revisited.
test('the retired reviews tool still answers with an error', live, async () => {
    const { raw, record } = await rpc('tools/call', {
        name: 'hasdata_amazon_reviews_getProductReviews',
        arguments: { asin: 'B0DHJ7SBDR' },
    });
    assert.ok(!raw.includes('401 Unauthorized'), 'HasData rejected the key');
    assert.ok(
        raw.includes('"isError":true'),
        'the reviews endpoint answered successfully. It is retired upstream and left out of the '
        + 'README on that basis, so document it again or drop this test.'
    );
    // The transport worked but the tool failed: the record has to say so, or the summary would
    // count a retired-tool error as a green call.
    assert.equal(record.method, 'tools/call');
    assert.equal(record.toolName, 'hasdata_amazon_reviews_getProductReviews');
    assert.equal(record.status, 200);
    assert.equal(record.ok, false);
});

// The prompts and resources section of the README is generated from the live server, and the
// server changes it without a commit here: Indeed gained two parameter resources overnight on
// 2026-10-08 and the table fell behind the same day. These checks need no API key, because
// prompts/list and resources/list are served without one, so they run on a fork too.
// README prompts and resources section
const README_MD = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

async function anonymousRpc(method) {
    const id = nextAnonymousId++;
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    assert.equal(res.status, 200, `${method} returned ${res.status}`);
    return parseRpc(await res.text(), id).result;
}
let nextAnonymousId = 1;

// The section writes "ships one prompt" for a single entry and "ships 7 prompts" otherwise.
const statedCount = (verb) => {
    const m = README_MD.match(new RegExp(verb + String.raw`\s+(one|\d+)\s`));
    if (!m) return null;
    return m[1] === 'one' ? 1 : Number(m[1]);
};

test('the README states how many prompts the server serves', async () => {
    const { prompts } = await anonymousRpc('prompts/list');
    const stated = statedCount('ships');
    if (!prompts.length) {
        assert.equal(stated, null, 'the README claims prompts the server does not serve');
        return;
    }
    assert.ok(stated !== null, 'the server serves prompts and the README does not say how many');
    assert.equal(stated, prompts.length, `the README says ${stated} prompts, the server serves ${prompts.length}`);
});

test('the README states how many resources the server serves', async () => {
    const { resources } = await anonymousRpc('resources/list');
    const stated = statedCount('exposes');
    if (!resources.length) {
        assert.equal(stated, null, 'the README claims resources the server does not serve');
        return;
    }
    assert.ok(stated !== null, 'the server serves resources and the README does not say how many');
    assert.equal(stated, resources.length, `the README says ${stated} resources, the server serves ${resources.length}`);
});

test('every parameter with a fixed list is named in the README', async () => {
    const { resources } = await anonymousRpc('resources/list');
    const missing = resources
        .map((r) => (r.uri || '').split('/').pop())
        .filter((p) => p && !README_MD.includes(`\`${p}\``));
    assert.deepEqual(missing, [], `parameters the README does not name: ${missing.join(', ')}`);
});
