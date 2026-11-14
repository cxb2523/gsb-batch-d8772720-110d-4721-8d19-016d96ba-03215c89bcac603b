// Offline tests for the catalogue scan engine.
//
// Every network reply is scripted through a fake fetcher and backoff sleeps are replaced with
// no-ops, so the five failure/stop paths are deterministic and cost no API credits. The live tool
// contract tests in tools.test.mjs still cover the real server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    scanStore,
    scanCollection,
    summarizePrices,
    toNumber,
    isSoldOut,
    isRateLimitedReply,
    OUTCOME,
    PAGE_LIMIT,
    MAX_ATTEMPTS,
    DEFAULT_BACKOFF_MS,
} from '../lib/catalog-scan.mjs';
import { renderMarkdownReport } from '../lib/report.mjs';

const STORE_URL = 'https://shop.example.com';
const noSleep = async () => {};

// ----- response builders -------------------------------------------------

function variant(overrides = {}) {
    return {
        id: Math.floor(Math.random() * 1_000_000),
        title: 'Default Title',
        price: '10.00',
        compare_at_price: null,
        available: true,
        ...overrides,
    };
}

function product(handle, overrides = {}) {
    return {
        id: handle,
        title: `Product ${handle}`,
        handle,
        vendor: 'Acme',
        product_type: 'Widget',
        tags: [],
        variants: [variant()],
        ...overrides,
    };
}

function fullPage(handles) {
    assert.equal(handles.length, PAGE_LIMIT, 'a full page fixture must contain exactly 250 products');
    return ok(handles.map((handle) => product(handle)));
}

function ok(products) {
    return { status: 200, payload: { products }, raw: '' };
}

const EMPTY_PAGE = { status: 200, payload: { products: [] }, raw: '' };
const ERROR_BODY = { status: 200, payload: { error: 'shopify store not found' }, raw: '' };
const RATE_LIMIT_429 = { status: 429, payload: null, raw: 'Too Many Requests' };
const RATE_LIMIT_BODY = {
    status: 200,
    payload: { error: { code: 'concurrency_limit', message: 'plan concurrency is 1' } },
    raw: '{"error":{"code":"concurrency_limit"}}',
};

// A fetcher whose routes are keyed by collection handle; each route is a list of per-page replies.
// Records every call so tests can assert the exact (page, attempt) sequence and backoff schedule.
function makeFetcher(routes) {
    const calls = [];
    const sleepLog = [];
    const sleepImpl = async (ms) => {
        sleepLog.push(ms);
    };

    const fetcher = async (args) => {
        const route = routes[args.collection];
        assert.ok(route, `unexpected collection fetched: ${args.collection}`);
        const pageEntry = route[args.page];
        assert.ok(pageEntry, `unexpected page fetched: ${args.collection}#${args.page}`);
        pageEntry.attempts = (pageEntry.attempts ?? 0) + 1;
        calls.push({ ...args, attempt: pageEntry.attempts });
        const reply = pageEntry.queue[pageEntry.attempts - 1];
        assert.ok(reply, `route for ${args.collection}#${args.page} ran out of scripted replies`);
        return reply;
    };

    return { fetcher, calls, sleepImpl, sleepLog };
}

function pageRoute(queue) {
    // A single-page route: every scripted reply belongs to page 1.
    return { 1: { queue: Array.isArray(queue) ? queue : [queue] } };
}

// ----- unit checks for the shared helpers --------------------------------

test('toNumber parses Shopify string prices and rejects junk', () => {
    assert.equal(toNumber('16.00'), 16);
    assert.equal(toNumber('9.5'), 9.5);
    assert.equal(toNumber(12.5), 12.5);
    assert.equal(toNumber(null), null);
    assert.equal(toNumber(''), null);
    assert.equal(toNumber('not-a-price'), null);
});

test('summarizePrices uses numeric ordering, ignores null compare_at_price for discounts', () => {
    const products = [
        product('a', {
            variants: [
                variant({ price: '9.00' }), // no compare price: not a discount
                variant({ price: '100.00', compare_at_price: '120.00' }), // discounted
                variant({ price: '5.00', compare_at_price: '5.00' }), // equal: not a discount
            ],
        }),
        product('b', {
            variants: [variant({ price: '16.00', compare_at_price: null })],
        }),
    ];
    const stats = summarizePrices(products);
    assert.equal(stats.price_min, 5);
    assert.equal(stats.price_max, 100);
    assert.equal(stats.priced_variants, 4);
    assert.equal(stats.discounted_variants, 1);
});

test('isSoldOut requires every variant unavailable and at least one variant', () => {
    assert.equal(isSoldOut(product('x', { variants: [] })), false);
    assert.equal(isSoldOut(product('x', { variants: [variant({ available: true })] })), false);
    assert.equal(
        isSoldOut(
            product('x', {
                variants: [variant({ available: false }), variant({ available: true })],
            })
        ),
        false
    );
    assert.equal(
        isSoldOut(
            product('x', {
                variants: [variant({ available: false }), variant({ available: false })],
            })
        ),
        true
    );
});

test('isRateLimitedReply recognises 429 and concurrency_limit in any layer', () => {
    assert.equal(isRateLimitedReply(RATE_LIMIT_429), true);
    assert.equal(isRateLimitedReply(RATE_LIMIT_BODY), true);
    assert.equal(isRateLimitedReply({ status: 200, raw: 'concurrency_limit hit', payload: null }), true);
    assert.equal(isRateLimitedReply(ERROR_BODY), false);
    assert.equal(isRateLimitedReply(ok([])), false);
});

test('backoff schedule is strictly increasing and bounded by five attempts', () => {
    assert.equal(DEFAULT_BACKOFF_MS.length, MAX_ATTEMPTS - 1);
    for (let i = 1; i < DEFAULT_BACKOFF_MS.length; i += 1) {
        assert.ok(DEFAULT_BACKOFF_MS[i] > DEFAULT_BACKOFF_MS[i - 1]);
    }
});

// ----- path 1: normal multi-page scan stops on the short page ------------

test('path 1: full pages followed by a short page stop, with cumulative and price stats', async () => {
    const handlesFull = Array.from({ length: PAGE_LIMIT }, (_, i) => `p-${i}`);
    const routes = {
        shoes: {
            1: { queue: [fullPage(handlesFull)] },
            2: {
                queue: [
                    ok([
                        product('cheap', { variants: [variant({ price: '3.50', compare_at_price: '7.00' })] }),
                        product('pricey', {
                            variants: [variant({ price: '42.00' })],
                        }),
                        product('gone', {
                            variants: [variant({ available: false }), variant({ available: false })],
                        }),
                    ]),
                ],
            },
        },
    };
    const harness = makeFetcher(routes);

    const record = await scanStore({
        url: STORE_URL,
        collections: ['shoes'],
        fetcher: harness.fetcher,
        sleepImpl: harness.sleepImpl,
        now: () => '2026-11-14T00:00:00.000Z',
    });

    assert.equal(record.limit, 250);
    assert.equal(record.totals.collections, 1);
    assert.equal(record.totals.pages, 2);
    assert.equal(record.totals.products, 253);
    assert.equal(record.totals.successful_pages, 2);
    assert.equal(record.totals.empty_pages, 0);
    assert.equal(record.collections_needing_resume.length, 0);

    const [page1, page2] = record.page_outcomes;
    assert.deepEqual(
        {
            collection: page1.collection,
            page: page1.page,
            outcome: page1.outcome,
            products_on_page: page1.products_on_page,
            cumulative_products: page1.cumulative_products,
        },
        { collection: 'shoes', page: 1, outcome: OUTCOME.SUCCESS, products_on_page: 250, cumulative_products: 250 }
    );
    assert.deepEqual(
        {
            collection: page2.collection,
            page: page2.page,
            outcome: page2.outcome,
            products_on_page: page2.products_on_page,
            cumulative_products: page2.cumulative_products,
        },
        { collection: 'shoes', page: 2, outcome: OUTCOME.SUCCESS, products_on_page: 3, cumulative_products: 253 }
    );

    const summary = record.collections[0];
    assert.equal(summary.status, 'complete');
    assert.equal(summary.pages, 2);
    assert.equal(summary.product_count, 253);
    assert.equal(summary.price_min, 3.5);
    assert.equal(summary.price_max, 42);
    assert.equal(summary.discounted_variants, 1);
    assert.equal(summary.needs_resume, false);
    assert.equal(summary.failure_reason, null);

    assert.deepEqual(
        record.sold_out_products.map((p) => p.handle),
        ['gone']
    );
    // No retries happened, so no backoff was spent.
    assert.deepEqual(harness.sleepLog, []);
    assert.deepEqual(harness.calls.map((c) => c.page), [1, 2]);

    // The rendered report must carry every outcome label and the resume statement.
    const markdown = renderMarkdownReport(record);
    assert.match(markdown, /成功/);
    assert.match(markdown, /No collections need a resume run/);
});

// ----- path 2: empty page ------------------------------------------------

test('path 2: an empty first page is an empty-page outcome, complete with zero products', async () => {
    const harness = makeFetcher({ emptyish: pageRoute(EMPTY_PAGE) });

    const record = await scanStore({
        url: STORE_URL,
        collections: ['emptyish'],
        fetcher: harness.fetcher,
        sleepImpl: harness.sleepImpl,
        now: () => '2026-11-14T00:00:00.000Z',
    });

    assert.equal(record.page_outcomes.length, 1);
    assert.deepEqual(
        {
            collection: record.page_outcomes[0].collection,
            page: record.page_outcomes[0].page,
            outcome: record.page_outcomes[0].outcome,
            products_on_page: record.page_outcomes[0].products_on_page,
            cumulative_products: record.page_outcomes[0].cumulative_products,
        },
        { collection: 'emptyish', page: 1, outcome: OUTCOME.EMPTY, products_on_page: 0, cumulative_products: 0 }
    );
    assert.equal(record.totals.products, 0);
    assert.equal(record.totals.empty_pages, 1);
    const summary = record.collections[0];
    assert.equal(summary.status, 'complete');
    assert.equal(summary.needs_resume, false);
    assert.equal(summary.pages, 1);
});

// ----- path 3: error string instead of a products array -----------------

test('path 3: an error body is a non-Shopify failure and points at myshopify.com', async () => {
    const harness = makeFetcher({ headless: pageRoute(ERROR_BODY) });

    const record = await scanStore({
        url: 'https://headless-store.example.com',
        collections: ['headless'],
        fetcher: harness.fetcher,
        sleepImpl: harness.sleepImpl,
        now: () => '2026-11-14T00:00:00.000Z',
    });

    assert.equal(record.page_outcomes.length, 1);
    const row = record.page_outcomes[0];
    assert.equal(row.outcome, OUTCOME.NON_SHOPIFY);
    assert.equal(row.products_on_page, 0);
    assert.equal(row.cumulative_products, 0);
    assert.match(row.error, /shopify store not found/);

    const summary = record.collections[0];
    assert.equal(summary.status, 'failed');
    assert.equal(summary.product_count, 0);
    assert.equal(summary.needs_resume, true);
    assert.equal(summary.resume_from_page, 1);
    assert.match(summary.failure_reason, /non-Shopify response/);
    assert.match(summary.resume_hint, /https:\/\/<shop>\.myshopify\.com/);

    assert.equal(record.collections_needing_resume.length, 1);
    assert.equal(record.collections_needing_resume[0].collection, 'headless');
    assert.match(renderMarkdownReport(record), /非 Shopify/);
});

// ----- path 4: consecutive rate limits, then success --------------------

test('path 4: 429s and a concurrency_limit body are retried with increasing backoff then succeed', async () => {
    const harness = makeFetcher({
        shoes: pageRoute([RATE_LIMIT_429, RATE_LIMIT_BODY, RATE_LIMIT_429, ok([product('only-one')])]),
    });

    const record = await scanStore({
        url: STORE_URL,
        collections: ['shoes'],
        fetcher: harness.fetcher,
        sleepImpl: harness.sleepImpl,
        now: () => '2026-11-14T00:00:00.000Z',
    });

    // Four scripted replies: attempts 1-3 rate limited, attempt 4 succeeds.
    assert.equal(harness.calls.length, 4);
    assert.deepEqual(harness.calls.map((c) => c.attempt), [1, 2, 3, 4]);
    assert.deepEqual(harness.sleepLog, [1_000, 2_000, 4_000]);
    assert.equal(record.totals.rate_limited_pages, 0);
    assert.equal(record.totals.successful_pages, 1);

    const row = record.page_outcomes[0];
    assert.equal(row.outcome, OUTCOME.SUCCESS);
    assert.equal(row.attempts, 4);
    assert.equal(row.products_on_page, 1);
    assert.equal(row.cumulative_products, 1);
    assert.equal(record.collections[0].status, 'complete');
});

// ----- path 5: retries exhausted ----------------------------------------

test('path 5: five rate-limited replies exhaust retries, fail the collection but keep scanning', async () => {
    const harness = makeFetcher({
        blocked: pageRoute([RATE_LIMIT_429, RATE_LIMIT_BODY, RATE_LIMIT_429, RATE_LIMIT_BODY, RATE_LIMIT_429]),
        healthy: pageRoute(ok([product('survivor')])),
    });

    const record = await scanStore({
        url: STORE_URL,
        // Explicit order matters: the second collection must still run after the first fails.
        collections: ['blocked', 'healthy'],
        fetcher: harness.fetcher,
        sleepImpl: harness.sleepImpl,
        now: () => '2026-11-14T00:00:00.000Z',
    });

    assert.equal(harness.calls.filter((c) => c.collection === 'blocked').length, MAX_ATTEMPTS);
    assert.deepEqual(harness.sleepLog, [1_000, 2_000, 4_000, 8_000]);

    const blockedRow = record.page_outcomes.find((r) => r.collection === 'blocked');
    assert.equal(blockedRow.outcome, OUTCOME.RATE_LIMITED);
    assert.equal(blockedRow.page, 1);
    assert.equal(blockedRow.attempts, 5);
    assert.equal(blockedRow.products_on_page, 0);
    assert.equal(blockedRow.cumulative_products, 0);
    assert.match(blockedRow.failure_reason, /rate limited after 5 attempts/);

    const blocked = record.collections.find((s) => s.collection === 'blocked');
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.needs_resume, true);
    assert.equal(blocked.resume_from_page, 1);
    assert.match(blocked.resume_hint, /resume collection blocked from page 1/);

    const healthy = record.collections.find((s) => s.collection === 'healthy');
    assert.equal(healthy.status, 'complete');
    assert.equal(healthy.product_count, 1);

    assert.equal(record.totals.collections_failed, 1);
    assert.equal(record.totals.collections_completed, 1);
    assert.equal(record.totals.rate_limited_pages, 1);
    assert.equal(record.totals.products, 1);
    assert.deepEqual(
        record.collections_needing_resume.map((r) => r.collection),
        ['blocked']
    );
    assert.match(renderMarkdownReport(record), /限流失败/);
});

// ----- resumability ------------------------------------------------------

test('a resume run keeps successful pages and continues at the rate-limited page', async () => {
    // First run: page 1 full, page 2 rate limited to exhaustion.
    const firstHarness = makeFetcher({
        shoes: {
            1: { queue: [fullPage(Array.from({ length: PAGE_LIMIT }, (_, i) => `old-${i}`))] },
            2: { queue: [RATE_LIMIT_429, RATE_LIMIT_429, RATE_LIMIT_429, RATE_LIMIT_429, RATE_LIMIT_429] },
        },
    });
    const first = await scanStore({
        url: STORE_URL,
        collections: ['shoes'],
        fetcher: firstHarness.fetcher,
        sleepImpl: firstHarness.sleepImpl,
        now: () => '2026-11-14T00:00:00.000Z',
    });
    assert.equal(first.collections[0].status, 'failed');
    assert.equal(first.collections[0].resume_from_page, 2);

    // Resume run: page 2 now returns a short page; page 1 must not be fetched again.
    const secondHarness = makeFetcher({
        shoes: {
            2: { queue: [ok([product('new-one'), product('new-two')])] },
        },
    });
    const resumed = await scanStore({
        url: STORE_URL,
        collections: ['shoes'],
        fetcher: secondHarness.fetcher,
        sleepImpl: secondHarness.sleepImpl,
        priorRecord: first,
        now: () => '2026-11-14T01:00:00.000Z',
    });

    assert.deepEqual(secondHarness.calls.map((c) => c.page), [2]);
    assert.equal(resumed.page_outcomes.length, 2);
    assert.deepEqual(
        resumed.page_outcomes.map((r) => [r.page, r.outcome, r.products_on_page, r.cumulative_products]),
        [
            [1, OUTCOME.SUCCESS, 250, 250],
            [2, OUTCOME.SUCCESS, 2, 252],
        ]
    );
    assert.equal(resumed.collections[0].status, 'complete');
    assert.equal(resumed.collections[0].product_count, 252);
    assert.equal(resumed.collections_needing_resume.length, 0);
    // The original start timestamp is preserved so the record describes one logical run.
    assert.equal(resumed.started_at, first.started_at);
});

test('a completed collection in the checkpoint is skipped entirely on resume', async () => {
    const harness = makeFetcher({ later: pageRoute(ok([product('later-product')])) });
    const prior = {
        schema_version: 1,
        url: STORE_URL,
        started_at: '2026-11-14T00:00:00.000Z',
        collections: [
            {
                collection: 'done',
                status: 'complete',
                pages: 1,
                successful_pages: 1,
                product_count: 1,
                price_min: 10,
                price_max: 10,
                discounted_variants: 0,
                outcome_counts: { success: 1, empty: 0, non_shopify: 0, rate_limited: 0 },
                failure_reason: null,
                needs_resume: false,
                resume_from_page: null,
                resume_hint: null,
            },
        ],
        page_outcomes: [
            {
                collection: 'done',
                page: 1,
                outcome: OUTCOME.SUCCESS,
                products_on_page: 1,
                cumulative_products: 1,
                attempts: 1,
                price_min: 10,
                price_max: 10,
                discounted_variants: 0,
            },
        ],
        sold_out_products: [],
    };

    const record = await scanStore({
        url: STORE_URL,
        collections: ['done', 'later'],
        fetcher: harness.fetcher,
        sleepImpl: harness.sleepImpl,
        priorRecord: prior,
        now: () => '2026-11-14T01:00:00.000Z',
    });

    assert.deepEqual(harness.calls.map((c) => c.collection), ['later']);
    assert.equal(record.totals.products, 2);
    assert.equal(record.totals.collections_completed, 2);
});

test('a non-Shopify failure resumes at page 1, and a different URL starts the scan fresh', async () => {
    const failed = await scanStore({
        url: 'https://headless.example.com',
        collections: ['coll'],
        fetcher: makeFetcher({ coll: pageRoute(ERROR_BODY) }).fetcher,
        sleepImpl: noSleep,
        now: () => '2026-11-14T00:00:00.000Z',
    });
    assert.equal(failed.collections[0].resume_from_page, 1);

    // Same URL: prior failure is retried from page 1 even though the checkpoint holds a failed row.
    const sameUrlHarness = makeFetcher({ coll: pageRoute(ok([product('recovered')])) });
    const sameUrlResume = await scanStore({
        url: 'https://headless.example.com',
        collections: ['coll'],
        fetcher: sameUrlHarness.fetcher,
        sleepImpl: sameUrlHarness.sleepImpl,
        priorRecord: failed,
        now: () => '2026-11-14T01:00:00.000Z',
    });
    assert.deepEqual(sameUrlHarness.calls.map((c) => c.page), [1]);
    assert.equal(sameUrlResume.collections[0].status, 'complete');
    assert.equal(sameUrlResume.page_outcomes.length, 1);
    assert.equal(sameUrlResume.page_outcomes[0].outcome, OUTCOME.SUCCESS);
    // The failed non_shopify row is replaced, not carried alongside the new success row.
    assert.equal(sameUrlResume.totals.non_shopify_pages, 0);

    // Different URL (e.g. switching to myshopify.com): nothing from the old record is reused.
    const freshHarness = makeFetcher({ coll: pageRoute(ok([product('fresh')])) });
    const fresh = await scanStore({
        url: 'https://headless.myshopify.com',
        collections: ['coll'],
        fetcher: freshHarness.fetcher,
        sleepImpl: freshHarness.sleepImpl,
        priorRecord: failed,
        now: () => '2026-11-14T02:00:00.000Z',
    });
    assert.equal(fresh.started_at, '2026-11-14T02:00:00.000Z');
    assert.equal(fresh.url, 'https://headless.myshopify.com');
    assert.equal(fresh.page_outcomes.length, 1);
    assert.equal(fresh.collections[0].status, 'complete');
});

// ----- scanCollection direct contract -----------------------------------

test('page records always carry the five required audit fields', async () => {
    const harness = makeFetcher({
        mixed: pageRoute([RATE_LIMIT_429, ERROR_BODY]),
    });
    const { pageRecords } = await scanCollection('mixed', harness.fetcher, { sleepImpl: harness.sleepImpl });

    // First attempt rate limited (retried), second attempt non-Shopify -> one non_shopify row.
    assert.equal(pageRecords.length, 1);
    const row = pageRecords[0];
    for (const field of ['collection', 'page', 'outcome', 'products_on_page', 'cumulative_products']) {
        assert.ok(Object.hasOwn(row, field), `page record is missing ${field}`);
    }
    assert.equal(row.collection, 'mixed');
    assert.equal(row.page, 1);
    assert.equal(row.outcome, OUTCOME.NON_SHOPIFY);
});
