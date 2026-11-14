// Local tests for the review collection flow (lib/reviews.mjs).
//
// Everything here runs offline against self-made response samples: callTool is a fake that
// answers from canned payloads or a scripted error queue, and the sleep function is a no-op so
// backoff timing is asserted by value instead of waited out.
//
// Coverage:
//   1. unfiltered two-page paging following pagination.nextPage
//   2. filter values taken verbatim from the filters block (probe -> filtered re-request)
//   3. an empty filtered match distinguished from an exhausted / rate-limited page
//   4. HTTP 429 retried with backoff and then succeeding
//   5. retries exhausted, with the retry trail and final outcome exposed
//   6. strict M/D/YYYY date parsing, including ambiguous and invalid strings
// plus billing accounting, author stripping and the maxPages cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectReviews,
    parseReviewDate,
    resolveFilterSelectors,
    PAGE_OUTCOMES,
    STOP_REASONS,
    REVIEW_TOOL,
} from '../lib/reviews.mjs';

const noSleep = async () => {};

// A rate-limit error shaped like the one lib/mcp-client.mjs raises on HTTP 429.
function rateLimitError(retryAfterMs = null) {
    const error = new Error('HTTP 429 Too Many Requests');
    error.name = 'McpHttpError';
    error.status = 429;
    error.isRateLimited = true;
    error.retryAfterMs = retryAfterMs;
    return error;
}

function serverError() {
    const error = new Error('HTTP 500 Internal Server Error');
    error.name = 'McpHttpError';
    error.status = 500;
    error.isRateLimited = false;
    return error;
}

function review(position, overrides = {}) {
    return {
        position,
        id: `r${position}`,
        rating: 5,
        title: `Review ${position}`,
        text: `Body ${position}`,
        date: '8/1/2026',
        author: `Reviewer ${position}`,
        verifiedPurchase: true,
        helpfulVotes: 0,
        notHelpfulVotes: 0,
        badges: ['Verified Purchase'],
        ...overrides,
    };
}

// The filters block shape documented in the README, with a rating group, an aspect group, a
// condition group and the verified-purchase toggle.
function filtersBlock() {
    return [
        {
            name: 'Star rating',
            parameter: 'rating',
            values: [
                { name: '5 stars', value: '5', count: 38 },
                { name: '1 star', value: '1', count: 3 },
            ],
        },
        {
            name: 'Frequent mentions',
            parameter: 'aspectId',
            values: [
                { name: 'Battery Life', value: '6049', count: 8 },
                { name: 'Sturdiness', value: '828', count: 6 },
            ],
        },
        {
            name: 'Condition',
            parameter: 'condition',
            values: [{ name: 'New', value: 'New', count: 20 }],
        },
        {
            name: 'Verified purchases',
            parameter: 'verifiedPurchasesOnly',
            values: [{ name: 'Verified purchases only', value: 'true', count: 15 }],
        },
    ];
}

function reviewPayload({ page, reviews, nextPage = null, totalResults = null }) {
    return {
        reviewsInformation: {
            rating: 4.49,
            // Deliberately different: ratings are not reviews.
            totalRatings: 49,
            totalReviews: 21,
            recommendedPercentage: 100,
        },
        reviewResults: reviews,
        filters: filtersBlock(),
        appliedFilters: [],
        pagination: {
            currentPage: page,
            reviewsPerPage: 10,
            totalPages: 3,
            totalResults: totalResults ?? reviews.length,
            nextPage,
        },
    };
}

// Fake transport: route each call by its page argument and record the full request history.
function fakeCallTool(routes) {
    const calls = [];
    return {
        calls,
        async callTool(name, args) {
            assert.equal(name, REVIEW_TOOL);
            calls.push({ name, args });
            const route = routes.get(args.page);
            if (!route) throw new Error(`unexpected request for page ${args.page}`);
            if (route instanceof Error) throw route;
            return typeof route === 'function' ? route(args) : route;        },
    };
}

const baseOptions = {
    itemId: '18493462688',
    baseBackoffMs: 100,
    sleep: noSleep,
};

test('unfiltered happy path pages twice following pagination.nextPage, then stops', async () => {
    const page1 = reviewPayload({
        page: 1,
        reviews: Array.from({ length: 10 }, (_, i) => review(i + 1)),
        nextPage: 2,
        totalResults: 12,
    });
    const page2 = reviewPayload({
        page: 2,
        reviews: [review(11, { date: '12/31/2025' }), review(12, { date: '1/2/2026' })],
        nextPage: null,
        totalResults: 12,
    });
    const routes = new Map([
        [1, page1],
        [2, page2],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 5,
        maxRetries: 2,
    });

    assert.equal(result.stopReason, STOP_REASONS.NO_NEXT_PAGE);
    assert.equal(result.pagesCollected, 2);
    assert.equal(result.reviews.length, 12);

    // The probe is page 1 and also the first collected page in unfiltered mode.
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls[0].args, { itemId: '18493462688', page: 1 });
    assert.deepEqual(fake.calls[1].args, { itemId: '18493462688', page: 2 });
    assert.equal(result.probe.outcome, PAGE_OUTCOMES.OK);
    assert.equal(result.pages[0].page, 1);
    assert.equal(result.pages[1].page, 2);
    assert.ok(result.pages.every((page) => page.outcome === PAGE_OUTCOMES.OK));

    // Two distinct totals, kept apart.
    assert.equal(result.totalRatings, 49);
    assert.equal(result.totalReviews, 21);

    // Two successful 200s, no failures.
    assert.equal(result.requestsBilled, 2);
    assert.equal(result.requestsFailed, 0);
    assert.equal(result.totalAttempts, 2);

    // Authors are stripped by default.
    assert.ok(!('author' in result.reviews[0]));
    // Dates are parsed alongside the raw string.
    assert.equal(result.reviews[0].date, '8/1/2026');
    assert.equal(result.reviews[0].dateParsed, '2026-08-01');
    assert.equal(result.reviews[10].dateParsed, '2025-12-31');
    assert.equal(result.reviews[11].dateParsed, '2026-01-02');
});

test('filter values come from the filters block and are sent verbatim', async () => {
    const probe = reviewPayload({
        page: 1,
        reviews: [review(1)],
        nextPage: 2,
    });
    const filteredPage1 = reviewPayload({
        page: 1,
        reviews: Array.from({ length: 10 }, (_, i) => review(i + 1)),
        nextPage: 2,
        totalResults: 8,
    });
    delete filteredPage1.filters; // filtered responses do not need to repeat the block
    const filteredPage2 = reviewPayload({
        page: 2,
        reviews: [review(11)],
        nextPage: null,
        totalResults: 8,
    });

    const routes = new Map([
        [1, (args) => (args.aspectId ? filteredPage1 : probe)],
        [2, filteredPage2],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        // Name-based lookup: the caller never types an aspect id itself.
        filters: [{ parameter: 'aspectId', name: 'Battery Life' }],
        maxPages: 5,
        maxRetries: 1,
    });

    assert.equal(result.stopReason, STOP_REASONS.NO_NEXT_PAGE);
    assert.equal(result.pagesCollected, 2);

    // Call 1 is the unfiltered probe; calls 2 and 3 carry the value read out of filters.
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(fake.calls[0].args, { itemId: '18493462688', page: 1 });
    assert.equal(fake.calls[1].args.aspectId, '6049');
    assert.equal(fake.calls[1].args.page, 1);
    assert.equal(fake.calls[2].args.aspectId, '6049');
    assert.equal(fake.calls[2].args.page, 2);

    // The block survives verbatim and the applied filter records its provenance.
    assert.equal(result.filters.length, 4);
    assert.deepEqual(result.appliedFilters, [
        { parameter: 'aspectId', value: '6049', valueName: 'Battery Life', count: 8 },
    ]);

    // Probe (billed) + two filtered 200s.
    assert.equal(result.requestsBilled, 3);
    assert.equal(result.requestsFailed, 0);
});

test('value-based selectors and the verified-purchase boolean are resolved and coerced', () => {
    const resolved = resolveFilterSelectors(
        [
            { parameter: 'rating', value: '5' },
            { parameter: 'verifiedPurchasesOnly', value: 'true' },
        ],
        filtersBlock()
    );
    assert.deepEqual(resolved, [
        { parameter: 'rating', value: '5', valueName: '5 stars', count: 38 },
        {
            parameter: 'verifiedPurchasesOnly',
            value: 'true',
            valueName: 'Verified purchases only',
            count: 15,
        },
    ]);

    // Unknown parameter and unknown value are both refused, never guessed.
    assert.throws(
        () => resolveFilterSelectors([{ parameter: 'mystery', value: '1' }], filtersBlock()),
        /no filter parameter "mystery"/
    );
    assert.throws(
        () => resolveFilterSelectors([{ parameter: 'aspectId', value: '9999' }], filtersBlock()),
        /does not offer value "9999"/
    );
    assert.throws(
        () => resolveFilterSelectors([{ parameter: 'aspectId', name: 'Ghost' }], filtersBlock()),
        /does not offer a value named "Ghost"/
    );
});

test('verifiedPurchasesOnly is sent as a boolean while other values stay strings', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: null });
    const filtered = reviewPayload({ page: 1, reviews: [review(2)], nextPage: null, totalResults: 15 });
    const routes = new Map([
        [1, (args) => (Object.prototype.hasOwnProperty.call(args, 'verifiedPurchasesOnly') ? filtered : probe)],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        filters: [{ parameter: 'verifiedPurchasesOnly', value: 'true' }],
        maxPages: 3,
    });

    assert.equal(typeof fake.calls[1].args.verifiedPurchasesOnly, 'boolean');
    assert.equal(fake.calls[1].args.verifiedPurchasesOnly, true);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.OK);
});

test('an empty filtered match is empty_no_matches, billed once, and not retried or confused', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: 2 });
    const emptyMatch = {
        reviewsInformation: { totalRatings: 49, totalReviews: 21 },
        reviewResults: [],
        filters: filtersBlock(),
        appliedFilters: [{ parameter: 'rating', value: '1' }],
        pagination: { currentPage: 1, reviewsPerPage: 10, totalPages: 0, totalResults: 0, nextPage: null },
    };
    const routes = new Map([
        [1, (args) => (args.rating ? emptyMatch : probe)],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        filters: [{ parameter: 'rating', value: '1' }],
        maxPages: 3,
    });

    assert.equal(result.stopReason, STOP_REASONS.EMPTY_NO_MATCHES);
    // The empty page stays in `pages` with its distinct outcome but is not a collected review page.
    assert.equal(result.pagesCollected, 0);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.EMPTY_NO_MATCHES);
    assert.equal(result.pages[0].reviews.length, 0);
    assert.notEqual(result.pages[0].outcome, PAGE_OUTCOMES.RATE_LIMITED);

    // The probe and the successful empty response are both billed; nothing failed.
    assert.equal(result.requestsBilled, 2);
    assert.equal(result.requestsFailed, 0);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].args.rating, '1');
});

test('a 429 is retried with backoff and then succeeds, recording the retry trail', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: 2 });
    const page2Payload = reviewPayload({ page: 2, reviews: [review(2)], nextPage: null });

    let page2Attempts = 0;
    const delays = [];
    const routes = new Map([
        [1, probe],
        [
            2,
            () => {
                page2Attempts += 1;
                if (page2Attempts === 1) throw rateLimitError();
                return page2Payload;
            },
        ],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 3,
        maxRetries: 2,
        baseBackoffMs: 100,
        sleep: async (ms) => delays.push(ms),
    });

    assert.equal(page2Attempts, 2);
    assert.equal(result.stopReason, STOP_REASONS.NO_NEXT_PAGE);
    assert.equal(result.pages[1].outcome, PAGE_OUTCOMES.OK);
    assert.equal(result.pages[1].attempts, 2);
    assert.equal(result.pages[1].retries, 1);

    // First backoff = base * 2^0.
    assert.deepEqual(delays, [100]);

    // One 429 failed and was not billed; the retry and the probe were billed.
    assert.equal(result.requestsBilled, 2);
    assert.equal(result.requestsFailed, 1);
    assert.equal(result.totalAttempts, 3);

    const rateEvents = result.attempts.filter((event) => event.outcome === PAGE_OUTCOMES.RATE_LIMITED);
    assert.equal(rateEvents.length, 1);
    assert.equal(rateEvents[0].delayMs, 100);
});

test('a Retry-After header overrides the exponential backoff', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: 2 });
    let attempts = 0;
    const delays = [];
    const routes = new Map([
        [1, probe],
        [
            2,
            () => {
                attempts += 1;
                if (attempts <= 2) throw rateLimitError(2500);
                return reviewPayload({ page: 2, reviews: [review(2)], nextPage: null });
            },
        ],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 3,
        maxRetries: 3,
        baseBackoffMs: 100,
        sleep: async (ms) => delays.push(ms),
    });

    assert.equal(attempts, 3);
    assert.deepEqual(delays, [2500, 2500]);
    assert.equal(result.pages[1].outcome, PAGE_OUTCOMES.OK);
    assert.equal(result.requestsFailed, 2);
    assert.equal(result.requestsBilled, 2);
});

test('retries exhausted on a 429 end as rate_limited, distinct from empty and error', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: 2 });
    const routes = new Map([
        [1, probe],
        [2, rateLimitError()],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 3,
        maxRetries: 2, // first attempt + 2 retries = 3 attempts
    });

    assert.equal(result.stopReason, STOP_REASONS.RATE_LIMITED);
    // The probe page succeeded; only it counts as collected. The failed page 2 is still recorded.
    assert.equal(result.pagesCollected, 1);
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.OK);
    assert.equal(result.pages[1].outcome, PAGE_OUTCOMES.RATE_LIMITED);
    assert.equal(result.pages[1].page, 2);
    assert.equal(result.pages[1].attempts, 3);
    assert.equal(result.pages[1].retries, 2);
    assert.equal(result.pages[1].requestsBilled, 0);
    assert.equal(result.pages[1].requestsFailed, 3);
    assert.equal(result.pages[1].error.isRateLimited, true);

    // Only the probe was billed; all three 429 attempts failed without billing.
    assert.equal(result.requestsBilled, 1);
    assert.equal(result.requestsFailed, 3);
    assert.equal(result.totalAttempts, 4);
});

test('a 429 on the probe gives up as rate_limited with no collected pages', async () => {
    const routes = new Map([[1, rateLimitError()]]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 3,
        maxRetries: 1,
    });

    assert.equal(result.stopReason, STOP_REASONS.RATE_LIMITED);
    assert.equal(result.pagesCollected, 0);
    assert.equal(result.probe.outcome, PAGE_OUTCOMES.RATE_LIMITED);
    assert.equal(result.probe.attempts, 2);
    assert.equal(result.requestsBilled, 0);
    assert.equal(result.requestsFailed, 2);
    assert.equal(result.totalRatings, null);
    assert.equal(result.totalReviews, null);
});

test('the probe itself recovers from a 429 and still reads the filters block', async () => {
    const successfulProbe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: null });
    let probeAttempts = 0;
    const routes = new Map([
        [
            1,
            () => {
                probeAttempts += 1;
                if (probeAttempts === 1) throw rateLimitError();
                return successfulProbe;
            },
        ],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 3,
        maxRetries: 2,
    });

    assert.equal(probeAttempts, 2);
    assert.equal(result.stopReason, STOP_REASONS.NO_NEXT_PAGE);
    assert.equal(result.probe.outcome, PAGE_OUTCOMES.OK);
    assert.equal(result.probe.attempts, 2);
    assert.equal(result.probe.retries, 1);
    assert.equal(result.probe.requestsBilled, 1);
    assert.equal(result.probe.requestsFailed, 1);
    assert.equal(result.filters.length, 4);
    assert.equal(result.requestsBilled, 1);
    assert.equal(result.requestsFailed, 1);
    assert.equal(result.totalAttempts, 2);
});

test('numeric filter values in the block still match a string selector and are sent verbatim', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: null });
    // Simulate a block whose value is JSON number 5 rather than the usual string.
    probe.filters = [
        { name: 'Star rating', parameter: 'rating', values: [{ name: '5 stars', value: 5, count: 38 }] },
    ];
    const filtered = reviewPayload({ page: 1, reviews: [review(2)], nextPage: null });
    const fake = fakeCallTool(
        new Map([[1, (args) => (Object.prototype.hasOwnProperty.call(args, 'rating') ? filtered : probe)]])
    );

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        filters: [{ parameter: 'rating', value: '5' }],
        maxPages: 1,
    });

    assert.equal(result.appliedFilters[0].value, 5); // preserved verbatim, not string-cast
    assert.equal(fake.calls[1].args.rating, 5);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.OK);
});

test('a non-429 failure is terminal error and is not retried', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1)], nextPage: 2 });
    const routes = new Map([
        [1, probe],
        [2, serverError()],
    ]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 3,
        maxRetries: 3,
    });

    assert.equal(result.stopReason, STOP_REASONS.ERROR);
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.OK);
    assert.equal(result.pages[1].outcome, PAGE_OUTCOMES.ERROR);
    assert.equal(result.pages[1].attempts, 1);
    assert.equal(result.pages[1].error.status, 500);
    assert.equal(result.requestsBilled, 1);
    assert.equal(result.requestsFailed, 1);
});

test('the maxPages cap stops paging even while a next page exists', async () => {
    const probe = reviewPayload({
        page: 1,
        reviews: Array.from({ length: 10 }, (_, i) => review(i + 1)),
        nextPage: 2,
    });
    const routes = new Map([[1, probe], [2, reviewPayload({ page: 2, reviews: [review(11)], nextPage: 3 })]]);
    const fake = fakeCallTool(routes);

    const result = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 1,
    });

    assert.equal(result.stopReason, STOP_REASONS.MAX_PAGES);
    assert.equal(result.pagesCollected, 1);
    assert.equal(fake.calls.length, 1);
    assert.equal(result.pages[0].nextPage, 2);
});

test('includeAuthor keeps reviewer identity fields when explicitly requested', async () => {
    const probe = reviewPayload({ page: 1, reviews: [review(1, { reviewerName: 'Also Tagged' })], nextPage: null });
    const fake = fakeCallTool(new Map([[1, probe]]));

    const stripped = await collectReviews({ ...baseOptions, callTool: fake.callTool, maxPages: 1 });
    assert.ok(!('author' in stripped.reviews[0]));
    assert.ok(!('reviewerName' in stripped.reviews[0]));

    const kept = await collectReviews({
        ...baseOptions,
        callTool: fake.callTool,
        maxPages: 1,
        includeAuthor: true,
    });
    assert.equal(kept.reviews[0].author, 'Reviewer 1');
    assert.equal(kept.reviews[0].reviewerName, 'Also Tagged');
});

test('parseReviewDate reads M/D/YYYY strictly without guessing order', () => {
    // 8/1/2026 is August 1st, never January 8th.
    assert.equal(parseReviewDate('8/1/2026').toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(parseReviewDate('12/31/2025').toISOString(), '2025-12-31T00:00:00.000Z');
    assert.equal(parseReviewDate('2/29/2024').toISOString(), '2024-02-29T00:00:00.000Z'); // leap year
    assert.equal(parseReviewDate(' 8/1/2026 ').toISOString(), '2026-08-01T00:00:00.000Z');

    // Wrong order, wrong separators, impossible dates and non-strings are rejected, not guessed.
    assert.equal(parseReviewDate('2026-08-01'), null);
    assert.equal(parseReviewDate('13/1/2026'), null);
    assert.equal(parseReviewDate('2/29/2026'), null); // 2026 is not a leap year
    assert.equal(parseReviewDate('2/30/2026'), null);
    assert.equal(parseReviewDate('8/1/26'), null);
    assert.equal(parseReviewDate('8/1'), null);
    assert.equal(parseReviewDate('not a date'), null);
    assert.equal(parseReviewDate(null), null);
    assert.equal(parseReviewDate(undefined), null);
    assert.equal(parseReviewDate(812026), null);
});

test('an unparseable review date is flagged instead of silently guessed', async () => {
    const probe = reviewPayload({
        page: 1,
        reviews: [review(1, { date: '2026-08-01' })],
        nextPage: null,
    });
    const fake = fakeCallTool(new Map([[1, probe]]));

    const result = await collectReviews({ ...baseOptions, callTool: fake.callTool, maxPages: 1 });
    assert.equal(result.reviews[0].date, '2026-08-01');
    assert.equal(result.reviews[0].dateParsed, null);
    assert.match(result.reviews[0].dateParseError, /not M\/D\/YYYY/);
});

test('an item with no reviews at all is a successful empty feed, not empty_no_matches', async () => {
    const empty = reviewPayload({ page: 1, reviews: [], nextPage: null, totalResults: 0 });
    const fake = fakeCallTool(new Map([[1, empty]]));

    const result = await collectReviews({ ...baseOptions, callTool: fake.callTool, maxPages: 3 });

    assert.equal(result.stopReason, STOP_REASONS.NO_NEXT_PAGE);
    assert.equal(result.pagesCollected, 1);
    assert.equal(result.pages[0].outcome, PAGE_OUTCOMES.OK);
    assert.equal(result.reviews.length, 0);
    assert.equal(result.requestsBilled, 1);
    assert.equal(result.requestsFailed, 0);
});
