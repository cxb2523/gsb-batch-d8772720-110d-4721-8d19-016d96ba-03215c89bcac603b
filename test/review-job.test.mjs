// State-machine tests for lib/review-job.mjs.
//
// The transport is replaced by an in-process scripted double, so every test runs fully
// offline. The fake only accepts cursors it previously issued: if the engine ever recomputed
// or invented a cursor, these tests fail. No data here comes from a real HasData call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReviewJob, resumeReviewJob, JobStatus, MissingApiKeyError, MAX_PAGE_SIZE } from '../lib/review-job.mjs';
import { RemoteCallError } from '../lib/jsonrpc.mjs';

const review = (i) => ({
    id: `mock-r${i}`,
    rating: (i % 5) + 1,
    comment: { text: `synthetic review ${i}`, language: 'en' },
    user: { name: `Mock ${i}` },
});
const reviews = (from, to) => {
    const rows = [];
    for (let i = from; i <= to; i += 1) rows.push(review(i));
    return rows;
};
const page = (rows, hasNextPage, token) => ({
    pagination: { hasNextPage, nextPageToken: hasNextPage ? token : null },
    reviews: rows,
});

// A scripted transport matching callToolWithRetry's (options, retryOptions, sleep) shape.
// `pages` are served in order; `failures` is a map from 0-based page index to an error
// thrown that many times before the page succeeds.
function scriptedTransport(pages, failures = {}) {
    const requests = [];
    const issued = new Map(); // token -> page index
    const attemptsPerPage = new Map();

    async function transport(options) {
        const token = options.args.nextPageToken ?? null;
        requests.push({ token, args: options.args });

        let index;
        if (token === null) {
            index = 0;
        } else {
            assert.ok(issued.has(token), `engine sent an unknown or invented cursor: ${token}`);
            index = issued.get(token);
        }

        const attempt = (attemptsPerPage.get(index) ?? 0) + 1;
        attemptsPerPage.set(index, attempt);
        if (attempt <= (failures[index] ?? 0)) {
            throw new RemoteCallError('scripted concurrency_limit', {
                retryable: true,
                reason: 'concurrency_limit',
                statusCode: 429,
            });
        }

        const current = pages[index];
        if (current.pagination.hasNextPage) issued.set(current.pagination.nextPageToken, index + 1);
        return { payload: current, attempts: attemptsPerPage.get(index) };
    }

    return { transport, requests, issued };
}

const noSleep = async () => {};
const retry = { maxAttempts: 5, baseDelayMs: 1 };

// Wrap a single-attempt scripted transport with the same retry/sleep contract as the real
// callToolWithRetry, so engine tests exercise retry-and-recover behaviour end to end.
function withRetry(singleAttempt) {
    return async function retryingTransport(options, retryOptions = {}, sleepOverride = noSleep) {
        const { maxAttempts = 5, baseDelayMs = 1 } = retryOptions;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                return await singleAttempt(options);
            } catch (error) {
                lastError = error;
                if (!error.retryable || attempt === maxAttempts) {
                    error.attempts = attempt;
                    throw error;
                }
                await sleepOverride(baseDelayMs * 2 ** (attempt - 1), attempt);
            }
        }
        throw lastError;
    };
}

const runOpts = (extra = {}) => ({
    placeId: 'mock-business',
    apiKey: 'test-key',
    sleep: noSleep,
    retry,
    ...extra,
});

test('normal paging walks every page, records page stats and forwards cursors verbatim', async () => {
    const pages = [
        page(reviews(1, 49), true, 'tok-2'),
        page(reviews(50, 98), true, 'tok-3'),
        page(reviews(99, 120), false, null),
    ];
    const fake = scriptedTransport(pages);
    const snapshots = [];

    const job = await runReviewJob(runOpts({ callToolWithRetry: withRetry(fake.transport), onPage: (j) => snapshots.push(structuredClone(j)) }));

    assert.equal(job.status, JobStatus.COMPLETED);
    assert.equal(job.pages.length, 3);
    assert.equal(job.totalCollected, 120);
    assert.deepEqual(
        job.pages.map((p) => [p.page, p.pageCount, p.cumulativeCount, p.hasNextPage]),
        [
            [1, 49, 49, true],
            [2, 49, 98, true],
            [3, 22, 120, false],
        ]
    );
    // Cursors: requested as received, returned as issued, never derived.
    assert.deepEqual(
        job.pages.map((p) => p.requestedCursor),
        [null, 'tok-2', 'tok-3']
    );
    assert.deepEqual(
        job.pages.map((p) => p.nextCursor),
        ['tok-2', 'tok-3', null]
    );
    assert.deepEqual(
        fake.requests.map((r) => r.token),
        [null, 'tok-2', 'tok-3']
    );
    // The callback fires once per page, always with the freshest cumulative count.
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[2].totalCollected, 120);
});

test('request parameters are forwarded and num defaults to 49', async () => {
    const fake = scriptedTransport([page([], false, null)]);
    await runReviewJob(
        runOpts({
            callToolWithRetry: withRetry(fake.transport),
            domain: 'fr.yelp.ca',
            sortBy: 'dateAsc',
            rating: '1,2',
            languageCode: 'fr',
            num: 10,
        })
    );
    assert.deepEqual(fake.requests[0].args, {
        placeId: 'mock-business',
        num: 10,
        domain: 'fr.yelp.ca',
        sortBy: 'dateAsc',
        rating: '1,2',
        languageCode: 'fr',
    });

    const defaulted = scriptedTransport([page([], false, null)]);
    await runReviewJob(runOpts({ callToolWithRetry: withRetry(defaulted.transport) }));
    assert.equal(defaulted.requests[0].args.num, MAX_PAGE_SIZE);
    assert.equal(defaulted.requests[0].args.nextPageToken, undefined);
});

test('rate limiting on page 1 is retried with backoff and the page still succeeds', async () => {
    const pages = [page(reviews(1, 5), true, 'tok-2'), page(reviews(6, 7), false, null)];
    const fake = scriptedTransport(pages, { 0: 2 }); // first two attempts on page 1 fail
    const sleeps = [];

    const job = await runReviewJob(
        runOpts({
            callToolWithRetry: withRetry(fake.transport),
            sleep: async (ms) => sleeps.push(ms),
            retry: { maxAttempts: 4, baseDelayMs: 100 },
        })
    );

    assert.equal(job.status, JobStatus.COMPLETED);
    assert.equal(job.pages[0].attempts, 3);
    assert.equal(job.pages[0].status, 'success');
    assert.deepEqual(sleeps, [100, 200]); // increasing waits
    assert.equal(job.totalCollected, 7);
});

test('exhausted retries on a later page leave the job partial and keep every collected review', async () => {
    const pages = [page(reviews(1, 49), true, 'tok-2'), page(reviews(50, 60), false, null)];
    // Page 2 always fails; with maxAttempts 3 the budget runs out.
    const fake = scriptedTransport(pages, { 1: Number.POSITIVE_INFINITY });

    const job = await runReviewJob(
        runOpts({ callToolWithRetry: withRetry(fake.transport), retry: { maxAttempts: 3, baseDelayMs: 1 } })
    );

    assert.equal(job.status, JobStatus.PARTIAL);
    assert.equal(job.totalCollected, 49, 'reviews from the successful page must survive');
    assert.equal(job.reviews.length, 49);
    const failed = job.pages[1];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 3);
    assert.equal(failed.error.reason, 'concurrency_limit');
    assert.equal(failed.requestedCursor, 'tok-2');
    assert.equal(job.error.reason, 'concurrency_limit');
});

test('failure on the first page marks the job failed with an empty review list', async () => {
    const fake = scriptedTransport([page(reviews(1, 5), false, null)], { 0: Number.POSITIVE_INFINITY });
    const job = await runReviewJob(
        runOpts({ callToolWithRetry: withRetry(fake.transport), retry: { maxAttempts: 2, baseDelayMs: 1 } })
    );

    assert.equal(job.status, JobStatus.FAILED);
    assert.equal(job.totalCollected, 0);
    assert.deepEqual(job.reviews, []);
    assert.equal(job.pages[0].status, 'failed');
    assert.equal(job.pages[0].error.reason, 'concurrency_limit');
});

test('resume reuses the saved cursor and never re-requests a successful page', async () => {
    // First run: page 1 succeeds, page 2 dies for good.
    const firstFake = scriptedTransport(
        [page(reviews(1, 49), true, 'tok-2'), page(reviews(50, 90), false, null)],
        { 1: Number.POSITIVE_INFINITY }
    );
    const partial = await runReviewJob(
        runOpts({ callToolWithRetry: firstFake.transport, retry: { maxAttempts: 2, baseDelayMs: 1 } })
    );
    assert.equal(partial.status, JobStatus.PARTIAL);

    // Resume with a healthy transport that only knows the saved cursor: if the engine
    // re-requested page 1 (null cursor) the fake would fail with "unknown cursor".
    const resumePages = [page(reviews(50, 90), false, null)];
    const resumeFake = scriptedTransport(resumePages);
    // Map the saved token directly onto the single resume page.
    resumeFake.issued.set('tok-2', 0);
    const resumed = await resumeReviewJob(
        runOpts({ job: partial, callToolWithRetry: withRetry(resumeFake.transport) })
    );

    assert.equal(resumed.status, JobStatus.COMPLETED);
    assert.equal(resumeFake.requests.length, 1, 'only the missing page is requested');
    assert.equal(resumeFake.requests[0].token, 'tok-2', 'saved cursor reused verbatim');
    assert.equal(resumed.totalCollected, 90);
    assert.equal(resumed.pages.length, 2);
    assert.deepEqual(resumed.pages.map((p) => p.status), ['success', 'success']);
    // The earlier failure remains auditable rather than being silently overwritten.
    assert.equal(resumed.failureHistory.length, 1);
    assert.equal(resumed.failureHistory[0].page, 2);
});

test('resuming an already completed job performs no requests', async () => {
    const done = await runReviewJob(
        runOpts({ callToolWithRetry: withRetry(scriptedTransport([page([], false, null)]).transport) })
    );
    let touched = false;
    const again = await resumeReviewJob(
        runOpts({
            job: done,
            callToolWithRetry: async () => {
                touched = true;
                throw new Error('must not be called');
            },
        })
    );
    assert.equal(touched, false);
    assert.equal(again.status, JobStatus.COMPLETED);
});

test('an empty review list on the first page completes the job with zero reviews and one page', async () => {
    const fake = scriptedTransport([page([], false, null)]);
    const job = await runReviewJob(runOpts({ callToolWithRetry: withRetry(fake.transport) }));
    assert.equal(job.status, JobStatus.COMPLETED);
    assert.equal(job.totalCollected, 0);
    assert.equal(job.pages.length, 1);
    assert.equal(job.pages[0].pageCount, 0);
    assert.equal(job.pages[0].hasNextPage, false);
    assert.equal(fake.requests.length, 1);
});

test('hasNextPage=false ends the feed even when a token is present', async () => {
    const fake = scriptedTransport([page(reviews(1, 3), false, 'stale-token')]);
    const job = await runReviewJob(runOpts({ callToolWithRetry: withRetry(fake.transport) }));
    assert.equal(job.status, JobStatus.COMPLETED);
    assert.equal(job.pages[0].nextCursor, null, 'token must not be stored when hasNextPage is false');
    assert.equal(fake.requests.length, 1);
});

test('a missing API key throws locally and the transport is never invoked', async () => {
    let touched = false;
    await assert.rejects(
        () =>
            runReviewJob(
                runOpts({
                    apiKey: undefined,
                    callToolWithRetry: async () => {
                        touched = true;
                        throw new Error('no network expected');
                    },
                })
            ),
        (error) => error instanceof MissingApiKeyError
    );
    assert.equal(touched, false);

    // The same guarantee holds for resume.
    const saved = { status: JobStatus.PARTIAL, params: {}, pages: [], reviews: [], nextCursor: 'tok' };
    await assert.rejects(
        () => resumeReviewJob(runOpts({ job: saved, apiKey: undefined })),
        (error) => error instanceof MissingApiKeyError
    );
});

test('invalid placeId and out-of-range num are rejected before any request', async () => {
    let touched = false;
    await assert.rejects(
        () => runReviewJob(runOpts({ placeId: '  ', callToolWithRetry: async () => ((touched = true), {}) })),
        /placeId/
    );
    await assert.rejects(
        () => runReviewJob(runOpts({ num: 50, callToolWithRetry: async () => ((touched = true), {}) })),
        /num/
    );
    await assert.rejects(
        () => runReviewJob(runOpts({ sortBy: 'bogus', callToolWithRetry: async () => ((touched = true), {}) })),
        /sortBy/
    );
    assert.equal(touched, false);
});

test('maxPages caps the walk and leaves the cursor ready for a later resume', async () => {
    const pages = [
        page(reviews(1, 49), true, 'tok-2'),
        page(reviews(50, 98), true, 'tok-3'),
        page(reviews(99, 110), false, null),
    ];
    const fake = scriptedTransport(pages);
    const job = await runReviewJob(runOpts({ callToolWithRetry: withRetry(fake.transport), maxPages: 1 }));
    assert.equal(job.pages.length, 1);
    assert.equal(job.nextCursor, 'tok-2');
    assert.equal(job.status, JobStatus.PARTIAL, 'capped while pages remain, so the job stays resumable');
    assert.ok(job.warnings.some((w) => w.includes('maxPages')));

    const resumeFake = scriptedTransport(pages);
    // The resume run starts at page 2, so pre-seed the cursor the first run saved.
    resumeFake.issued.set('tok-2', 1);
    const continued = await resumeReviewJob(runOpts({ job, callToolWithRetry: withRetry(resumeFake.transport) }));
    assert.equal(continued.status, JobStatus.COMPLETED);
    assert.equal(continued.totalCollected, 110);
    assert.deepEqual(resumeFake.requests.map((r) => r.token), ['tok-2', 'tok-3']);
});

test('a non-retryable 401 fails the page immediately without spending the retry budget', async () => {
    let calls = 0;
    const transport = async () => {
        calls += 1;
        throw new RemoteCallError('unauthorized', { retryable: false, reason: 'http_401', statusCode: 401 });
    };
    const job = await runReviewJob(
        runOpts({ callToolWithRetry: transport, retry: { maxAttempts: 5, baseDelayMs: 1 } })
    );
    assert.equal(calls, 1);
    assert.equal(job.status, JobStatus.FAILED);
    assert.equal(job.pages[0].attempts, 1);
    assert.equal(job.pages[0].error.reason, 'http_401');
});
