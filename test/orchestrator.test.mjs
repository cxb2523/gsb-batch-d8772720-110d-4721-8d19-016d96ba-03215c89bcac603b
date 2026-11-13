// Tests for the reusable collection orchestration layer (lib/orchestrator.mjs) and its
// JSON-RPC classification (lib/mcp-client.mjs).
//
// Nothing here touches the network or reads HASDATA_API_KEY. Every response is a
// hand-written JSON-RPC payload served by a fake fetch, so the success, throttling,
// retry-exhaustion, expired-token and validation paths are all deterministic and free.
//
// Run: node --test test/orchestrator.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createMcpCaller,
    classifyResponse,
    parseRpcMessage,
    OUTCOMES,
} from '../lib/mcp-client.mjs';
import {
    runCollection,
    needsAiOverviewExpansion,
    SERP_TOOL,
    AI_OVERVIEW_TOOL,
} from '../lib/orchestrator.mjs';

const SERP = SERP_TOOL;
const EXPAND = AI_OVERVIEW_TOOL;

// ---------------------------------------------------------------------------
// Hand-written JSON-RPC payloads, matching the shapes the README documents.
// ---------------------------------------------------------------------------

let rpcId = 1000;

// A successful tools/call: result.content[0].text is itself a JSON envelope whose
// `json` field holds the scraped payload.
function toolSuccess(payload, extraEnvelope = {}) {
    const envelope = {
        url: 'https://api.hasdata.com/...',
        status: 'ok',
        text: '',
        json: payload,
        ...extraEnvelope,
    };
    return {
        status: 200,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId++,
            result: {
                content: [{ type: 'text', text: JSON.stringify(envelope) }],
                isError: false,
            },
        }),
    };
}

// A tool-level failure: HTTP 200, result with isError and a reason string. This is how
// HasData reports 401 (wrong key) and 400 (stale token) in practice.
function toolError(text) {
    return {
        status: 200,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId++,
            result: { content: [{ type: 'text', text }], isError: true },
        }),
    };
}

// A JSON-RPC error envelope, e.g. MCP error -32602 for invalid params.
function rpcError(code, message) {
    return {
        status: 200,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId++,
            error: { code, message },
        }),
    };
}

const concurrencyBody = () =>
    toolError('HasData API error: 429 Too Many Requests, code: concurrency_limit');
const expiredTokenBody = () => toolError('HasData API error: 400 Bad Request');
const wrongKeyBody = () => toolError('HasData API error: 401 Unauthorized');
const missingQBody = () =>
    rpcError(-32602, 'MCP error -32602: Input validation error: q is required');

// A fake fetch: serve each scripted response in order, recording every request. Pass an
// explicit HTTP status to also cover gateway-level (non-200) answers.
function fakeFetch(scripted) {
    const requests = [];
    const impl = async (url, init) => {
        const payload = JSON.parse(init.body);
        requests.push({
            url,
            init,
            method: payload.method,
            toolName: payload.params?.name,
            args: payload.params?.arguments,
            id: payload.id,
        });
        const next = scripted.shift();
        if (!next) throw new Error('fake fetch ran out of scripted responses');
        return {
            status: next.status,
            ok: next.status >= 200 && next.status < 300,
            text: async () => next.body,
        };
    };
    return { impl, requests };
}

// No real waiting in tests: record the requested backoff instead and resolve immediately.
function fakeSleep() {
    const waits = [];
    return { sleepImpl: (ms) => waits.push(ms), waits };
}

const callerWith = (scripted, fetchOpts = {}) => {
    const { impl, requests } = fakeFetch(scripted);
    const callTool = createMcpCaller({ fetchImpl: impl, apiKey: 'test-key', ...fetchOpts });
    return { callTool, requests };
};

const runWith = (scripted, tasks, options = {}) => {
    const { impl, requests } = fakeFetch(scripted);
    const sleepTracker = fakeSleep();
    // Per-call options may override retry tuning, but never the sleep tracker, so the
    // increasing-backoff tests stay fast and observable.
    const { sleepImpl: _ignored, ...rest } = options;
    return runCollection(tasks, {
        callTool: createMcpCaller({ fetchImpl: impl, apiKey: 'test-key' }),
        sleepImpl: sleepTracker.sleepImpl,
        ...rest,
    }).then((summary) => ({ summary, requests, waits: sleepTracker.waits }));
};

const serpPayload = (aiOverview) => ({
    searchInformation: { query: 'best running shoes' },
    organicResults: [
        { position: 1, title: 'Runner’s World', link: 'https://example.test/1' },
    ],
    ...(aiOverview ? { aiOverview } : {}),
});

const inlineOverview = () => ({
    aiOverview: {
        textBlocks: [{ type: 'paragraph', snippet: 'A short answer.' }],
        references: [{ index: 0, title: 'Source', link: 'https://src.test' }],
    },
});

const tokenOverview = () => ({
    aiOverview: {
        pageToken: 'eyJ0b2tlbiI6ImZvbyJ9',
        hasdataLink: 'https://api.hasdata.com/scrape/google/ai-overview?pageToken=eyJ0b2tlbiI6ImZvbyJ9',
    },
});

// ---------------------------------------------------------------------------
// Pure classification helpers
// ---------------------------------------------------------------------------

test('classifyResponse covers every documented failure shape', () => {
    const ok = classifyResponse(200, JSON.parse(toolSuccess(serpPayload()).body));
    assert.equal(ok.outcome, OUTCOMES.SUCCESS);
    assert.deepEqual(ok.json.organicResults[0].position, 1);
    assert.equal(ok.retryable, false);

    assert.equal(
        classifyResponse(200, JSON.parse(concurrencyBody().body)).outcome,
        OUTCOMES.RATE_LIMITED
    );
    assert.equal(classifyResponse(429, { result: null }).retryable, true);

    const expired = classifyResponse(200, JSON.parse(expiredTokenBody().body));
    assert.equal(expired.outcome, OUTCOMES.TOKEN_EXPIRED);
    assert.match(expired.reason, /400 Bad Request/);
    assert.equal(expired.retryable, false);

    const auth = classifyResponse(200, JSON.parse(wrongKeyBody().body));
    assert.equal(auth.outcome, OUTCOMES.AUTH_FAILED);
    assert.match(auth.reason, /401 Unauthorized/);
    assert.equal(auth.retryable, false);

    const validation = classifyResponse(200, JSON.parse(missingQBody().body));
    assert.equal(validation.outcome, OUTCOMES.INVALID_PARAMS);
    assert.match(validation.reason, /-32602/);
    assert.equal(validation.retryable, false);

    assert.equal(classifyResponse(401, { result: null }).outcome, OUTCOMES.AUTH_FAILED);
    assert.equal(classifyResponse(400, { result: null }).outcome, OUTCOMES.TOKEN_EXPIRED);
    assert.equal(
        classifyResponse(200, JSON.parse(rpcError(-32603, 'boom').body)).outcome,
        OUTCOMES.OTHER_ERROR
    );
});

test('parseRpcMessage reads a single SSE data event and a multi-event stream', () => {
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} })}\n\n`;
    assert.equal(parseRpcMessage(sse, 7).id, 7);

    const multi = [
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'notifications/progress' })}`,
        '',
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 9, result: { ok: true } })}`,
    ].join('\n');
    assert.equal(parseRpcMessage(multi, 9).result.ok, true);

    assert.throws(() => parseRpcMessage('data: {"jsonrpc":"2.0","id":1}', 2), /no JSON-RPC message/);
});

test('needsAiOverviewExpansion distinguishes a token-only block from inline blocks', () => {
    assert.equal(needsAiOverviewExpansion(serpPayload(tokenOverview().aiOverview), SERP), true);
    assert.equal(needsAiOverviewExpansion(serpPayload(inlineOverview().aiOverview), SERP), false);
    assert.equal(needsAiOverviewExpansion(serpPayload(), SERP), false);
    assert.equal(needsAiOverviewExpansion(serpPayload(tokenOverview().aiOverview), EXPAND), false);
});

// ---------------------------------------------------------------------------
// Orchestration: the five scenarios requested, all against the fake endpoint.
// ---------------------------------------------------------------------------

test('a successful task returns the envelope json payload and needs no retry', async () => {
    const payload = serpPayload(inlineOverview().aiOverview);
    const { summary, requests } = await runWith(
        [toolSuccess(payload)],
        [{ id: 't1', tool: SERP, params: { q: 'best running shoes' } }]
    );

    assert.equal(summary.totalTasks, 1);
    assert.equal(summary.totalCalls, 1);
    assert.equal(summary.totalRetries, 0);
    assert.equal(summary.failed, 0);

    const [result] = summary.results;
    assert.equal(result.outcome, OUTCOMES.SUCCESS);
    assert.deepEqual(result.payload, payload);
    assert.ok(result.envelope.json, 'the full envelope is retained');
    assert.equal(result.totalAttempts, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].toolName, SERP);
    assert.deepEqual(requests[0].args, { q: 'best running shoes' });
    // No token-only overview, so no expansion is appended.
    assert.equal(result.expansion, null);
});

test('concurrency limit is retried with increasing waits and then succeeds', async () => {
    const { summary, requests, waits } = await runWith(
        [concurrencyBody(), concurrencyBody(), toolSuccess(serpPayload())],
        [{ tool: SERP, params: { q: 'retry me' } }],
        { baseDelayMs: 100, maxDelayMs: 10_000, maxRetries: 4 }
    );

    const [result] = summary.results;
    assert.equal(result.outcome, OUTCOMES.SUCCESS);
    assert.equal(result.retries, 2);
    assert.equal(result.totalAttempts, 3);
    assert.equal(summary.totalCalls, 3);
    assert.equal(summary.totalRetries, 2);
    assert.equal(requests.length, 3);
    // Every request is the same logical call retried with a fresh JSON-RPC id.
    assert.ok(requests.every((r) => r.toolName === SERP));
    assert.equal(new Set(requests.map((r) => r.id)).size, 3);
    // Increasing backoff: 100ms then 200ms.
    assert.deepEqual(waits, [100, 200]);
});

test('retry budget exhausted records rate_limited failure instead of throwing', async () => {
    const { summary, requests, waits } = await runWith(
        // maxRetries = 2 means three attempts total, all throttled; then task two runs.
        [concurrencyBody(), concurrencyBody(), concurrencyBody(), toolSuccess(serpPayload())],
        [
            { id: 'throttled', tool: SERP, params: { q: 'stuck' } },
            { id: 'after', tool: SERP, params: { q: 'kept going' } },
        ],
        { baseDelayMs: 50, maxRetries: 2 }
    );

    // The run did not abort: the second task still executed and consumed the last body.
    assert.equal(summary.totalTasks, 2);
    const [first, second] = summary.results;
    assert.equal(first.outcome, OUTCOMES.RATE_LIMITED);
    assert.equal(first.taskId, 'throttled');
    assert.equal(first.retries, 2);
    assert.equal(first.totalAttempts, 3);
    assert.match(first.reason, /concurrency limit/);
    assert.equal(second.outcome, OUTCOMES.SUCCESS);
    assert.equal(second.taskId, 'after');

    assert.equal(summary.failed, 1);
    assert.equal(summary.outcomeCounts.rate_limited, 1);
    assert.equal(summary.totalCalls, 4);
    assert.equal(waits.length, 2);

    // The caller can resubmit just the failed entry with its original parameters.
    assert.equal(summary.failedTasks.length, 1);
    assert.deepEqual(summary.failedTasks, [
        { id: 'throttled', tool: SERP, params: { q: 'stuck' }, parentIndex: null },
    ]);
});

test('an expired AI Overview token (400) fails the entry immediately with no retry', async () => {
    const { summary, requests, waits } = await runWith(
        [expiredTokenBody(), toolSuccess(serpPayload())],
        [
            { id: 'stale', tool: EXPAND, params: { pageToken: 'dead-token' } },
            { id: 'next', tool: SERP, params: { q: 'fresh query' } },
        ]
    );

    const [stale, next] = summary.results;
    assert.equal(stale.outcome, OUTCOMES.TOKEN_EXPIRED);
    assert.equal(stale.retries, 0);
    assert.equal(stale.totalAttempts, 1);
    assert.match(stale.reason, /token expired|400 Bad Request/);
    assert.equal(next.outcome, OUTCOMES.SUCCESS);
    assert.equal(requests.length, 2);
    assert.deepEqual(waits, []);
    assert.equal(summary.failedTasks[0].id, 'stale');
});

test('a missing q (-32602) is an invalid_params failure and is never retried', async () => {
    const { summary, requests, waits } = await runWith(
        [missingQBody()],
        [{ id: 'bad-args', tool: SERP, params: {} }]
    );

    const [result] = summary.results;
    assert.equal(result.outcome, OUTCOMES.INVALID_PARAMS);
    assert.equal(result.retries, 0);
    assert.equal(result.totalAttempts, 1);
    assert.match(result.reason, /-32602/);
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, []);
});

test('a wrong key (401 Unauthorized) is auth_failed, terminal, and keeps a readable reason', async () => {
    const { summary, requests } = await runWith(
        [wrongKeyBody()],
        [{ tool: SERP, params: { q: 'nope' } }]
    );
    const [result] = summary.results;
    assert.equal(result.outcome, OUTCOMES.AUTH_FAILED);
    assert.equal(result.retries, 0);
    assert.match(result.reason, /401 Unauthorized/);
    assert.equal(requests.length, 1);
});

test('a gateway-level HTTP 401 is classified without a JSON-RPC body', async () => {
    const { callTool, requests } = callerWith([
        { status: 401, body: 'Unauthorized' },
    ]);
    const response = await callTool(SERP, { q: 'x' });
    assert.equal(response.outcome, OUTCOMES.AUTH_FAILED);
    assert.equal(response.retryable, false);
    assert.equal(requests.length, 1);
});

// ---------------------------------------------------------------------------
// Automatic AI Overview expansion.
// ---------------------------------------------------------------------------

test('a token-only aiOverview appends an expansion task carrying the pageToken', async () => {
    const overviewPayload = {
        aiOverview: {
            textBlocks: [{ type: 'paragraph', snippet: 'The expanded answer.' }],
            references: [],
        },
    };
    const { summary, requests } = await runWith(
        [toolSuccess(serpPayload(tokenOverview().aiOverview)), toolSuccess(overviewPayload)],
        [{ id: 'serp-1', tool: SERP, params: { q: 'best running shoes' } }]
    );

    assert.equal(summary.totalTasks, 2);
    const [serp, expansion] = summary.results;

    assert.equal(serp.outcome, OUTCOMES.SUCCESS);
    assert.equal(serp.kind, 'task');
    assert.equal(expansion.kind, 'ai_overview_expansion');
    assert.equal(expansion.toolName, EXPAND);
    assert.equal(expansion.parentIndex, serp.index);
    assert.deepEqual(expansion.params, { pageToken: 'eyJ0b2tlbiI6ImZvbyJ9' });
    assert.equal(expansion.outcome, OUTCOMES.SUCCESS);
    assert.deepEqual(expansion.payload, overviewPayload);

    // The parent points back at the expansion outcome.
    assert.deepEqual(serp.expansion, {
        index: expansion.index,
        outcome: OUTCOMES.SUCCESS,
        reason: null,
        retries: 0,
    });

    // The expansion call really went out with the token from the SERP.
    assert.equal(requests[1].toolName, EXPAND);
    assert.deepEqual(requests[1].args, { pageToken: 'eyJ0b2tlbiI6ImZvbyJ9' });
    assert.equal(summary.totalCalls, 2);
});

test('an expansion failure is isolated: the succeeded SERP stays successful', async () => {
    const { summary } = await runWith(
        // SERP succeeds with a token-only overview; the expansion token is already stale.
        [toolSuccess(serpPayload(tokenOverview().aiOverview)), expiredTokenBody()],
        [{ id: 'serp-1', tool: SERP, params: { q: 'best running shoes' } }]
    );

    const [serp, expansion] = summary.results;
    assert.equal(serp.outcome, OUTCOMES.SUCCESS);
    assert.ok(serp.payload.organicResults, 'the SERP payload is retained despite the failed expansion');
    assert.equal(expansion.outcome, OUTCOMES.TOKEN_EXPIRED);
    assert.equal(expansion.retries, 0);
    assert.equal(serp.expansion.outcome, OUTCOMES.TOKEN_EXPIRED);

    // Only the expansion is resubmittable; the successful SERP is not in failedTasks.
    assert.equal(summary.failed, 1);
    assert.equal(summary.failedResults.length, 1);
    assert.equal(summary.failedTasks[0].tool, EXPAND);
    assert.equal(summary.failedTasks[0].params.pageToken, 'eyJ0b2tlbiI6ImZvbyJ9');
});

test('an inline aiOverview does not trigger an expansion', async () => {
    const { summary, requests } = await runWith(
        [toolSuccess(serpPayload(inlineOverview().aiOverview))],
        [{ tool: SERP, params: { q: 'inline' } }]
    );
    assert.equal(summary.totalTasks, 1);
    assert.equal(requests.length, 1);
    assert.equal(summary.results[0].expansion, null);
});

test('expansion can be disabled and runs ahead of later queued tasks', async () => {
    const { summary, requests } = await runWith(
        [toolSuccess(serpPayload(tokenOverview().aiOverview)), toolSuccess(serpPayload())],
        [
            { id: 'serp-1', tool: SERP, params: { q: 'first' } },
            { id: 'serp-2', tool: SERP, params: { q: 'second' } },
        ],
        { expandAiOverview: false }
    );
    assert.equal(summary.totalTasks, 2);
    assert.equal(requests.map((r) => r.args.q).join(','), 'first,second');

    // With expansion enabled the expansion jumps ahead of the second user task.
    const enabled = await runWith(
        [
            toolSuccess(serpPayload(tokenOverview().aiOverview)),
            toolSuccess({ aiOverview: { textBlocks: [] } }),
            toolSuccess(serpPayload()),
        ],
        [
            { id: 'serp-1', tool: SERP, params: { q: 'first' } },
            { id: 'serp-2', tool: SERP, params: { q: 'second' } },
        ]
    );
    assert.equal(enabled.summary.results[1].kind, 'ai_overview_expansion');
    assert.equal(enabled.requests[1].toolName, EXPAND);
    assert.equal(enabled.requests[2].args.q, 'second');
});

// ---------------------------------------------------------------------------
// Summary shape and resubmission ergonomics
// ---------------------------------------------------------------------------

test('the summary counts every outcome, retry and call across a mixed batch', async () => {
    const events = [];
    const { summary } = await runWith(
        [
            toolSuccess(serpPayload()),
            concurrencyBody(),
            toolSuccess(serpPayload()),
            missingQBody(),
            wrongKeyBody(),
        ],
        [
            { id: 'ok', tool: SERP, params: { q: 'ok' } },
            { id: 'slow', tool: SERP, params: { q: 'slow' } },
            { id: 'bad', tool: SERP, params: {} },
            { id: 'no-key', tool: SERP, params: { q: 'x' } },
        ],
        { maxRetries: 1, baseDelayMs: 10, onOutcome: (r) => events.push(r.outcome) }
    );

    assert.equal(summary.totalTasks, 4);
    assert.equal(summary.totalCalls, 5);
    assert.equal(summary.totalRetries, 1);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 2);
    assert.deepEqual(summary.outcomeCounts, {
        success: 2,
        rate_limited: 0,
        token_expired: 0,
        auth_failed: 1,
        invalid_params: 1,
        other_error: 0,
    });
    assert.deepEqual(events, [
        OUTCOMES.SUCCESS,
        OUTCOMES.SUCCESS,
        OUTCOMES.INVALID_PARAMS,
        OUTCOMES.AUTH_FAILED,
    ]);
    assert.deepEqual(summary.failedTasks.map((t) => t.id), ['bad', 'no-key']);
});

test('a task without a tool name is recorded as invalid_params without any call', async () => {
    const { summary, requests } = await runWith(
        [toolSuccess(serpPayload())],
        [{ params: { q: 'orphan' } }, { tool: SERP, params: { q: 'real' } }]
    );
    assert.equal(summary.results[0].outcome, OUTCOMES.INVALID_PARAMS);
    assert.equal(summary.results[0].totalAttempts, 0);
    assert.equal(summary.results[1].outcome, OUTCOMES.SUCCESS);
    assert.equal(requests.length, 1);
});

test('a transport failure becomes other_error and does not abort the batch', async () => {
    let calls = 0;
    const good = fakeFetch([toolSuccess(serpPayload())]);
    const fetchImpl = async (url, init) => {
        calls += 1;
        if (calls === 1) throw new TypeError('network down');
        return good.impl(url, init);
    };
    const callTool = createMcpCaller({ apiKey: 'test-key', fetchImpl });
    const summary = await runCollection(
        [{ tool: SERP, params: { q: 'offline' } }, { tool: SERP, params: { q: 'online' } }],
        { callTool, sleepImpl: () => {} }
    );
    assert.equal(summary.results[0].outcome, OUTCOMES.OTHER_ERROR);
    assert.match(summary.results[0].reason, /transport error/);
    assert.equal(summary.results[0].totalAttempts, 1);
    assert.equal(summary.results[1].outcome, OUTCOMES.SUCCESS);
    assert.equal(summary.failed, 1);
    assert.equal(summary.totalCalls, 2);
});
