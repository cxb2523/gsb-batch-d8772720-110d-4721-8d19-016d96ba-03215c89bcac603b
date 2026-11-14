// End-to-end test for the CLI, against a local MCP-shaped HTTP server.
//
// The server speaks just enough streamable HTTP (JSON and SSE bodies) to answer the snapshot
// walk from fixtures. No HasData endpoint, no key, no credits: the key below is a literal that
// the local server ignores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGE_ERROR_PAYLOAD, THREE_PAGE_FEED } from './fixtures/facebook-fixtures.mjs';

const CLI = fileURLToPath(new URL('../bin/facebook-snapshot.mjs', import.meta.url));

let server;
let baseUrl;
let lastArgs = null;
let responses = [];

before(async () => {
    server = createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => {
            raw += chunk;
        });
        request.on('end', () => {
            const body = JSON.parse(raw);
            lastArgs = body.params?.arguments ?? null;
            const next = responses.shift();
            const answer = {
                jsonrpc: '2.0',
                id: body.id,
                result: {
                    content: [{ type: 'text', text: JSON.stringify({ json: next }) }],
                    isError: false,
                },
            };
            // Alternate transport shapes so both paths are exercised through the real client.
            if (responses.length % 2 === 0) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(answer));
            } else {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

function runCli(args, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            env: { ...process.env, HASDATA_API_KEY: 'local-test-key', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('the CLI follows the feed, writes both artefacts and exits 0', async () => {
    lastArgs = null;
    responses = [THREE_PAGE_FEED.first, THREE_PAGE_FEED.second, THREE_PAGE_FEED.third];
    const outDir = await mkdtemp(join(tmpdir(), 'fb-snapshot-'));
    try {
        const { code, stdout, stderr } = await runCli([
            'nike',
            '--endpoint',
            baseUrl,
            '--out',
            outDir,
            '--max-pages',
            '4',
        ]);

        assert.equal(code, 0, stderr);
        assert.match(stderr, /nike: feed_end, 7 post\(s\), 3 call\(s\)/);
        assert.match(stdout, /Facebook snapshot: Nike/);

        const json = JSON.parse(await readFile(join(outDir, 'nike.snapshot.json'), 'utf8'));
        assert.deepEqual(json.posts.map((post) => post.id), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
        assert.equal(json.calls.billable, 3);
        assert.equal(json.stop.reason, 'feed_end');

        const markdown = await readFile(join(outDir, 'nike.snapshot.md'), 'utf8');
        assert.match(markdown, /page 3 \(token\): end, 3 post/);

        // The request actually carried the token, not nextPage.
        assert.equal(lastArgs.nextPageToken, 'token-3');
        assert.equal(lastArgs.handle, 'nike');
    } finally {
        await rm(outDir, { recursive: true, force: true });
    }
});

test('the CLI writes a partial snapshot and exits 1 when the page is unavailable', async () => {
    responses = [PAGE_ERROR_PAYLOAD];
    const outDir = await mkdtemp(join(tmpdir(), 'fb-snapshot-'));
    try {
        const { code, stdout } = await runCli(['ghost-page', '--endpoint', baseUrl, '--out', outDir]);

        assert.equal(code, 1);
        assert.match(stdout, /Page unavailable/);
        const json = JSON.parse(await readFile(join(outDir, 'ghost-page.snapshot.json'), 'utf8'));
        assert.equal(json.available, false);
        assert.equal(json.pages[0].status, 'unavailable');
        // The errored call is billable even though it yielded no page.
        assert.equal(json.calls.billable, 1);
    } finally {
        await rm(outDir, { recursive: true, force: true });
    }
});

test('the CLI resumes from a stored token and merges the earlier snapshot file', async () => {
    // First run stops at the page budget, leaving a token behind.
    responses = [THREE_PAGE_FEED.first];
    const outDir = await mkdtemp(join(tmpdir(), 'fb-snapshot-'));
    try {
        const first = await runCli(['nike', '--endpoint', baseUrl, '--out', outDir, '--max-pages', '1']);
        assert.equal(first.code, 0, first.stderr);
        const partial = JSON.parse(await readFile(join(outDir, 'nike.snapshot.json'), 'utf8'));
        assert.equal(partial.stop.reason, 'max_pages');
        assert.equal(partial.resume.token, 'token-2');

        responses = [THREE_PAGE_FEED.second, THREE_PAGE_FEED.third];
        const rest = await runCli([
            'nike',
            '--endpoint',
            baseUrl,
            '--out',
            outDir,
            '--start-token',
            partial.resume.token,
            '--prior',
            join(outDir, 'nike.snapshot.json'),
        ]);
        assert.equal(rest.code, 0, rest.stderr);

        const merged = JSON.parse(await readFile(join(outDir, 'nike.snapshot.json'), 'utf8'));
        assert.deepEqual(merged.posts.map((post) => post.id), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
        assert.equal(merged.stop.reason, 'feed_end');
        // Only this run's two calls are billed.
        assert.equal(merged.calls.billable, 2);
        assert.equal(merged.profile.name, 'Nike');
    } finally {
        await rm(outDir, { recursive: true, force: true });
    }
});

test('the CLI refuses to start without an API key and spends no call', async () => {
    responses = [];
    const outDir = await mkdtemp(join(tmpdir(), 'fb-snapshot-'));
    try {
        const { code, stderr } = await runCli(['nike', '--endpoint', baseUrl, '--out', outDir], { HASDATA_API_KEY: '' });
        assert.equal(code, 2);
        assert.match(stderr, /API key is required/);
        assert.equal(responses.length, 0);
    } finally {
        await rm(outDir, { recursive: true, force: true });
    }
});

test('the CLI rejects a non-positive page budget', async () => {
    const { code, stderr } = await runCli(['nike', '--max-pages', '0']);
    assert.equal(code, 2);
    assert.match(stderr, /--max-pages must be a positive integer/);
});

test('the CLI prints usage with --help and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Takes a profile-and-feed snapshot/);
});
