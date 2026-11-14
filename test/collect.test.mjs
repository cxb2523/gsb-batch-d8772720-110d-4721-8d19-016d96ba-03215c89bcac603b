// Offline tests for the resumable page collector.
//
// Every response here is a hand-built JSON-RPC `tools/call` message, fed to the
// collector through a fake `callTool`. Nothing in this file touches the network,
// so it spends no credits and runs without HASDATA_API_KEY.
//
// Run: node --test test/collect.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectListings,
    collectListingsFromApi,
    classifyPayload,
    hasUsablePrice,
    extractToolPayload,
    isRateLimited,
    payloadSignalsRateLimit,
    LISTINGS_TOOL,
    PAGE_OUTCOMES,
    STOP_REASONS,
} from '../lib/collect.mjs';
import { createHttpToolCaller, parseRpcBody } from '../lib/mcp-rpc.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MARKET_KEYWORD = '78741';
const FOR_SALE = 'forSale';
const FOR_RENT = 'forRent';

function listing(id, price) {
    const item = {
        id,
        mlsId: `mls-${id}`,
        url: `https://www.redfin.com/home/${id}`,
        homeType: 'House',
        status: 'FOR_SALE',
        beds: 3,
        baths: 2,
        area: 1600,
        addressRaw: `${id} Test St, Austin, TX 78741`,
    };
    if (price !== undefined) item.price = price;
    return item;
}

function rental(id, price) {
    return {
        id: String(id),
        propertyName: `Building ${id}`,
        status: 'FOR_RENT',
        availableUnits: 4,
        price,
        beds: { min: 1, max: 2 },
        baths: { min: 1, max: 2 },
        area: { min: 474, max: 976 },
    };
}

/** A market page as the tool returns it, wrapped in the JSON-RPC content envelope. */
function marketRpc({ id = 1, currentPage, nextPage, properties }) {
    const pagination = { currentPage, nextPage, otherPages: {} };
    return {
        jsonrpc: '2.0',
        id,
        result: {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        searchInformation: { totalResults: 95 },
                        properties,
                        pagination,
                    }),
                },
            ],
        },
    };
}

/** A single-property hit: no properties array anywhere in the payload. */
function singleRpc({ id = 1, property }) {
    return {
        jsonrpc: '2.0',
        id,
        result: {
            content: [{ type: 'text', text: JSON.stringify({ property }) }],
        },
    };
}

function rateLimitRpc({ id = 1 } = {}) {
    return {
        jsonrpc: '2.0',
        id,
        result: {
            content: [
                { type: 'text', text: JSON.stringify({ code: 'concurrency_limit', message: 'Too many concurrent requests' }) },
            ],
        },
    };
}

/** A JSON-RPC error response. */
function rpcError({ id = 1, message = 'boom' } = {}) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message } };
}

/** The error the HTTP transport throws on a 429. */
function http429() {
    const error = new Error('MCP endpoint returned HTTP 429');
    error.status = 429;
    error.body = '{"code":"concurrency_limit"}';
    return error;
}

/**
 * Fake caller: pops one scripted response per call and records the arguments.
 * A scripted entry may be a function, which receives the call arguments.
 */
function makeCaller(script) {
    const calls = [];
    let index = 0;
    const callTool = async (name, args) => {
        calls.push({ name, args: { ...args } });
        if (index >= script.length) throw new Error(`no scripted response for call ${index + 1}`);
        const entry = script[index++];
        const value = typeof entry === 'function' ? entry(args) : entry;
        if (value instanceof Error) throw value;
        return value;
    };
    return { callTool, calls };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// Market walk across pages
// ---------------------------------------------------------------------------

test('market multi-page success follows pagination and merges listings', async () => {
    const page1 = [listing(1, 500000), listing(2, 450000)];
    const page2 = [listing(3, 610000), listing(4, 720000)];
    const page3 = [listing(5, 390000)];

    // Page 2 holds fewer than 40 rows but still has a next page: the walk must
    // follow pagination.nextPage, not a fixed page size.
    const { callTool, calls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: page1 }),
        marketRpc({ currentPage: 2, nextPage: 3, properties: page2 }),
        marketRpc({ currentPage: 3, nextPage: null, properties: page3 }),
    ]);

    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        sleep: noSleep,
    });

    assert.equal(result.pages.length, 3);
    assert.deepEqual(result.pages.map((p) => p.page), [1, 2, 3]);
    assert.deepEqual(result.pages.map((p) => p.outcome), ['success', 'success', 'success']);
    assert.deepEqual(result.pages.map((p) => p.itemCount), [2, 2, 1]);
    assert.deepEqual(result.pages.map((p) => p.nextPage), [2, 3, null]);

    assert.equal(result.listings.length, 5);
    assert.deepEqual(result.listings.map((l) => l.id), [1, 2, 3, 4, 5]);
    assert.equal(result.dropped, 0);
    assert.equal(result.singleHit, false);
    assert.equal(result.done, true);
    assert.equal(result.stoppedReason, STOP_REASONS.END);
    assert.equal(result.nextPage, null);
    assert.equal(result.pagesFetched, 3);

    // Every call used the right tool and asked for the page the walk requested.
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.name), [LISTINGS_TOOL, LISTINGS_TOOL, LISTINGS_TOOL]);
    assert.deepEqual(calls.map((c) => c.args.page), [1, 2, 3]);
    assert.equal(calls[0].args.keyword, MARKET_KEYWORD);
    assert.equal(calls[0].args.type, FOR_SALE);
});

test('maxPages stops the walk and leaves the result resumable', async () => {
    const { callTool, calls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 500000)] }),
        marketRpc({ currentPage: 2, nextPage: 3, properties: [listing(2, 400000)] }),
    ]);

    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        maxPages: 2,
        sleep: noSleep,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.stoppedReason, STOP_REASONS.MAX_PAGES);
    assert.equal(result.done, false);
    assert.equal(result.nextPage, 3);
    assert.equal(result.listings.length, 2);
});

// ---------------------------------------------------------------------------
// Single-property hit
// ---------------------------------------------------------------------------

test('an address hit is a single success page, not an empty page', async () => {
    const property = listing(9001, 675000);
    property.addressRaw = '1721 Deerfield Dr, Austin, TX 78741';
    const { callTool, calls } = makeCaller([singleRpc({ property })]);

    const result = await collectListings({
        keyword: '1721 Deerfield Dr, Austin, TX 78741',
        type: FOR_SALE,
        callTool,
        sleep: noSleep,
    });

    assert.equal(calls.length, 1, 'a single hit must not trigger a second request');
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.SUCCESS);
    assert.equal(result.pages[0].shape, 'single');
    assert.equal(result.pages[0].itemCount, 1);
    assert.notEqual(result.pages[0].outcome, PAGE_OUTCOMES.EMPTY);
    assert.equal(result.singleHit, true);
    assert.equal(result.done, true);
    assert.equal(result.stoppedReason, STOP_REASONS.SINGLE);
    assert.equal(result.nextPage, null);
    assert.deepEqual(result.listings.map((l) => l.id), [9001]);
});

test('a single hit with no usable price is reported as dropped', async () => {
    const { callTool } = makeCaller([singleRpc({ property: listing(9002, undefined) })]);
    const result = await collectListings({
        keyword: 'Some Building',
        type: FOR_RENT,
        callTool,
        sleep: noSleep,
    });
    assert.equal(result.singleHit, true);
    assert.equal(result.listings.length, 0);
    assert.equal(result.dropped, 1);
    assert.equal(result.pages[0].dropped, 1);
});

// ---------------------------------------------------------------------------
// forRent range shape
// ---------------------------------------------------------------------------

test('forRent range fields are preserved verbatim, never averaged', async () => {
    const page1 = [rental(101, { min: 745, max: 1300 }), rental(102, { min: 900, max: 2100 })];
    const page2 = [rental(103, { min: 1150, max: 1150 })];

    const { callTool } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: page1 }),
        marketRpc({ currentPage: 2, nextPage: null, properties: page2 }),
    ]);

    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_RENT,
        callTool,
        sleep: noSleep,
    });

    assert.equal(result.listings.length, 3);
    assert.deepEqual(result.listings[0].price, { min: 745, max: 1300 });
    assert.deepEqual(result.listings[1].price, { min: 900, max: 2100 });
    assert.deepEqual(result.listings[2].price, { min: 1150, max: 1150 });
    // The whole object survives, not just price.
    assert.deepEqual(result.listings[0].beds, { min: 1, max: 2 });
    assert.deepEqual(result.listings[0].baths, { min: 1, max: 2 });
    assert.deepEqual(result.listings[0].area, { min: 474, max: 976 });
    assert.equal(result.listings[0].propertyName, 'Building 101');
    assert.equal(result.dropped, 0);
    // No scalar was invented: averaging {745,1300} would give 1022.5.
    assert.equal(typeof result.listings[0].price, 'object');
});

test('a listing repeated on a later page is merged once and counted as a duplicate', async () => {
    const { callTool } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 500000), listing(2, 450000)] }),
        marketRpc({ currentPage: 2, nextPage: null, properties: [listing(2, 450000), listing(3, 550000)] }),
    ]);
    const result = await collectListings({ keyword: MARKET_KEYWORD, type: FOR_SALE, callTool, sleep: noSleep });
    assert.deepEqual(result.listings.map((l) => l.id), [1, 2, 3]);
    assert.equal(result.duplicatesRemoved, 1);
    assert.equal(result.pages[1].itemCount, 2, 'the page still reports what it returned');
});

test('a rental whose range has no numeric bound is dropped', async () => {
    const page = [
        rental(201, { min: 800, max: 1400 }),
        rental(202, { min: null, max: null }),
        rental(203, {}),
    ];
    const { callTool } = makeCaller([marketRpc({ currentPage: 1, nextPage: null, properties: page })]);
    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_RENT,
        callTool,
        sleep: noSleep,
    });
    assert.equal(result.listings.length, 1);
    assert.equal(result.dropped, 2);
    assert.equal(result.pages[0].itemCount, 3);
    assert.equal(result.pages[0].kept, 1);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('429s are retried with increasing waits, then the page is marked rate_limited and the walk stops', async () => {
    const waits = [];
    const sleep = async (ms) => waits.push(ms);
    const { callTool, calls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 500000)] }),
        http429(),
        http429(),
        http429(),
        http429(),
        // If the collector wrongly kept going, this page-2 response would be used.
        marketRpc({ currentPage: 2, nextPage: null, properties: [listing(2, 400000)] }),
    ]);

    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        retry: { retries: 3, baseDelayMs: 100, factor: 2 },
        sleep,
    });

    // Page 1 succeeded, page 2 spent four attempts (1 + 3 retries).
    assert.equal(calls.length, 1 + 4);
    assert.deepEqual(calls.slice(1).map((c) => c.args.page), [2, 2, 2, 2]);

    assert.deepEqual(waits, [100, 200, 400], 'the waits must increase');

    const page2 = result.pages.find((p) => p.page === 2);
    assert.equal(page2.outcome, PAGE_OUTCOMES.RATE_LIMITED);
    assert.equal(page2.attempts, 4);
    assert.deepEqual(page2.waitsMs, [100, 200, 400]);
    assert.match(page2.error, /429|concurrency_limit/i);

    // Already collected pages are kept, and nothing after the failed page is fetched.
    assert.deepEqual(result.listings.map((l) => l.id), [1]);
    assert.equal(result.stoppedReason, STOP_REASONS.RATE_LIMITED);
    assert.equal(result.done, false);
    assert.equal(result.nextPage, 2);
    assert.deepEqual(result.pages.map((p) => p.page), [1, 2]);
});

test('a retried page that succeeds after a 429 is recorded as a success', async () => {
    const waits = [];
    const sleep = async (ms) => waits.push(ms);
    const { callTool, calls } = makeCaller([
        http429(),
        marketRpc({ currentPage: 1, nextPage: null, properties: [listing(1, 600000)] }),
    ]);

    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        retry: { retries: 2, baseDelayMs: 50 },
        sleep,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [50]);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.SUCCESS);
    assert.equal(result.pages[0].attempts, 2);
    assert.equal(result.listings.length, 1);
});

test('a 200 response carrying concurrency_limit is treated as a rate limit', async () => {
    const { callTool, calls } = makeCaller([rateLimitRpc(), rateLimitRpc()]);

    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        retry: { retries: 1, baseDelayMs: 10 },
        sleep: noSleep,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.RATE_LIMITED);
    assert.equal(result.stoppedReason, STOP_REASONS.RATE_LIMITED);
    assert.equal(result.done, false);
});

test('an isError result carrying concurrency_limit is retried, not treated as a broken call', async () => {
    const isErrorLimit = {
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: '429 concurrency_limit exceeded' }] },
    };
    const { callTool, calls } = makeCaller([
        isErrorLimit,
        marketRpc({ currentPage: 1, nextPage: null, properties: [listing(1, 1)] }),
    ]);
    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        retry: { retries: 1, baseDelayMs: 10 },
        sleep: noSleep,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.SUCCESS);
});

test('a non-rate-limit failure is an error page, not a rate limit', async () => {
    const { callTool, calls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 100000)] }),
        rpcError({ message: 'internal failure' }),
    ]);
    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        retry: { retries: 3 },
        sleep: noSleep,
    });
    assert.equal(calls.length, 2, 'a JSON-RPC error is not retried');
    assert.equal(result.pages[1].outcome, PAGE_OUTCOMES.ERROR);
    assert.equal(result.stoppedReason, STOP_REASONS.ERROR);
    assert.equal(result.listings.length, 1);
});

// ---------------------------------------------------------------------------
// Price filtering
// ---------------------------------------------------------------------------

test('listings without a price are dropped and counted, the rest are kept in order', async () => {
    const page1 = [
        listing(1, 500000),
        listing(2, undefined), // no price field
        listing(3, null), // explicitly null
        listing(4, 'not a number'),
        listing(5, 0), // zero is a usable number, not a missing price
    ];
    const page2 = [listing(6, 300000), listing(7, undefined)];

    const { callTool } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: page1 }),
        marketRpc({ currentPage: 2, nextPage: null, properties: page2 }),
    ]);

    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        sleep: noSleep,
    });

    assert.deepEqual(result.listings.map((l) => l.id), [1, 5, 6]);
    assert.equal(result.dropped, 4, 'four rows had no usable price');
    assert.equal(result.pages[0].dropped, 3);
    assert.equal(result.pages[0].kept, 2);
    assert.equal(result.pages[0].itemCount, 5);
    assert.equal(result.pagesFetched, 2);
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test('resuming from a previous result skips every successful page', async () => {
    const { callTool: firstCall, calls: firstCalls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 500000)] }),
        http429(),
        http429(),
        http429(),
    ]);

    const first = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool: firstCall,
        retry: { retries: 2, baseDelayMs: 10 },
        sleep: noSleep,
    });

    assert.equal(first.stoppedReason, STOP_REASONS.RATE_LIMITED);
    assert.deepEqual(first.pages.map((p) => p.page), [1, 2]);
    assert.equal(first.pages[0].outcome, PAGE_OUTCOMES.SUCCESS);
    assert.equal(first.pages[1].outcome, PAGE_OUTCOMES.RATE_LIMITED);
    assert.equal(first.nextPage, 2);

    // Resume: page 2 is retried, then page 3, then page 4 (fewer than 40 rows), then done.
    const { callTool: secondCall, calls: secondCalls } = makeCaller([
        marketRpc({ currentPage: 2, nextPage: 3, properties: [listing(2, 400000), listing(3, 450000)] }),
        marketRpc({ currentPage: 3, nextPage: 4, properties: [listing(4, 550000)] }),
        marketRpc({ currentPage: 4, nextPage: null, properties: [listing(5, 700000)] }),
    ]);

    const second = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool: secondCall,
        previous: first,
        sleep: noSleep,
    });

    // Page 1 was never requested again; the failed page 2 was, and paging continued.
    assert.deepEqual(secondCalls.map((c) => c.args.page), [2, 3, 4]);
    assert.ok(secondCalls.every((c) => c.args.page !== 1), 'no successful page is re-requested');

    // Everything from the first run survives, and the stale failure record is
    // replaced by the successful retry.
    assert.deepEqual(second.listings.map((l) => l.id), [1, 2, 3, 4, 5]);
    assert.equal(second.dropped, 0);
    assert.deepEqual(second.pages.map((p) => p.page), [1, 2, 3, 4]);
    assert.deepEqual(second.pages.map((p) => p.outcome), ['success', 'success', 'success', 'success']);
    assert.equal(second.done, true);
    assert.equal(second.stoppedReason, STOP_REASONS.END);
    assert.equal(second.resumed, true);
});

test('resuming after a page-budget stop continues from nextPage', async () => {
    const { callTool } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 500000)] }),
    ]);
    const first = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        maxPages: 1,
        sleep: noSleep,
    });
    assert.equal(first.nextPage, 2);
    assert.equal(first.done, false);

    const { callTool: secondCall, calls: secondCalls } = makeCaller([
        marketRpc({ currentPage: 2, nextPage: 3, properties: [listing(2, 450000)] }),
        marketRpc({ currentPage: 3, nextPage: null, properties: [listing(3, 420000)] }),
    ]);
    const second = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool: secondCall,
        previous: first,
        sleep: noSleep,
    });

    assert.deepEqual(secondCalls.map((c) => c.args.page), [2, 3]);
    assert.deepEqual(second.listings.map((l) => l.id), [1, 2, 3]);
    assert.equal(second.done, true);
    assert.deepEqual(second.pages.map((p) => p.page), [1, 2, 3]);
});

test('resuming a finished result makes no requests', async () => {
    const { callTool } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: null, properties: [listing(1, 500000)] }),
    ]);
    const first = await collectListings({ keyword: MARKET_KEYWORD, type: FOR_SALE, callTool, sleep: noSleep });
    assert.equal(first.done, true);

    const { callTool: secondCall, calls: secondCalls } = makeCaller([]);
    const second = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool: secondCall,
        previous: first,
        sleep: noSleep,
    });

    assert.equal(secondCalls.length, 0);
    assert.deepEqual(second.listings.map((l) => l.id), [1]);
    assert.equal(second.stoppedReason, STOP_REASONS.ALREADY_COMPLETE);
    assert.equal(second.done, true);
});

test('resuming a single hit makes no requests', async () => {
    const { callTool } = makeCaller([singleRpc({ property: listing(1, 600000) })]);
    const first = await collectListings({ keyword: 'addr', type: FOR_SALE, callTool, sleep: noSleep });
    const { callTool: secondCall, calls: secondCalls } = makeCaller([]);
    const second = await collectListings({
        keyword: 'addr',
        type: FOR_SALE,
        callTool: secondCall,
        previous: first,
        sleep: noSleep,
    });
    assert.equal(secondCalls.length, 0);
    assert.equal(second.singleHit, true);
    assert.equal(second.stoppedReason, STOP_REASONS.ALREADY_COMPLETE);
});

test('a resumed run keeps the original drop count and adds only new drops', async () => {
    const { callTool } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 500000), listing(2, undefined)] }),
    ]);
    const first = await collectListings({ keyword: MARKET_KEYWORD, type: FOR_SALE, callTool, sleep: noSleep });
    assert.equal(first.dropped, 1);

    const { callTool: secondCall } = makeCaller([
        marketRpc({ currentPage: 2, nextPage: null, properties: [listing(3, 550000), listing(4, undefined)] }),
    ]);
    const second = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool: secondCall,
        previous: first,
        sleep: noSleep,
    });
    assert.equal(second.dropped, 2, 'the drop count spans both runs');
    assert.deepEqual(second.listings.map((l) => l.id), [1, 3]);
});

test('resuming with a mismatched keyword or type is rejected', async () => {
    const { callTool } = makeCaller([marketRpc({ currentPage: 1, nextPage: null, properties: [] })]);
    const first = await collectListings({ keyword: '78741', type: FOR_SALE, callTool, sleep: noSleep });

    await assert.rejects(
        collectListings({ keyword: '78702', type: FOR_SALE, callTool: () => {}, previous: first }),
        /keyword/
    );
    await assert.rejects(
        collectListings({ keyword: '78741', type: FOR_RENT, callTool: () => {}, previous: first }),
        /type/
    );
});

test('a page that repeats an already-fetched page stops instead of looping', async () => {
    const { callTool, calls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 1, properties: [listing(1, 500000)] }),
    ]);
    const result = await collectListings({ keyword: MARKET_KEYWORD, type: FOR_SALE, callTool, sleep: noSleep });
    assert.equal(calls.length, 1);
    assert.equal(result.stoppedReason, STOP_REASONS.PAGINATION_LOOP);
    assert.equal(result.done, false);
});

// ---------------------------------------------------------------------------
// Empty page
// ---------------------------------------------------------------------------

test('an empty properties array stops the walk and is not a single hit', async () => {
    const { callTool, calls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 500000)] }),
        marketRpc({ currentPage: 2, nextPage: 3, properties: [] }),
    ]);
    const result = await collectListings({ keyword: MARKET_KEYWORD, type: FOR_SALE, callTool, sleep: noSleep });
    assert.equal(calls.length, 2);
    assert.equal(result.pages[1].outcome, PAGE_OUTCOMES.EMPTY);
    assert.equal(result.pages[1].shape, 'market');
    assert.equal(result.singleHit, false);
    assert.equal(result.stoppedReason, STOP_REASONS.EMPTY);
    assert.equal(result.done, false);
    assert.equal(result.listings.length, 1);
});

// ---------------------------------------------------------------------------
// Transport / payload helpers
// ---------------------------------------------------------------------------

test('extractToolPayload reads text content, structuredContent and JSON-RPC errors', () => {
    const viaText = marketRpc({ currentPage: 1, nextPage: null, properties: [] });
    assert.deepEqual(extractToolPayload(viaText).properties, []);

    const viaStructured = { jsonrpc: '2.0', id: 2, result: { structuredContent: { properties: [listing(1, 1)] } } };
    assert.equal(extractToolPayload(viaStructured).properties.length, 1);

    assert.throws(() => extractToolPayload(rpcError()), /boom/);

    const isError = {
        jsonrpc: '2.0',
        id: 3,
        result: { isError: true, content: [{ type: 'text', text: 'upstream failed' }] },
    };
    assert.throws(() => extractToolPayload(isError), /upstream failed/);
});

test('classifyPayload branches on the presence of properties', () => {
    assert.equal(classifyPayload({ properties: [] }).shape, 'market');
    assert.equal(classifyPayload({ properties: [listing(1, 1)] }).shape, 'market');
    assert.equal(classifyPayload({ property: listing(1, 1) }).shape, 'single');
    assert.equal(classifyPayload(listing(1, 1)).shape, 'single');
});

test('isRateLimited recognises 429 and concurrency_limit, and nothing else', () => {
    assert.equal(isRateLimited(http429()), true);
    const concurrency = new Error('concurrency_limit: slow down');
    assert.equal(isRateLimited(concurrency), true);
    assert.equal(isRateLimited(Object.assign(new Error('x'), { data: { code: 'concurrency_limit' } })), true);
    assert.equal(isRateLimited(new Error('network down')), false);
    assert.equal(isRateLimited(null), false);
});

test('payloadSignalsRateLimit does not fire on a normal page', () => {
    const page = marketRpc({ currentPage: 1, nextPage: null, properties: [listing(1, 5)] }).result.content[0];
    assert.equal(payloadSignalsRateLimit(JSON.parse(page.text)), false);
    assert.equal(payloadSignalsRateLimit({ code: 'concurrency_limit' }), true);
});

test('hasUsablePrice accepts numbers, numeric strings and rental ranges', () => {
    assert.equal(hasUsablePrice({ price: 500000 }), true);
    assert.equal(hasUsablePrice({ price: '500000' }), true);
    assert.equal(hasUsablePrice({ price: 0 }), true);
    assert.equal(hasUsablePrice({ price: { min: 745, max: 1300 } }), true);
    assert.equal(hasUsablePrice({ price: { min: null, max: 1300 } }), true);
    assert.equal(hasUsablePrice({ price: { min: null, max: null } }), false);
    assert.equal(hasUsablePrice({ price: null }), false);
    assert.equal(hasUsablePrice({}), false);
});

test('parseRpcBody reads plain JSON and server-sent events', () => {
    const message = marketRpc({ id: 7, currentPage: 1, nextPage: null, properties: [] });
    assert.deepEqual(parseRpcBody(JSON.stringify(message), 7), message);

    const sse = [
        'event: message',
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
        '',
        'event: message',
        `data: ${JSON.stringify(message)}`,
        '',
    ].join('\n');
    assert.deepEqual(parseRpcBody(sse, 7), message);
});

test('a transport-level 429 (thrown Error) is retried like a payload limit', async () => {
    const waits = [];
    const sleep = async (ms) => waits.push(ms);
    const { callTool } = makeCaller([
        http429(),
        marketRpc({ currentPage: 1, nextPage: null, properties: [listing(1, 1)] }),
    ]);
    const result = await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        retry: { retries: 1, baseDelayMs: 25, factor: 1 },
        sleep,
    });
    assert.deepEqual(waits, [25]);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.SUCCESS);
});

test('input validation rejects a missing keyword, type or caller', async () => {
    await assert.rejects(collectListings({ keyword: '', type: FOR_SALE, callTool: () => {} }), /keyword/);
    await assert.rejects(collectListings({ keyword: 'x', type: '', callTool: () => {} }), /type/);
    await assert.rejects(collectListings({ keyword: 'x', type: FOR_SALE, callTool: null }), /callTool/);
    await assert.rejects(collectListings({ keyword: 'x', type: FOR_SALE, callTool: () => {}, maxPages: 0 }), /maxPages/);
});

test('extra filters are forwarded unchanged alongside keyword, type and page', async () => {
    const { callTool, calls } = makeCaller([
        marketRpc({ currentPage: 1, nextPage: null, properties: [listing(1, 1)] }),
    ]);
    await collectListings({
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        callTool,
        filters: { beds_min_: 3, price_max_: 500000 },
        sleep: noSleep,
    });
    assert.equal(calls[0].args.beds_min_, 3);
    assert.equal(calls[0].args.price_max_, 500000);
    assert.equal(calls[0].args.keyword, MARKET_KEYWORD);
    assert.equal(calls[0].args.type, FOR_SALE);
    assert.equal(calls[0].args.page, 1);
});

// ---------------------------------------------------------------------------
// HTTP transport (fake fetch: still offline)
// ---------------------------------------------------------------------------

test('createHttpToolCaller posts JSON-RPC and surfaces the HTTP status on failure', async () => {
    const requests = [];
    const replies = [
        { status: 200, body: JSON.stringify(marketRpc({ id: 1, currentPage: 1, nextPage: null, properties: [listing(1, 1)] })) },
        { status: 429, body: '{"code":"concurrency_limit"}' },
    ];
    const fetchImpl = async (url, init) => {
        requests.push({ url, init });
        const reply = replies.shift();
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            text: async () => reply.body,
        };
    };

    const callTool = createHttpToolCaller({
        apiKey: 'test-key',
        endpoint: 'https://example.invalid/mcp',
        fetchImpl,
        timeoutMs: 0,
    });

    const message = await callTool(LISTINGS_TOOL, { keyword: MARKET_KEYWORD, type: FOR_SALE, page: 1 });
    assert.equal(message.result.content[0].type, 'text');
    assert.equal(requests[0].url, 'https://example.invalid/mcp');
    assert.equal(requests[0].init.headers['x-api-key'], 'test-key');
    const sent = JSON.parse(requests[0].init.body);
    assert.equal(sent.method, 'tools/call');
    assert.equal(sent.params.name, LISTINGS_TOOL);
    assert.equal(sent.params.arguments.page, 1);

    await assert.rejects(callTool(LISTINGS_TOOL, {}), (error) => error.status === 429);
});

test('collectListingsFromApi walks the market through the HTTP caller', async () => {
    const pages = [
        marketRpc({ currentPage: 1, nextPage: 2, properties: [listing(1, 100)] }),
        marketRpc({ currentPage: 2, nextPage: null, properties: [listing(2, 200)] }),
    ];
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(pages.shift()),
    });

    const result = await collectListingsFromApi({
        apiKey: 'test-key',
        endpoint: 'https://example.invalid/mcp',
        fetchImpl,
        timeoutMs: 0,
        keyword: MARKET_KEYWORD,
        type: FOR_SALE,
        sleep: noSleep,
    });

    assert.deepEqual(result.listings.map((l) => l.id), [1, 2]);
    assert.equal(result.done, true);
});
