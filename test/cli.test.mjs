// Black-box tests for bin/collect-reviews.mjs.
//
// The CLI is launched as a real child process pointed at a loopback HTTP server that
// speaks just enough of the streamable-HTTP JSON-RPC protocol to serve scripted review
// pages. Nothing leaves the machine and no real HasData key is used: the key the child
// sends is a literal string the fake ignores. Every review body is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'bin', 'collect-reviews.mjs');

function sseEnvelope(payload, id) {
    const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    });
    return `event: message\ndata: ${message}\n\n`;
}

// behaviour(token, requestCount) returns either a payload object (HTTP 200 SSE) or
// { status, body } for an error response.
function startFakeServer(behaviour) {
    const requests = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            const body = JSON.parse(raw);
            const args = body.params.arguments;
            const token = args.nextPageToken ?? null;
            requests.push({ token, args, apiKey: req.headers['x-api-key'] });
            const outcome = behaviour(token, requests.length);
            if (outcome.status) {
                res.writeHead(outcome.status, { 'Content-Type': 'text/plain' });
                res.end(outcome.body);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseEnvelope(outcome, body.id));
        });
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    // Shut the loopback server down only after every child connection has drained, and
    // destroy any stragglers. Closing while a child process still owns a socket trips a
    // libuv handle assertion on Windows.
    const stop = () =>
        new Promise((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () =>
            resolve({ server, port: server.address().port, requests, stop })
        );
    });
}

function runCli(args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [cliPath, ...args], {
            env: { ...process.env, HASDATA_API_KEY: 'offline-fake-key', ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

const twoPageFeed = (token) => {
    if (token === null) {
        return {
            pagination: { hasNextPage: true, nextPageToken: 'page-2-token' },
            reviews: [{ id: 'r1' }, { id: 'r2' }],
        };
    }
    return { pagination: { hasNextPage: false, nextPageToken: null }, reviews: [{ id: 'r3' }] };
};

test('CLI walks the full feed, persists job.json and reviews.json, exits 0', async () => {
    const { port, requests, stop } = await startFakeServer(twoPageFeed);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-job-'));
    try {
        const result = await runCli([
            '--place', 'mock-biz',
            '--endpoint', `http://127.0.0.1:${port}/mcp`,
            '--out-dir', dir,
            '--sort', 'dateDesc',
            '--page-size', '49',
        ]);

        assert.equal(result.code, 0, result.stderr);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].apiKey, 'offline-fake-key');
        assert.equal(requests[0].token, null);
        assert.equal(requests[1].token, 'page-2-token', 'cursor forwarded verbatim');
        assert.equal(requests[0].args.placeId, 'mock-biz');
        assert.equal(requests[0].args.sortBy, 'dateDesc');
        assert.equal(requests[0].args.num, 49);

        const job = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
        assert.equal(job.status, 'completed');
        assert.equal(job.totalCollected, 3);
        assert.deepEqual(job.pages.map((p) => [p.page, p.pageCount, p.cumulativeCount, p.hasNextPage]), [
            [1, 2, 2, true],
            [2, 1, 3, false],
        ]);
        const reviews = JSON.parse(await fs.readFile(path.join(dir, 'reviews.json'), 'utf8'));
        assert.deepEqual(reviews.map((r) => r.id), ['r1', 'r2', 'r3']);
    } finally {
        await stop();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('CLI exits 3 on a partial job, keeps collected reviews, and --resume finishes it', async () => {
    // First server: page 1 works, page 2 always answers 429 so the retry budget runs out.
    const failing = await startFakeServer((token) => {
        if (token === null) {
            return {
                pagination: { hasNextPage: true, nextPageToken: 'page-2-token' },
                reviews: [{ id: 'r1' }],
            };
        }
        return { status: 429, body: 'concurrency_limit' };
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-job-'));
    try {
        const first = await runCli([
            '--place', 'mock-biz',
            '--endpoint', `http://127.0.0.1:${failing.port}/mcp`,
            '--out-dir', dir,
            '--max-attempts', '3',
            '--retry-base-ms', '1',
        ]);
        assert.equal(first.code, 3, 'partial completion has its own exit code');
        await failing.stop();

        const partialJob = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
        assert.equal(partialJob.status, 'partial');
        assert.equal(partialJob.totalCollected, 1);
        assert.equal(partialJob.pages.at(-1).error.reason, 'concurrency_limit');

        // Healthy server resumes from the saved cursor.
        const healthy = await startFakeServer(twoPageFeed);
        try {
            const second = await runCli(['--resume', path.join(dir, 'job.json'), '--endpoint', `http://127.0.0.1:${healthy.port}/mcp`]);
            assert.equal(second.code, 0, second.stderr);
            assert.equal(healthy.requests.length, 1, 'only the missing page is requested');
            assert.equal(healthy.requests[0].token, 'page-2-token');

            const done = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
            assert.equal(done.status, 'completed');
            assert.equal(done.totalCollected, 2, 'page 1 kept, page 2 added');
            assert.equal(done.failureHistory.length, 1, 'the earlier failure stays auditable');
        } finally {
            await healthy.stop();
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('CLI exits 1 on a missing key without contacting the endpoint', async () => {
    const { port, requests, stop } = await startFakeServer(twoPageFeed);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-job-'));
    try {
        const result = await runCli(
            ['--place', 'mock-biz', '--endpoint', `http://127.0.0.1:${port}/mcp`, '--out-dir', dir],
            { HASDATA_API_KEY: '' }
        );
        assert.equal(result.code, 1);
        assert.match(result.stderr, /HASDATA_API_KEY is not set/);
        assert.equal(requests.length, 0, 'no network request before the key check');
    } finally {
        await stop();
        await fs.rm(dir, { recursive: true, force: true });
    }
});
