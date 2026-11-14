// Tests for the paginated collection flow in collect.mjs.
//
// No real key and no network: a local HTTP server plays the HasData endpoint, answering
// tools/call with canned plain-JSON or SSE bodies and recording every page it was asked
// for. Sleeps are faked too, so the rate-limit retries run instantly while the wait
// schedule is still asserted.
//
// Run: node --test test/collect.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { collectBookingSearch, validateSearchInput, OUTCOME } from '../collect.mjs';

const INPUT = {
    keyword: 'Paris',
    checkInDate: '2026-12-14',
    checkOutDate: '2026-12-17',
    rooms: 1,
    adults: 2,
    children: 0,
};

function items(page, n) {
    return Array.from({ length: n }, (_, i) => ({ id: `p${page}-hotel-${i}`, name: `Hotel ${i} of page ${page}` }));
}

// A successful tools/call reply whose text payload holds a results array, the shape the
// real search tool answers with.
function toolMessage(id, results) {
    return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify({ results }) }] },
    };
}

function sse(...messages) {
    return messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');
}

// handler(requestBody, callCount) -> { status?, raw } | { status?, json } | { sse: [...] }
async function startServer(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const parsed = JSON.parse(body);
            requests.push(parsed);
            const answer = handler(parsed, requests.length);
            const raw = answer.sse ? sse(...answer.sse) : answer.raw ?? JSON.stringify(answer.json);
            res.writeHead(answer.status ?? 200, {
                'Content-Type': answer.sse ? 'text/event-stream' : 'application/json',
            });
            res.end(raw);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        requests,
        endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

// Shared options: local endpoint, no real waiting, no real key.
function collect(server, extra = {}) {
    return collectBookingSearch({
        ...INPUT,
        apiKey: 'test-key',
        endpoint: server.endpoint,
        sleep: extra.sleep ?? (() => Promise.resolve()),
        ...extra,
    });
}

test('collects several pages and stops at the page cap', async () => {
    const server = await startServer(({ id, params }) => {
        const page = params.arguments.page;
        return { json: toolMessage(id, items(page, 25)) };
    });
    try {
        const progress = await collect(server, { maxPages: 3 });

        assert.deepEqual(
            progress.pages.map((p) => [p.page, p.outcome, p.count, p.total]),
            [
                [1, OUTCOME.SUCCESS, 25, 25],
                [2, OUTCOME.SUCCESS, 25, 50],
                [3, OUTCOME.SUCCESS, 25, 75],
            ]
        );
        assert.equal(progress.fetched, 75);
        assert.equal(progress.results.length, 75);
        assert.equal(progress.nextPage, 4);
        assert.equal(progress.resumable, true);
        assert.equal(progress.stoppedReason, 'max_pages');
        assert.deepEqual(
            server.requests.map((r) => r.params.arguments.page),
            [1, 2, 3]
        );
        // The same tool and required parameters the launcher exposes.
        assert.equal(server.requests[0].params.name, 'hasdata_booking_search_getBookingSearchResults');
        const args = server.requests[0].params.arguments;
        for (const field of ['keyword', 'checkInDate', 'checkOutDate', 'rooms', 'adults', 'children']) {
            assert.ok(field in args, `missing required argument ${field}`);
        }
    } finally {
        await server.close();
    }
});

test('reads SSE answers and picks the message with the matching request id', async () => {
    const server = await startServer(({ id, params }) => {
        const page = params.arguments.page;
        if (page === 1) return { json: toolMessage(id, items(1, 3)) };
        // Page 2 arrives as SSE, with a progress notification (different id) first.
        return {
            sse: [
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 0.5 } },
                { jsonrpc: '2.0', id: id + 100, result: {} },
                toolMessage(id, items(2, 3)),
            ],
        };
    });
    try {
        const progress = await collect(server, { maxPages: 2 });
        assert.deepEqual(
            progress.pages.map((p) => p.outcome),
            [OUTCOME.SUCCESS, OUTCOME.SUCCESS]
        );
        assert.equal(progress.fetched, 6);
        assert.equal(progress.nextPage, 3);
    } finally {
        await server.close();
    }
});

test('an empty results array ends the run as empty, not as an error', async () => {
    const server = await startServer(({ id, params }) => {
        const page = params.arguments.page;
        return { json: toolMessage(id, page === 1 ? items(1, 25) : []) };
    });
    try {
        const progress = await collect(server, { maxPages: 5 });

        assert.deepEqual(
            progress.pages.map((p) => [p.page, p.outcome, p.count]),
            [
                [1, OUTCOME.SUCCESS, 25],
                [2, OUTCOME.EMPTY, 0],
            ]
        );
        assert.equal(progress.fetched, 25);
        assert.equal(progress.resumable, false);
        assert.equal(progress.stoppedReason, OUTCOME.EMPTY);
        // Nothing was requested past the empty page.
        assert.equal(server.requests.length, 2);
    } finally {
        await server.close();
    }
});

test('retries concurrency_limit with growing waits, then records rate_limited and stops', async () => {
    const limited = (id) => ({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'concurrency_limit: too many concurrent requests' },
    });
    const server = await startServer(({ id, params }, callCount) => {
        const page = params.arguments.page;
        // Page 1 recovers after two collisions; page 2 never does.
        if (page === 1 && callCount <= 2) return { json: limited(id) };
        if (page === 1) return { json: toolMessage(id, items(1, 25)) };
        return { json: limited(id) };
    });
    const waits = [];
    try {
        const progress = await collect(server, {
            maxPages: 5,
            maxRetries: 3,
            retryBaseMs: 1000,
            sleep: (ms) => {
                waits.push(ms);
                return Promise.resolve();
            },
        });

        assert.deepEqual(
            progress.pages.map((p) => [p.page, p.outcome, p.count]),
            [
                [1, OUTCOME.SUCCESS, 25],
                [2, OUTCOME.RATE_LIMITED, 0],
            ]
        );
        // Increasing waits: 1x, 2x for page 1, then 1x, 2x, 3x for page 2.
        assert.deepEqual(waits, [1000, 2000, 1000, 2000, 3000]);
        // 3 calls for page 1 (2 retries + success), 4 for page 2 (initial + 3 retries).
        assert.equal(server.requests.length, 7);
        assert.equal(progress.fetched, 25);
        // The failed page is the resume point, so nothing fetched is lost or repeated.
        assert.equal(progress.nextPage, 2);
        assert.equal(progress.resumable, true);
        assert.equal(progress.stoppedReason, OUTCOME.RATE_LIMITED);
    } finally {
        await server.close();
    }
});

test('resuming continues from nextPage and never refetches successful pages', async () => {
    const server = await startServer(({ id, params }) => {
        const page = params.arguments.page;
        return { json: toolMessage(id, items(page, 25)) };
    });
    try {
        const first = await collect(server, { maxPages: 2 });
        assert.equal(first.nextPage, 3);
        assert.equal(server.requests.length, 2);

        const second = await collect(server, { maxPages: 2, progress: first });

        // The resumed run's progress carries the earlier pages plus the new ones.
        assert.deepEqual(
            second.pages.map((p) => [p.page, p.outcome, p.total]),
            [
                [1, OUTCOME.SUCCESS, 25],
                [2, OUTCOME.SUCCESS, 50],
                [3, OUTCOME.SUCCESS, 75],
                [4, OUTCOME.SUCCESS, 100],
            ]
        );
        assert.equal(second.fetched, 100);
        assert.equal(second.results.length, 100);
        assert.equal(second.nextPage, 5);
        // Pages 1 and 2 were not requested again: 2 calls in run one, 2 in run two.
        assert.equal(server.requests.length, 4);
        assert.deepEqual(
            server.requests.map((r) => r.params.arguments.page),
            [1, 2, 3, 4]
        );
    } finally {
        await server.close();
    }
});

test('resuming after a rate limit retries the failed page', async () => {
    let calls = 0;
    const server = await startServer(({ id, params }) => {
        calls++;
        const page = params.arguments.page;
        // Page 2 is limited during the first run, healthy in the second.
        if (page === 2 && calls <= 3) {
            return { json: { jsonrpc: '2.0', id, error: { code: -32000, message: 'concurrency_limit' } } };
        }
        return { json: toolMessage(id, items(page, 25)) };
    });
    try {
        const first = await collect(server, { maxPages: 3, maxRetries: 1 });
        assert.deepEqual(
            first.pages.map((p) => p.outcome),
            [OUTCOME.SUCCESS, OUTCOME.RATE_LIMITED]
        );
        assert.equal(first.nextPage, 2);

        const second = await collect(server, { maxPages: 2, progress: first });
        assert.deepEqual(
            second.pages.map((p) => [p.page, p.outcome]),
            [
                [1, OUTCOME.SUCCESS],
                [2, OUTCOME.RATE_LIMITED],
                [2, OUTCOME.SUCCESS],
                [3, OUTCOME.SUCCESS],
            ]
        );
        assert.equal(second.fetched, 75);
        assert.equal(second.nextPage, 4);
    } finally {
        await server.close();
    }
});

test('invalid input is rejected before any request goes out', async () => {
    const server = await startServer(({ id }) => ({ json: toolMessage(id, items(1, 25)) }));
    try {
        // children > 0 without matching childrenAges.
        const noAges = await collect(server, { children: 2, maxPages: 3 });
        assert.equal(noAges.pages.at(-1).outcome, OUTCOME.INVALID_INPUT);
        assert.ok(
            noAges.errors.some((e) => e.field === 'childrenAges'),
            `expected a childrenAges fault, got ${JSON.stringify(noAges.errors)}`
        );
        assert.equal(noAges.fetched, 0);
        assert.equal(noAges.resumable, false);

        // check-out not later than check-in.
        const badDates = await collect(server, { checkOutDate: INPUT.checkInDate });
        assert.equal(badDates.pages.at(-1).outcome, OUTCOME.INVALID_INPUT);
        assert.ok(
            badDates.errors.some((e) => e.field === 'checkOutDate'),
            `expected a checkOutDate fault, got ${JSON.stringify(badDates.errors)}`
        );

        // Neither attempt cost a request, so neither cost credits.
        assert.equal(server.requests.length, 0);
    } finally {
        await server.close();
    }
});

test('validateSearchInput flags each bad field by name', () => {
    const errors = validateSearchInput({
        keyword: ' ',
        checkInDate: 'not-a-date',
        checkOutDate: '2026-12-01',
        rooms: 0,
        adults: 2,
        children: 2,
        childrenAges: [7],
    });
    const fields = errors.map((e) => e.field);
    for (const field of ['keyword', 'checkInDate', 'rooms', 'childrenAges']) {
        assert.ok(fields.includes(field), `expected a fault for ${field}, got ${fields.join(', ')}`);
    }
    assert.equal(validateSearchInput({ ...INPUT, children: 1, childrenAges: [5] }).length, 0);
});
