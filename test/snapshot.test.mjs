// Offline tests for the snapshot pipeline.
//
// Every response is a local fixture from ./fixtures/facebook-fixtures.mjs. No test here reads
// HASDATA_API_KEY or touches the network, so the suite runs on a fork and costs no credits.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpToolClient, ToolCallError } from '../src/mcp-client.mjs';
import { PAGE_STATUS, STOP_REASON, formatSnapshotReport, snapshotPage } from '../src/snapshot.mjs';
import {
    ONE_POST_FEED,
    PAGE_ERROR_PAYLOAD,
    PROFILE,
    THREE_PAGE_FEED,
    fakeClient,
    failingClient,
} from './fixtures/facebook-fixtures.mjs';

const NOW = '2026-11-14T09:00:00.000Z';

function ids(posts) {
    return posts.map((post) => post.id);
}

// ---------------------------------------------------------------------------
// Multi-page walk
// ---------------------------------------------------------------------------

test('a normal walk follows nextPageToken to the end and keeps profile and photos from page one', async () => {
    const client = fakeClient([
        { payload: THREE_PAGE_FEED.first },
        { payload: THREE_PAGE_FEED.second },
        { payload: THREE_PAGE_FEED.third },
    ]);

    const snapshot = await snapshotPage({ handle: 'nike', language: 'en', client, now: NOW });

    assert.equal(snapshot.available, true);
    assert.equal(snapshot.profile.name, 'Nike');
    assert.equal(snapshot.profile.likesCount, 39_545_204);
    // followersCount is display text, passed through untouched.
    assert.equal(snapshot.profile.followersCount, '39M followers');
    assert.equal(snapshot.photos.length, 2);

    // 1 + 3 + 3, counted as returned rather than padded to postsPerPage.
    assert.deepEqual(ids(snapshot.posts), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    assert.equal(snapshot.stats.postsCollected, 7);

    // The token from each response is the next request's argument, never nextPage.
    assert.deepEqual(
        client.requests.map((request) => request.nextPageToken ?? null),
        [null, 'token-2', 'token-3'],
    );
    assert.ok(client.requests.every((request) => !('nextPage' in request)));
    assert.ok(client.requests.every((request) => request.handle === 'nike' && request.language === 'en'));

    // Page 1 and 2 had a next token, page 3 had none: the feed ended there.
    assert.deepEqual(
        snapshot.pages.map((page) => ({ page: page.page, status: page.status, posts: page.posts })),
        [
            { page: 1, status: PAGE_STATUS.SUBMITTED, posts: 1 },
            { page: 2, status: PAGE_STATUS.SUBMITTED, posts: 3 },
            { page: 3, status: PAGE_STATUS.END, posts: 3 },
        ],
    );
    assert.equal(snapshot.stop.reason, STOP_REASON.FEED_END);
    assert.equal(snapshot.resume.token, null);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.calls.billable, 3);
    assert.equal(snapshot.calls.credits, 30);
    assert.equal(snapshot.calls.attempts, 3);
    assert.equal(snapshot.calls.retries, 0);
});

test('the opening page is not padded to postsPerPage and the cadence uses the real post count', async () => {
    const client = fakeClient([{ payload: THREE_PAGE_FEED.first }, { payload: THREE_PAGE_FEED.second }, { payload: THREE_PAGE_FEED.third }]);
    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW });

    // postsPerPage says 3 on every page; the opening page carries 1.
    assert.equal(snapshot.pages[0].posts, 1);
    assert.equal(snapshot.stats.byPage[0].posts, 1);
    assert.equal(snapshot.stats.byPage.reduce((sum, entry) => sum + entry.posts, 0), snapshot.posts.length);

    // Seven posts span six one-day gaps, so six posts per day, not seven.
    assert.equal(snapshot.stats.cadence.postsWithTimestamp, 7);
    assert.equal(snapshot.stats.cadence.spanDays, 6);
    assert.equal(snapshot.stats.cadence.postsPerDay, 1);
    assert.equal(snapshot.stats.cadence.medianGapHours, 24);
});

test('top posts rank by reactions plus comments plus shares', async () => {
    const client = fakeClient([{ payload: THREE_PAGE_FEED.first }, { payload: THREE_PAGE_FEED.second }, { payload: THREE_PAGE_FEED.third }]);
    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW, topPosts: 3 });

    assert.equal(snapshot.stats.topPosts.length, 3);
    assert.deepEqual(
        snapshot.stats.topPosts.map((post) => post.id),
        ['p1', 'p4', 'p2'],
    );
    assert.equal(snapshot.stats.topPosts[0].engagementTotal, 7_885 + 2_461 + 1_124);
    assert.equal(snapshot.stats.totals.reactions, 7_885 + 500 + 90 + 1_200 + 10 + 20 + 30);
});

// ---------------------------------------------------------------------------
// First page with one post only
// ---------------------------------------------------------------------------

test('a page whose feed ends on the opening call reports one post and no cadence claim', async () => {
    const client = fakeClient([{ payload: ONE_POST_FEED.first }]);
    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW });

    assert.equal(snapshot.stats.postsCollected, 1);
    assert.equal(snapshot.profile.name, 'Nike');
    assert.equal(snapshot.pages.length, 1);
    assert.equal(snapshot.pages[0].status, PAGE_STATUS.END);
    assert.equal(snapshot.pages[0].posts, 1);
    assert.equal(snapshot.stop.reason, STOP_REASON.FEED_END);
    // No token was ever returned, so no second call is made.
    assert.equal(client.requests.length, 1);
    assert.equal(snapshot.calls.billable, 1);
    // A single post is not enough to state a rate.
    assert.equal(snapshot.stats.cadence.postsPerDay, null);
    assert.match(formatSnapshotReport(snapshot), /only one post observed/i);
});

// ---------------------------------------------------------------------------
// Mid-walk error payload
// ---------------------------------------------------------------------------

test('an error payload on a later page stops the walk, keeps earlier posts and asks for no more tokens', async () => {
    const client = fakeClient([
        { payload: THREE_PAGE_FEED.first },
        { payload: THREE_PAGE_FEED.second },
        { payload: PAGE_ERROR_PAYLOAD },
    ]);
    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW });

    // The page itself was readable, so the profile stays.
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.profile.name, 'Nike');
    assert.deepEqual(ids(snapshot.posts), ['p1', 'p2', 'p3', 'p4']);
    assert.equal(snapshot.stop.reason, STOP_REASON.PAGE_UNAVAILABLE);
    assert.equal(snapshot.stop.page, 3);

    const failed = snapshot.pages.at(-1);
    assert.equal(failed.page, 3);
    assert.equal(failed.status, PAGE_STATUS.UNAVAILABLE);
    assert.equal(failed.posts, 0);
    assert.match(failed.reason.message, /does not exist, was deleted or is not public/i);

    // The errored page is billable, and the walk never asked for a fourth page.
    assert.equal(client.requests.length, 3);
    assert.equal(snapshot.calls.billable, 3);
    assert.equal(snapshot.calls.credits, 30);
});

test('an error payload on the opening page marks the page unavailable and stops immediately', async () => {
    const client = fakeClient([{ payload: PAGE_ERROR_PAYLOAD }]);
    const snapshot = await snapshotPage({ handle: 'ghost-page', client, now: NOW });

    assert.equal(snapshot.available, false);
    assert.equal(snapshot.profile, null);
    assert.deepEqual(snapshot.posts, []);
    assert.equal(snapshot.pages.length, 1);
    assert.equal(snapshot.pages[0].status, PAGE_STATUS.UNAVAILABLE);
    assert.equal(snapshot.stop.reason, STOP_REASON.PAGE_UNAVAILABLE);
    assert.equal(client.requests.length, 1);
    assert.match(formatSnapshotReport(snapshot), /Page unavailable/);

    // The snapshot is returned, not thrown: the caller decides what a missing page means.
    const report = formatSnapshotReport(snapshot);
    assert.match(report, /page 1/);
});

// ---------------------------------------------------------------------------
// Retry exhaustion
// ---------------------------------------------------------------------------

test('retry exhaustion on a later page marks that page failed and keeps the posts already fetched', async () => {
    const throttled = new ToolCallError('HTTP 429 from the Facebook MCP endpoint', {
        code: 'rate_limited',
        retryable: true,
        attempts: 4,
        billed: false,
        status: 429,
    });
    let call = 0;
    // Page one succeeds; every later request has already exhausted its retries and throws.
    const mixed = {
        requests: [],
        async call(args) {
            mixed.requests.push({ ...args });
            call += 1;
            if (call === 1) return { payload: THREE_PAGE_FEED.first, attempts: 1, billed: true };
            throw throttled;
        },
    };

    const snapshot = await snapshotPage({ handle: 'nike', client: mixed, now: NOW });

    assert.deepEqual(ids(snapshot.posts), ['p1']);
    assert.equal(snapshot.profile.name, 'Nike');
    assert.equal(snapshot.stop.reason, STOP_REASON.CALL_FAILED);
    assert.equal(snapshot.stop.page, 2);

    const failed = snapshot.pages.at(-1);
    assert.equal(failed.page, 2);
    assert.equal(failed.status, PAGE_STATUS.FAILED);
    assert.equal(failed.reason.code, 'rate_limited');
    assert.equal(failed.reason.attempts, 4);
    assert.equal(failed.reason.billed, false);

    // Only the successful page was billable; the four throttled attempts were not.
    assert.equal(snapshot.calls.billable, 1);
    assert.equal(snapshot.calls.attempts, 1 + 4);
    assert.equal(snapshot.calls.retries, 3, 'four attempts on the failed page means three retries');
    // No advance: a failed page yields no token, so no further call is attempted.
    assert.equal(mixed.requests.length, 2);
    assert.equal(snapshot.resume.token, 'token-2', 'the token for the failed page is kept so the run can resume');
});

test('retry exhaustion on the opening page reports the page unavailable with a reason', async () => {
    const throttled = new ToolCallError('HTTP 429 from the Facebook MCP endpoint', {
        code: 'rate_limited',
        retryable: true,
        attempts: 4,
        billed: false,
        status: 429,
    });
    const client = failingClient(throttled);
    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW });

    assert.equal(snapshot.available, false);
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.profile, null);
    assert.equal(snapshot.pages[0].status, PAGE_STATUS.FAILED);
    assert.equal(snapshot.stop.reason, STOP_REASON.CALL_FAILED);
    assert.equal(snapshot.calls.billable, 0);
    assert.equal(snapshot.calls.attempts, 4);
    assert.equal(client.requests.length, 1);
});

test('a real retrying client gives up on a permanently throttled page and the runner keeps its posts', async () => {
    const requests = [];
    const delays = [];
    let requestNo = 0;
    const client = createMcpToolClient({
        apiKey: 'test-key',
        fetchImpl: async (_url, init) => {
            requestNo += 1;
            const args = JSON.parse(init.body).params.arguments;
            requests.push(args);
            if (!args.nextPageToken) return rpcResponse(requestNo, THREE_PAGE_FEED.first);
            return new Response('{"error":"concurrency_limit"}', { status: 429 });
        },
        sleep: async (ms) => delays.push(ms),
        baseDelayMs: 100,
        backoffFactor: 2,
        maxAttempts: 3,
    });

    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW });

    // Page one answered; the second page never cleared the throttle.
    assert.deepEqual(ids(snapshot.posts), ['p1']);
    assert.equal(snapshot.profile.name, 'Nike');
    assert.equal(snapshot.pages.at(-1).status, PAGE_STATUS.FAILED);
    assert.equal(snapshot.pages.at(-1).reason.attempts, 3);
    assert.equal(snapshot.stop.reason, STOP_REASON.CALL_FAILED);
    assert.equal(snapshot.ok, false);

    // Three attempts at page 2, two waits between them, and no third page was requested.
    assert.equal(requests.length, 1 + 3);
    assert.deepEqual(delays, [100, 200]);
    assert.equal(snapshot.calls.attempts, 4);
    assert.equal(snapshot.calls.retries, 2);
    assert.equal(snapshot.calls.billable, 1);
    assert.equal(snapshot.resume.token, 'token-2');
});

// ---------------------------------------------------------------------------
// Page budget and resume
// ---------------------------------------------------------------------------

test('a page budget stops cleanly and leaves the token for a later run', async () => {
    const client = fakeClient([{ payload: THREE_PAGE_FEED.first }, { payload: THREE_PAGE_FEED.second }]);
    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW, maxPages: 2 });

    assert.equal(snapshot.stop.reason, STOP_REASON.MAX_PAGES);
    assert.equal(snapshot.pages.at(-1).status, PAGE_STATUS.SUBMITTED);
    assert.equal(snapshot.resume.token, 'token-3');
    assert.equal(snapshot.resume.stoppedAtPage, 2);
    assert.equal(snapshot.stats.postsCollected, 4);
});

test('a later run can resume from the stored token and merge the earlier data', async () => {
    const first = await snapshotPage({
        handle: 'nike',
        client: fakeClient([{ payload: THREE_PAGE_FEED.first }, { payload: THREE_PAGE_FEED.second }]),
        now: NOW,
        maxPages: 2,
    });

    const resumeClient = fakeClient([{ payload: THREE_PAGE_FEED.third }]);
    const rest = await snapshotPage({
        handle: 'nike',
        client: resumeClient,
        now: NOW,
        prior: first,
        startToken: first.resume.token,
    });

    assert.equal(resumeClient.requests[0].nextPageToken, 'token-3');
    assert.deepEqual(ids(rest.posts), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    assert.equal(rest.profile.name, 'Nike');
    assert.equal(rest.photos.length, 2);
    // The resumed run keeps the earlier page ledger and numbers the new page after it.
    assert.deepEqual(
        rest.pages.map((page) => ({ page: page.page, status: page.status })),
        [
            { page: 1, status: PAGE_STATUS.SUBMITTED },
            { page: 2, status: PAGE_STATUS.SUBMITTED },
            { page: 3, status: PAGE_STATUS.END },
        ],
    );
    assert.equal(rest.pages.at(-1).page, 3);
    // The feed is exhausted, so no token is offered even though a last page number is recorded.
    assert.equal(rest.resume.token, null);
    assert.equal(rest.resume.nextPage, 3);
    assert.equal(rest.stop.reason, STOP_REASON.FEED_END);
    // Only the new call is billed on this run; the merged snapshot still carries the earlier data.
    assert.equal(rest.calls.billable, 1);
    assert.equal(rest.stats.byPage[0].page, 'prior');
    assert.equal(rest.stats.byPage[0].posts, 4);
});

test('a repeated token is refused rather than followed forever', async () => {
    const client = fakeClient([
        { payload: THREE_PAGE_FEED.first },
        { payload: { ...THREE_PAGE_FEED.second, pagination: { nextPageToken: 'token-2' } } },
    ]);
    const snapshot = await snapshotPage({ handle: 'nike', client, now: NOW, maxPages: 5 });

    assert.equal(snapshot.stop.reason, STOP_REASON.REPEATED_TOKEN);
    assert.equal(client.requests.length, 2);
    assert.equal(snapshot.pages.at(-1).reason.code, 'repeated_token');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

test('the report names every page outcome and the number of calls spent', async () => {
    const snapshot = await snapshotPage({
        handle: 'nike',
        client: fakeClient([{ payload: THREE_PAGE_FEED.first }, { payload: PAGE_ERROR_PAYLOAD }]),
        now: NOW,
    });
    const report = formatSnapshotReport(snapshot);

    assert.match(report, /Facebook snapshot: Nike/);
    assert.match(report, /Followers: 39M followers/);
    assert.match(report, /page 1 \(profile\+feed\): success, 1 post/);
    assert.match(report, /page 2 \(token\): unavailable, 0 post/);
    assert.match(report, /Billable calls: 2 \(20 credits\)/);
    assert.match(report, /Stop reason: page_unavailable/);
});

// ---------------------------------------------------------------------------
// MCP client retry policy, with a stubbed transport
// ---------------------------------------------------------------------------

function rpcResponse(id, payload, { isError = false } = {}) {
    return new Response(
        JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify({ json: payload }) }], isError },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function sseResponse(id, payload) {
    const body = `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify({ json: payload }) }], isError: false },
    })}\n\n`;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('the client retries a 429 with a growing backoff and then succeeds', async () => {
    const delays = [];
    const statuses = [429, 429, 200];
    let index = 0;
    const client = createMcpToolClient({
        apiKey: 'test-key',
        fetchImpl: async () => {
            const status = statuses[index++];
            if (status === 429) return new Response('{"error":"concurrency_limit"}', { status, headers: { 'Retry-After': '0' } });
            return rpcResponse(3, THREE_PAGE_FEED.first);
        },
        sleep: async (ms) => delays.push(ms),
        baseDelayMs: 100,
        maxAttempts: 4,
    });

    const result = await client.call({ handle: 'nike' });
    assert.equal(result.payload.profile.name, 'Nike');
    assert.equal(result.attempts, 3);
    assert.equal(result.billed, true);
    // Retry-After: 0 is honoured ahead of the exponential schedule.
    assert.deepEqual(delays, [0, 0]);
});

test('the client honours an exponential backoff when Retry-After is absent', async () => {
    const delays = [];
    let index = 0;
    const client = createMcpToolClient({
        apiKey: 'test-key',
        fetchImpl: async () => {
            index += 1;
            return index < 3 ? new Response('busy', { status: 429 }) : rpcResponse(index, ONE_POST_FEED.first);
        },
        sleep: async (ms) => delays.push(ms),
        baseDelayMs: 1_000,
        backoffFactor: 3,
        maxAttempts: 3,
    });

    await client.call({ handle: 'nike' });
    assert.deepEqual(delays, [1_000, 3_000]);
});

test('the client gives up after maxAttempts and reports the attempts and a non-billed failure', async () => {
    let calls = 0;
    const client = createMcpToolClient({
        apiKey: 'test-key',
        fetchImpl: async () => {
            calls += 1;
            return new Response('{"error":"concurrency_limit"}', { status: 429 });
        },
        sleep: async () => {},
        maxAttempts: 3,
    });

    await assert.rejects(client.call({ handle: 'nike' }), (err) => {
        assert.ok(err instanceof ToolCallError);
        assert.equal(err.code, 'rate_limited');
        assert.equal(err.attempts, 3);
        assert.equal(err.billed, false);
        assert.equal(err.retryable, true);
        return true;
    });
    assert.equal(calls, 3);
});

test('a 401 is permanent: it is not retried', async () => {
    let calls = 0;
    const client = createMcpToolClient({
        apiKey: 'wrong',
        fetchImpl: async () => {
            calls += 1;
            return new Response('Unauthorized', { status: 401 });
        },
        sleep: async () => {
            throw new Error('must not sleep on a permanent failure');
        },
    });

    await assert.rejects(client.call({ handle: 'nike' }), (err) => {
        assert.equal(err.code, 'unauthorized');
        assert.equal(err.attempts, 1);
        return true;
    });
    assert.equal(calls, 1);
});

test('a concurrency limit expressed in an SSE keep-alive is retried', async () => {
    let index = 0;
    const client = createMcpToolClient({
        apiKey: 'test-key',
        fetchImpl: async () => {
            index += 1;
            if (index === 1) return new Response(': concurrency_limit\n\n', { status: 200 });
            return sseResponse(index, ONE_POST_FEED.first);
        },
        sleep: async () => {},
        maxAttempts: 3,
    });

    const result = await client.call({ handle: 'nike' });
    assert.equal(result.attempts, 2);
    assert.equal(result.payload.profile.name, 'Nike');
});

test('the client parses a server-sent-events answer and picks the message with our id', async () => {
    const client = createMcpToolClient({
        apiKey: 'test-key',
        fetchImpl: async () =>
            new Response(
                [
                    'event: notification',
                    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
                    '',
                    `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ json: THREE_PAGE_FEED.first }) }] } })}`,
                    '',
                ].join('\n'),
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            ),
    });

    const result = await client.call({ handle: 'nike' });
    assert.equal(result.payload.profile.id, PROFILE.id);
});

test('a missing API key fails fast without any request', async () => {
    let called = false;
    assert.throws(
        () =>
            createMcpToolClient({
                apiKey: '',
                fetchImpl: async () => {
                    called = true;
                    return new Response('{}');
                },
            }),
        (err) => err.code === 'missing_api_key',
    );
    assert.equal(called, false);
});

test('a tool-level isError is a billed failure', async () => {
    const client = createMcpToolClient({
        apiKey: 'test-key',
        fetchImpl: async () => rpcResponse(1, { ignored: true }, { isError: true }),
        sleep: async () => {},
    });

    await assert.rejects(client.call({ handle: 'nike' }), (err) => {
        assert.equal(err.code, 'tool_error');
        assert.equal(err.billed, true);
        assert.equal(err.retryable, false);
        return true;
    });
});
