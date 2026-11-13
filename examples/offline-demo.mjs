// Fully offline demonstration of the resumable review-collection job.
//
// EVERYTHING here talks to a scripted in-process fake of the HasData MCP endpoint. No
// request leaves the machine and no HASDATA_API_KEY is needed; the fake's data is made up.
// Do not mistake the reviews printed below for real HasData responses.
//
// Run:  node examples/offline-demo.mjs [output-dir]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewJob, resumeReviewJob, JobStatus, MissingApiKeyError } from '../lib/review-job.mjs';
import { saveJob, loadJob } from '../lib/job-store.mjs';
import { RemoteCallError } from '../lib/jsonrpc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(here, 'output'));
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const banner = (title) => {
    process.stdout.write(`\n=== ${title} ===\n`);
};

// ---------------------------------------------------------------------------
// Scripted fake transport. It stands in for callToolWithRetry against the real
// https://mcp.hasdata.com/mcp?apis=yelp endpoint. Cursors are opaque strings
// handed out by one page and expected back verbatim on the next.
// ---------------------------------------------------------------------------
function makeFakeTransport() {
    const calls = [];
    // page 1 fails its first two attempts with a retryable concurrency_limit, then works;
    // pages 2 and 3 succeed; page 3 ends the feed.
    const scripted = [
        { reviews: makeReviews(1, 20), hasNextPage: true, token: 'cursor-page-2' },
        { reviews: makeReviews(21, 40), hasNextPage: true, token: 'cursor-page-3' },
        { reviews: makeReviews(41, 45), hasNextPage: false, token: null },
    ];
    let firstPageAttempts = 0;

    function makeReviews(from, to) {
        const rows = [];
        for (let i = from; i <= to; i += 1) {
            rows.push({
                id: `mock-review-${i}`,
                rating: (i % 5) + 1,
                date: '2026-11-01T00:00:00-05:00',
                user: { name: `Mock User ${i}`, userId: `mock-user-${i}` },
                comment: { text: `Synthetic review number ${i} from the offline fake.`, language: 'en' },
            });
        }
        return rows;
    }

    // Single-attempt fake, standing in for callTool against the real endpoint. It throws
    // a retryable RemoteCallError on the first two attempts at page 1, then succeeds.
    async function singleAttempt(options) {
        const token = options.args.nextPageToken ?? null;
        calls.push({ token, args: options.args });

        if (token === null) {
            firstPageAttempts += 1;
            if (firstPageAttempts <= 2) {
                throw new RemoteCallError('429 concurrency_limit (scripted)', {
                    retryable: true,
                    reason: 'concurrency_limit',
                    statusCode: 429,
                });
            }
            return { payload: envelope(scripted[0]), attempts: firstPageAttempts };
        }

        // The fake verifies the engine forwards cursors verbatim: page N is served only
        // when presented with the exact token page N-1 handed out.
        const pageIndex = token === 'cursor-page-2' ? 1 : token === 'cursor-page-3' ? 2 : -1;
        if (pageIndex < 0 || pageIndex >= scripted.length) {
            throw new RemoteCallError(`fake got an unknown cursor: ${token}`, { reason: 'bad_cursor' });
        }
        return { payload: envelope(scripted[pageIndex]), attempts: 1 };
    }

    // Mirror the real callToolWithRetry contract: retry only retryable errors, honouring
    // the injected sleep so backoff stays observable.
    async function fakeCallToolWithRetry(options, retryOptions = {}, sleep) {
        const { maxAttempts = 4, baseDelayMs = 1 } = retryOptions;
        const doSleep = sleep ?? (() => {});
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const result = await singleAttempt(options);
                return { payload: result.payload, attempts: attempt };
            } catch (error) {
                lastError = error;
                if (!error.retryable || attempt === maxAttempts) {
                    error.attempts = attempt;
                    throw error;
                }
                await doSleep(baseDelayMs * 2 ** (attempt - 1), attempt);
            }
        }
        throw lastError;
    }

    function envelope(page) {
        return {
            searchInformation: { businessName: 'Mock Coffee (not a real business)' },
            pagination: { hasNextPage: page.hasNextPage, nextPageToken: page.token },
            reviews: page.reviews,
        };
    }

    return { fakeCallToolWithRetry, calls };
}

// A no-op sleep keeps the demo instant even though the real backoff would wait seconds.
const instantSleep = async () => {};

// Give a single-attempt fake the same (options, retryOptions, sleep) retry envelope as the
// real callToolWithRetry, so the demo's page-attempt counts reflect genuine retries.
function withScriptedRetry(singleAttempt) {
    return async function scriptedRetry(options, retryOptions = {}, sleep = instantSleep) {
        const { maxAttempts = 4, baseDelayMs = 1 } = retryOptions;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const result = await singleAttempt(options);
                return { payload: result.payload, attempts: attempt };
            } catch (error) {
                lastError = error;
                if (!error.retryable || attempt === maxAttempts) {
                    error.attempts = attempt;
                    throw error;
                }
                await sleep(baseDelayMs * 2 ** (attempt - 1), attempt);
            }
        }
        throw lastError;
    };
}

// ---------------------------------------------------------------------------
// 1. Normal paging with a rate-limit recovery on page 1.
// ---------------------------------------------------------------------------
banner('1. full run: page 1 is rate-limited twice, then paging completes (MOCK data)');
const fake = makeFakeTransport();
const job = await runReviewJob({
    placeId: 'mock-coffee',
    sortBy: 'dateDesc',
    rating: '1,2',
    languageCode: 'en',
    num: 49,
    apiKey: 'offline-fake-key',
    callToolWithRetry: fake.fakeCallToolWithRetry,
    sleep: instantSleep,
    retry: { maxAttempts: 4, baseDelayMs: 1 },
    onPage: async (snapshot) => saveJob(path.join(outDir, 'job.json'), snapshot),
});

console.log(`status            : ${job.status}`);
console.log(`pages             : ${job.pages.map((p) => `p${p.page}=${p.status}/attempts=${p.attempts}`).join(', ')}`);
console.log(`collected reviews : ${job.totalCollected}`);
console.log(`cursors used      : ${job.pages.map((p) => p.requestedCursor ?? '<first page>').join(' -> ')}`);
console.log(`cursors returned  : ${job.pages.map((p) => p.nextCursor ?? '<end>').join(' -> ')}`);
console.log(`remote requests   : ${fake.calls.length} (includes the two retried rate-limit attempts)`);
console.log(`saved job file    : ${path.join(outDir, 'job.json')}`);

// ---------------------------------------------------------------------------
// 2. Resume: build a partial job that died on page 2 after page 1 succeeded,
//    then continue it. Page 1 must never be re-requested.
// ---------------------------------------------------------------------------
banner('2. resume: a partial job with one failed page continues from its saved cursor (MOCK)');
const partial = await runReviewJob({
    placeId: 'mock-coffee',
    apiKey: 'offline-fake-key',
    num: 49,
    // A transport that serves page 1, then fails page 2 on every attempt with a
    // retryable network error until the retry budget is exhausted.
    callToolWithRetry: withScriptedRetry(async (options) => {
        if (options.args.nextPageToken) {
            throw new RemoteCallError('scripted network outage', { retryable: true, reason: 'network_error' });
        }
        return {
            payload: {
                pagination: { hasNextPage: true, nextPageToken: 'cursor-page-2' },
                reviews: makeSinglePage(1, 20),
            },
            attempts: 1,
        };
    }),
    sleep: instantSleep,
    retry: { maxAttempts: 3, baseDelayMs: 1 },
});
console.log(`partial status    : ${partial.status}`);
console.log(`partial pages     : ${partial.pages.length} (last one failed), reviews kept: ${partial.totalCollected}`);
console.log(`failure reason    : ${partial.error.reason}`);

const resumedFake = makeFakeTransport();
const resumed = await resumeReviewJob({
    job: partial,
    apiKey: 'offline-fake-key',
    callToolWithRetry: resumedFake.fakeCallToolWithRetry,
    sleep: instantSleep,
    retry: { maxAttempts: 4, baseDelayMs: 1 },
    onPage: async (snapshot) => saveJob(path.join(outDir, 'job-resumed.json'), snapshot),
});
const requestedCursors = resumedFake.calls.map((c) => c.token ?? '<first page>');
console.log(`resumed status    : ${resumed.status}`);
console.log(`requests made     : ${resumedFake.calls.length}, cursors requested: ${requestedCursors.join(', ')}`);
console.log(`page 1 re-requested: ${requestedCursors.includes('<first page>')} (must be false)`);
console.log(`total reviews now : ${resumed.totalCollected}`);
await saveJob(path.join(outDir, 'job-resumed.json'), resumed);

// Round-trip through disk to prove the resume format is serialisable.
const reloaded = await loadJob(path.join(outDir, 'job-resumed.json'));
console.log(`reloaded from disk: status=${reloaded.status}, reviews=${reloaded.reviews.length}`);

// ---------------------------------------------------------------------------
// 3. Empty review feed: a successful first page with an empty array ends the job.
// ---------------------------------------------------------------------------
banner('3. empty feed: zero reviews completes the job without asking for another page (MOCK)');
const emptyJob = await runReviewJob({
    placeId: 'mock-empty-place',
    apiKey: 'offline-fake-key',
    callToolWithRetry: async () => ({
        payload: { pagination: { hasNextPage: false, nextPageToken: null }, reviews: [] },
        attempts: 1,
    }),
});
console.log(`status            : ${emptyJob.status}`);
console.log(`pages / reviews   : ${emptyJob.pages.length} / ${emptyJob.totalCollected}`);

// ---------------------------------------------------------------------------
// 4. Missing key: must throw locally before any transport is invoked.
// ---------------------------------------------------------------------------
banner('4. missing HASDATA_API_KEY: fails before any network request');
let networkTouched = false;
try {
    await runReviewJob({
        placeId: 'mock-coffee',
        apiKey: undefined,
        callToolWithRetry: async () => {
            networkTouched = true;
            throw new Error('transport must never be reached');
        },
    });
    console.log('ERROR: expected MissingApiKeyError');
    process.exitCode = 1;
} catch (error) {
    console.log(`error type        : ${error.name}`);
    console.log(`message           : ${error.message}`);
    console.log(`network touched   : ${networkTouched} (must be false)`);
    if (!(error instanceof MissingApiKeyError) || networkTouched) process.exitCode = 1;
}

banner('done — all data above came from the in-process fake, not from HasData');
if (job.status !== JobStatus.COMPLETED || resumed.status !== JobStatus.COMPLETED || emptyJob.status !== JobStatus.COMPLETED) {
    process.exitCode = 1;
}

function makeSinglePage(from, to) {
    const rows = [];
    for (let i = from; i <= to; i += 1) {
        rows.push({ id: `mock-review-${i}`, comment: { text: `synthetic ${i}` } });
    }
    return rows;
}
