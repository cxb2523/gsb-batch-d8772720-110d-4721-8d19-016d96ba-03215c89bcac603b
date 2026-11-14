// Tests for the reusable batch collector in test/collect.mjs.
//
// Everything here runs against a local fake RPC: there is no network, no API key and no
// real timer. The fake is scripted per query key — each entry is a FIFO list of canned
// responses — and it records every call so the tests can assert request counts, while an
// injected sleep records the backoff sequence instead of waiting it out.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectBatch,
    queryKey,
    normalizeQueryTerm,
    OUTCOMES,
    MAX_ATTEMPTS,
} from './collect.mjs';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// scripts: Map<key, Array<response | () => response | { throw: Error }>>
// A response is anything rpcSend is expected to resolve to: { status, body }.
function makeFakeRpc(scripts) {
    const calls = [];
    const cursors = new Map();

    async function fakeRpc(query) {
        const key = queryKey(query);
        const script = scripts.get(key);
        const index = cursors.get(key) ?? 0;
        cursors.set(key, index + 1);
        calls.push({ key, query, attempt: index + 1 });

        assert.ok(script, `unexpected RPC call for ${key}`);
        assert.ok(index < script.length, `RPC called ${index + 1} times for ${key}, scripted only ${script.length}`);

        const step = script[index];
        if (step && typeof step === 'object' && 'throw' in step) throw step.throw;
        return typeof step === 'function' ? step() : step;
    }

    fakeRpc.calls = calls;
    fakeRpc.callCount = (key) => calls.filter((c) => c.key === key).length;
    return fakeRpc;
}

// Records the delay it was asked to sleep for instead of waiting.
function makeFakeSleep() {
    const waits = [];
    const sleep = async (ms, context) => {
        waits.push({ ms, attempt: context.attempt, key: context.key });
    };
    sleep.waits = waits;
    sleep.sequence = () => waits.map((w) => w.ms);
    return sleep;
}

// Deterministic increasing backoff so the expected wait sequence is an exact literal.
const backoffMs = (attempt) => attempt * 1000;

// An MCP-shaped 200: the payload lives in result.content[0].text as a JSON string whose
// parsed value carries the scraped page under .json.
function mcpResponse(jobs, { isError = false, errorText = null } = {}) {
    const text = JSON.stringify(
        isError
            ? { url: 'https://example.test', status: 'error', text: errorText, json: null }
            : {
                  url: 'https://example.test',
                  status: 'ok',
                  text: '',
                  json: { requestMetadata: { status: 'ok' }, jobs },
              }
    );
    return {
        status: 200,
        body: { jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text }] } },
    };
}

const sampleJobs = (n) =>
    Array.from({ length: n }, (_, i) => ({
        title: `Job ${i + 1}`,
        company: 'Acme',
        location: 'Remote',
        url: `https://www.indeed.com/viewjob?jk=${i + 1}`,
    }));

const q = (keyword, location) => ({ keyword, location });

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

test('a 200 with jobs is a success and costs exactly one request', async () => {
    const query = q('developer', 'New York, NY');
    const rpc = makeFakeRpc(new Map([[queryKey(query), [mcpResponse(sampleJobs(3))]]]));
    const sleep = makeFakeSleep();

    const { results, summary } = await collectBatch([query], rpc, { sleep, backoffMs });

    assert.equal(rpc.callCount(queryKey(query)), 1);
    assert.deepEqual(sleep.sequence(), []);
    assert.equal(results.length, 1);
    const record = results[0];
    assert.equal(record.outcome, OUTCOMES.SUCCESS);
    assert.equal(record.attempts, 1);
    assert.equal(record.lastStatus, 200);
    assert.equal(record.error, null);
    assert.equal(record.jobCount, 3);
    assert.deepEqual(record.query, query);
    assert.equal(summary.success, 1);
});

test('a 200 with an empty jobs array is an empty-result success, not a failure', async () => {
    const query = q('margrave', 'Nowhere, XX');
    const rpc = makeFakeRpc(new Map([[queryKey(query), [mcpResponse([])]]]));

    const { results, summary } = await collectBatch([query], rpc, {
        sleep: makeFakeSleep(),
        backoffMs,
    });

    assert.equal(rpc.callCount(queryKey(query)), 1);
    assert.equal(results[0].outcome, OUTCOMES.EMPTY);
    assert.equal(results[0].jobCount, 0);
    assert.equal(results[0].error, null);
    assert.equal(summary.empty, 1);
    assert.equal(summary.failed, 0);
    // The empty result still counts as a successfully answered query overall.
    assert.equal(summary.success + summary.empty, 1);
});

test('a 401 is recorded as an auth failure on the first attempt and never retried', async () => {
    const query = q('analyst', 'Austin, TX');
    const rpc = makeFakeRpc(
        new Map([
            [
                queryKey(query),
                [
                    { status: 401, body: 'Unauthorized: bad x-api-key' },
                    mcpResponse(sampleJobs(1)), // must never be reached
                ],
            ],
        ])
    );
    const sleep = makeFakeSleep();

    const { results, summary } = await collectBatch([query], rpc, { sleep, backoffMs });

    assert.equal(rpc.callCount(queryKey(query)), 1);
    assert.deepEqual(sleep.sequence(), []);
    assert.equal(results[0].outcome, OUTCOMES.AUTH_ERROR);
    assert.equal(results[0].attempts, 1);
    assert.equal(results[0].lastStatus, 401);
    assert.match(results[0].error, /401/);
    assert.equal(summary.failed, 1);
});

test('a 401 hidden in a 200 MCP isError payload is also an auth failure with no retry', async () => {
    const query = q('analyst', 'Boston, MA');
    const rpc = makeFakeRpc(
        new Map([
            [
                queryKey(query),
                [mcpResponse([], { isError: true, errorText: 'HasData API error: 401 Unauthorized' })],
            ],
        ])
    );

    const { results } = await collectBatch([query], rpc, { sleep: makeFakeSleep(), backoffMs });

    assert.equal(rpc.callCount(queryKey(query)), 1);
    assert.equal(results[0].outcome, OUTCOMES.AUTH_ERROR);
});

test('a 429 is retried with increasing waits and the later success is recorded once', async () => {
    const query = q('nurse', 'Chicago, IL');
    const rpc = makeFakeRpc(
        new Map([
            [
                queryKey(query),
                [
                    { status: 429, body: 'rate limited' },
                    { status: 429, body: 'still rate limited' },
                    mcpResponse(sampleJobs(2)),
                ],
            ],
        ])
    );
    const sleep = makeFakeSleep();

    const { results } = await collectBatch([query], rpc, { sleep, backoffMs });

    assert.equal(rpc.callCount(queryKey(query)), 3);
    assert.equal(results[0].outcome, OUTCOMES.SUCCESS);
    assert.equal(results[0].attempts, 3);
    assert.equal(results[0].lastStatus, 200);
    // One wait before each retry: attempt 1 -> 1s, attempt 2 -> 2s. Strictly increasing.
    assert.deepEqual(sleep.sequence(), [1000, 2000]);
});

test('concurrency_limit inside a 200 body triggers the same retry path as a real 429', async () => {
    const query = q('nurse', 'Houston, TX');
    const rpc = makeFakeRpc(
        new Map([
            [
                queryKey(query),
                [
                    {
                        status: 200,
                        body: { jsonrpc: '2.0', id: 1, error: { code: 'concurrency_limit', message: 'plan concurrency is 1' } },
                    },
                    mcpResponse(sampleJobs(1)),
                ],
            ],
        ])
    );
    const sleep = makeFakeSleep();

    const { results } = await collectBatch([query], rpc, { sleep, backoffMs });

    assert.equal(rpc.callCount(queryKey(query)), 2);
    assert.equal(results[0].outcome, OUTCOMES.SUCCESS);
    assert.deepEqual(sleep.sequence(), [1000]);
});

test('rate limiting that never clears exhausts five attempts and is classified rate_limited', async () => {
    const query = q('driver', 'Dallas, TX');
    const script = Array.from({ length: MAX_ATTEMPTS }, () => ({
        status: 429,
        body: 'concurrency_limit exceeded',
    }));
    const rpc = makeFakeRpc(new Map([[queryKey(query), script]]));
    const sleep = makeFakeSleep();

    const { results, summary } = await collectBatch([query], rpc, { sleep, backoffMs });

    assert.equal(rpc.callCount(queryKey(query)), MAX_ATTEMPTS);
    assert.equal(results[0].attempts, MAX_ATTEMPTS);
    assert.equal(results[0].outcome, OUTCOMES.RATE_LIMITED);
    assert.equal(results[0].lastStatus, 429);
    assert.match(results[0].error, /rate limited|concurrency_limit/i);
    // No sleep after the final attempt: four increasing waits for five attempts.
    assert.deepEqual(sleep.sequence(), [1000, 2000, 3000, 4000]);
    assert.equal(summary.failed, 1);
});

test('other non-200 statuses are terminal generic failures and are not retried', async () => {
    const query = q('welder', 'Detroit, MI');
    const rpc = makeFakeRpc(
        new Map([
            [
                queryKey(query),
                [
                    { status: 500, body: 'upstream scrape failed' },
                    mcpResponse(sampleJobs(1)), // unreachable
                ],
            ],
        ])
    );
    const sleep = makeFakeSleep();

    const { results } = await collectBatch([query], rpc, { sleep, backoffMs });

    assert.equal(rpc.callCount(queryKey(query)), 1);
    assert.deepEqual(sleep.sequence(), []);
    assert.equal(results[0].outcome, OUTCOMES.FAILED);
    assert.equal(results[0].lastStatus, 500);
    assert.match(results[0].error, /HTTP 500/);
});

test('a rejected rpcSend is a generic failure and does not stop the following query', async () => {
    const boom = q('ghost', 'Limbo, XX');
    const fine = q('teacher', 'Denver, CO');
    const rpc = makeFakeRpc(
        new Map([
            [queryKey(boom), [{ throw: new Error('socket hang up') }]],
            [queryKey(fine), [mcpResponse(sampleJobs(4))]],
        ])
    );

    const { results, summary } = await collectBatch([boom, fine], rpc, {
        sleep: makeFakeSleep(),
        backoffMs,
    });

    assert.equal(rpc.callCount(queryKey(boom)), 1);
    assert.equal(rpc.callCount(queryKey(fine)), 1); // the batch kept going
    assert.equal(results[0].outcome, OUTCOMES.FAILED);
    assert.match(results[0].error, /socket hang up/);
    assert.equal(results[0].lastStatus, null); // a thrown request produced no HTTP answer
    assert.equal(results[1].outcome, OUTCOMES.SUCCESS);
    assert.equal(summary.failed, 1);
    assert.equal(summary.success, 1);
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test('queries whose key is in the completed set are skipped without any RPC call', async () => {
    const done = q('developer', 'New York, NY');
    const todo = q('developer', 'Remote');
    const rpc = makeFakeRpc(new Map([[queryKey(todo), [mcpResponse(sampleJobs(2))]]]));
    const sleep = makeFakeSleep();

    const { results, summary } = await collectBatch([done, todo], rpc, {
        completedKeys: new Set([queryKey(done)]),
        sleep,
        backoffMs,
    });

    assert.equal(rpc.callCount(queryKey(done)), 0);
    assert.equal(rpc.callCount(queryKey(todo)), 1);
    assert.deepEqual(sleep.waits, []);
    assert.equal(results[0].outcome, OUTCOMES.SKIPPED);
    assert.equal(results[0].attempts, 0);
    assert.equal(results[0].lastStatus, null);
    assert.equal(results[0].error, null);
    assert.equal(results[0].key, queryKey(done));
    assert.equal(results[1].outcome, OUTCOMES.SUCCESS);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.total, 2);
});

test('arrays are accepted as completed sets and the caller set is not mutated', async () => {
    const done = q('clerk', 'Omaha, NE');
    const incoming = [queryKey(done)];
    const rpc = makeFakeRpc(new Map());

    const { results } = await collectBatch([done], rpc, {
        completedKeys: incoming,
        sleep: makeFakeSleep(),
        backoffMs,
    });

    assert.equal(results[0].outcome, OUTCOMES.SKIPPED);
    assert.deepEqual(incoming, [queryKey(done)]);
});

// ---------------------------------------------------------------------------
// Key stability and normalization
// ---------------------------------------------------------------------------

test('query keys survive whitespace and Unicode normalization and stay stable across runs', () => {
    const messy = { keyword: '  Java   Developer\n', location: '\tSan Jose,  CA ' };
    const tidy = { keyword: 'Java Developer', location: 'San Jose, CA' };

    assert.equal(normalizeQueryTerm('  Java   Developer\n'), 'Java Developer');
    assert.equal(queryKey(messy), queryKey(tidy));
    // Same input, repeated runs: the checkpoint key must be deterministic.
    assert.equal(queryKey(tidy), queryKey({ ...tidy }));

    // NFKC: the ligature "ﬁ" normalizes to "fi".
    assert.equal(normalizeQueryTerm('ﬁnance'), 'finance');
    assert.equal(queryKey(q('ﬁnance', 'NY')), queryKey(q('finance', 'NY')));

    // JSON-array encoding cannot collide on the separator, and casing stays significant.
    assert.notEqual(queryKey(q('react', 'NY')), queryKey(q('React', 'NY')));
    assert.notEqual(queryKey(q('a::b', 'c')), queryKey(q('a', 'b::c')));
});

test('a resumed batch matches a rerun query through normalization rather than literal text', async () => {
    const firstRun = q('Java Developer', 'San Jose, CA');
    const rerun = { keyword: '  Java   Developer ', location: 'San Jose,  CA' };
    const rpc = makeFakeRpc(new Map());

    const { results } = await collectBatch([rerun], rpc, {
        completedKeys: new Set([queryKey(firstRun)]),
        sleep: makeFakeSleep(),
        backoffMs,
    });

    assert.equal(rpc.calls.length, 0);
    assert.equal(results[0].outcome, OUTCOMES.SKIPPED);
});

// ---------------------------------------------------------------------------
// Batch-level guarantees
// ---------------------------------------------------------------------------

test('the mixed batch reports one record per query, input order, and a correct summary', async () => {
    const success = q('developer', 'New York, NY');
    const empty = q('margrave', 'Nowhere, XX');
    const auth = q('analyst', 'Austin, TX');
    const limited = q('driver', 'Dallas, TX');
    const serverError = q('welder', 'Detroit, MI');
    const skipped = q('teacher', 'Denver, CO');
    const laterSuccess = q('nurse', 'Chicago, IL');

    const scripts = new Map([
        [queryKey(success), [mcpResponse(sampleJobs(5))]],
        [queryKey(empty), [mcpResponse([])]],
        [queryKey(auth), [{ status: 401, body: 'Unauthorized' }]],
        [
            queryKey(limited),
            Array.from({ length: MAX_ATTEMPTS }, () => ({ status: 429, body: 'concurrency_limit' })),
        ],
        [queryKey(serverError), [{ status: 503, body: 'down' }]],
        // Rate limited once, then answered: still one record and a success.
        [queryKey(laterSuccess), [{ status: 429, body: 'concurrency_limit' }, mcpResponse(sampleJobs(2))]],
    ]);
    const rpc = makeFakeRpc(scripts);

    const queries = [success, empty, auth, limited, serverError, skipped, laterSuccess];
    const { results, summary } = await collectBatch(queries, rpc, {
        completedKeys: new Set([queryKey(skipped)]),
        sleep: makeFakeSleep(),
        backoffMs,
    });

    assert.equal(results.length, queries.length);
    assert.deepEqual(
        results.map((r) => r.query),
        queries
    );
    assert.deepEqual(
        results.map((r) => r.outcome),
        [
            OUTCOMES.SUCCESS,
            OUTCOMES.EMPTY,
            OUTCOMES.AUTH_ERROR,
            OUTCOMES.RATE_LIMITED,
            OUTCOMES.FAILED,
            OUTCOMES.SKIPPED,
            OUTCOMES.SUCCESS,
        ]
    );
    assert.deepEqual(summary, {
        total: 7,
        success: 2,
        empty: 1,
        failed: 3, // auth + rate-limited + 503
        skipped: 1,
    });
    assert.equal(summary.success + summary.empty + summary.failed + summary.skipped, summary.total);

    // Every non-skipped record carries the required fields.
    for (const record of results) {
        assert.ok('query' in record && 'outcome' in record && 'attempts' in record);
        assert.ok('lastStatus' in record && 'error' in record && 'key' in record);
        assert.equal(typeof record.attempts, 'number');
    }
});

test('a plain (non-MCP) payload with a jobs array is understood too', async () => {
    const query = q('designer', 'Seattle, WA');
    const rpc = makeFakeRpc(
        new Map([
            [
                queryKey(query),
                [{ status: 200, body: { json: { jobs: sampleJobs(2) }, requestMetadata: { status: 'ok' } } }],
            ],
        ])
    );

    const { results } = await collectBatch([query], rpc, { sleep: makeFakeSleep(), backoffMs });
    assert.equal(results[0].outcome, OUTCOMES.SUCCESS);
    assert.equal(results[0].jobCount, 2);
});

test('a 200 without any recognizable jobs array is a generic failure, not a success', async () => {
    const query = q('designer', 'Portland, OR');
    const rpc = makeFakeRpc(
        new Map([[queryKey(query), [{ status: 200, body: { unexpected: 'shape' } }]]])
    );

    const { results } = await collectBatch([query], rpc, { sleep: makeFakeSleep(), backoffMs });
    assert.equal(results[0].outcome, OUTCOMES.FAILED);
    assert.equal(results[0].attempts, 1);
    assert.match(results[0].error, /no jobs array/);
});

test('string bodies are parsed too, including SSE frames and an SSE concurrency_limit retry', async () => {
    const limitQuery = q('driver', 'Atlanta, GA');
    const sseLimit =
        'event: message\r\n' +
        'data: {"jsonrpc":"2.0","id":1,"error":{"code":"concurrency_limit","message":"plan concurrency is 1"}}\r\n\r\n';
    const sseSuccess =
        'data: ' +
        JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: {
                content: [{ type: 'text', text: JSON.stringify({ json: { jobs: sampleJobs(1) } }) }],
            },
        }) +
        '\r\n\r\n';

    const rpc = makeFakeRpc(
        new Map([
            [
                queryKey(limitQuery),
                [
                    { status: 200, body: sseLimit },
                    { status: 200, body: sseSuccess },
                ],
            ],
        ])
    );
    const sleep = makeFakeSleep();

    const { results } = await collectBatch([limitQuery], rpc, { sleep, backoffMs });
    assert.equal(rpc.callCount(queryKey(limitQuery)), 2);
    assert.equal(results[0].outcome, OUTCOMES.SUCCESS);
    assert.equal(results[0].jobCount, 1);
    assert.deepEqual(sleep.sequence(), [1000]);

    // Plain JSON text, no SSE framing.
    const plain = q('designer', 'Miami, FL');
    const rpc2 = makeFakeRpc(
        new Map([
            [
                queryKey(plain),
                [{ status: 200, body: JSON.stringify({ jobs: [] }) }],
            ],
        ])
    );
    const out2 = await collectBatch([plain], rpc2, { sleep: makeFakeSleep(), backoffMs });
    assert.equal(out2.results[0].outcome, OUTCOMES.EMPTY);
});
