// End-to-end tests of the real transport + engine wiring, with fetch replaced by a
// scripted double at the network boundary. These exercise SSE parsing, retries and the job
// state machine together, still fully offline and without a real key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runReviewJob, resumeReviewJob, JobStatus } from '../lib/review-job.mjs';
import { saveJob, loadJob } from '../lib/job-store.mjs';

const sse = (payload, id) =>
    [
        'event: message',
        `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        })}`,
        '',
    ].join('\n');

const makeResponse = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
});

// Scripted fetch: page responses keyed by the nextPageToken sent in the request body.
function scriptedFetch(script, { failFirstN = 0 } = {}) {
    const calls = [];
    let firstPageFailures = 0;
    return async (url, init) => {
        const requestBody = JSON.parse(init.body);
        const token = requestBody.params.arguments.nextPageToken ?? null;
        calls.push({ url, init, token });
        assert.equal(init.headers['x-api-key'], 'integration-key');

        if (token === null && firstPageFailures < failFirstN) {
            firstPageFailures += 1;
            return makeResponse(429, 'concurrency_limit');
        }        const step = script.get(token);
        assert.ok(step, `scripted fetch received an unexpected cursor: ${token}`);
        return makeResponse(200, sse(step.payload, requestBody.id));
    };
}

const noSleep = async () => {};

test('full stack: SSE responses, verbatim cursor hand-off and rate-limit recovery', async () => {
    const script = new Map([
        [
            null,
            {
                payload: {
                    pagination: { hasNextPage: true, nextPageToken: 'real-looking-token-abc' },
                    reviews: [{ id: 'r1' }, { id: 'r2' }],
                },
            },
        ],
        [
            'real-looking-token-abc',
            {
                payload: {
                    pagination: { hasNextPage: false, nextPageToken: null },
                    reviews: [{ id: 'r3' }],
                },
            },
        ],
    ]);
    const fetchImpl = scriptedFetch(script, { failFirstN: 2 });

    const job = await runReviewJob({
        placeId: 'some-yelp-alias',
        apiKey: 'integration-key',
        fetch: fetchImpl,
        sleep: noSleep,
        retry: { maxAttempts: 4, baseDelayMs: 1 },
    });

    assert.equal(job.status, JobStatus.COMPLETED);
    assert.equal(job.totalCollected, 3);
    assert.equal(job.pages[0].attempts, 3, 'two 429s then success');
    assert.equal(job.pages[1].attempts, 1);
});

test('full stack: a partial job persisted to disk resumes through the real transport', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-job-'));
    const jobPath = path.join(dir, 'job.json');

    // Run one: page 1 works, page 2 always 429s and exhausts the retry budget.
    const firstScript = new Map([
        [null, { payload: { pagination: { hasNextPage: true, nextPageToken: 'cursor-x' }, reviews: [{ id: 'a' }] } }],
        ['cursor-x', null],
    ]);
    const firstFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const token = body.params.arguments.nextPageToken ?? null;
        if (token === 'cursor-x') return makeResponse(429, 'concurrency_limit');
        return makeResponse(200, sse(firstScript.get(null).payload, body.id));
    };

    const partial = await runReviewJob({
        placeId: 'biz',
        apiKey: 'integration-key',
        fetch: firstFetch,
        sleep: noSleep,
        retry: { maxAttempts: 2, baseDelayMs: 1 },
        onPage: async (snapshot) => saveJob(jobPath, snapshot),
    });
    assert.equal(partial.status, JobStatus.PARTIAL);
    assert.equal(partial.totalCollected, 1);

    // A separate process later: reload the JSON and continue, now with a healthy endpoint.
    const reloaded = await loadJob(jobPath);
    const secondScript = new Map([
        ['cursor-x', { payload: { pagination: { hasNextPage: false, nextPageToken: null }, reviews: [{ id: 'b' }, { id: 'c' }] } }],
    ]);
    const secondFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const token = body.params.arguments.nextPageToken ?? null;
        const step = secondScript.get(token);
        assert.ok(step, 'resume must start from the saved cursor, never from page one');
        return makeResponse(200, sse(step.payload, body.id));
    };

    const resumed = await resumeReviewJob({
        job: reloaded,
        apiKey: 'integration-key',
        fetch: secondFetch,
        sleep: noSleep,
        retry: { maxAttempts: 3, baseDelayMs: 1 },
        onPage: async (snapshot) => saveJob(jobPath, snapshot),
    });

    assert.equal(resumed.status, JobStatus.COMPLETED);
    assert.equal(resumed.totalCollected, 3);
    assert.deepEqual(resumed.reviews.map((r) => r.id), ['a', 'b', 'c']);
    const finalOnDisk = await loadJob(jobPath);
    assert.equal(finalOnDisk.status, JobStatus.COMPLETED);
    assert.equal(finalOnDisk.failureHistory.length, 1);

    await fs.rm(dir, { recursive: true, force: true });
});
