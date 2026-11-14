#!/usr/bin/env node
// Snapshot one or more public Facebook pages and write a JSON report each.
//
//   HASDATA_API_KEY=... node bin/facebook-snapshot.mjs nike adidas --max-pages 4 --out snapshots
//
// Exit codes: 0 the page answered and the walk finished (feed end or page budget), 1 the page
// was unavailable or a page failed, 2 bad usage. A partial snapshot is still written before the
// non-zero exit, because the posts already fetched are the point of keeping a run resumable.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createMcpToolClient } from '../src/mcp-client.mjs';
import { DEFAULT_MAX_PAGES, DEFAULT_TOP_POSTS, formatSnapshotReport, snapshotPage } from '../src/snapshot.mjs';

const USAGE = `Usage: facebook-snapshot [options] <handle...>

Takes a profile-and-feed snapshot of each public Facebook page and writes
<out>/<handle>.snapshot.json plus <out>/<handle>.snapshot.md.

Options:
  --max-pages <n>     Pages to request per page, first included (default ${DEFAULT_MAX_PAGES})
  --top-posts <n>     Number of top-engagement posts to rank (default ${DEFAULT_TOP_POSTS})
  --language <code>   Render the page in this language (e.g. en, de, pt, zh-hans)
  --start-token <t>   Resume a walk from a pagination.nextPageToken
  --prior <file>      Earlier snapshot JSON to merge (profile, photos, posts, page ledger)
  --out <dir>         Output directory (default ./snapshots)
  --json              Print the JSON snapshot to stdout instead of the markdown report
  --quiet             Do not print the report, only write the files
  --endpoint <url>    Override the MCP endpoint
  --help              Show this help

Requires HASDATA_API_KEY. Each billable call costs 10 credits.`;

function usageError(message) {
    process.stderr.write(`${message}\n\n${USAGE}\n`);
    process.exit(2);
}

let parsed;
try {
    parsed = parseArgs({
        allowPositionals: true,
        options: {
            'max-pages': { type: 'string' },
            'top-posts': { type: 'string' },
            language: { type: 'string' },
            'start-token': { type: 'string' },
            prior: { type: 'string' },
            out: { type: 'string' },
            json: { type: 'boolean', default: false },
            quiet: { type: 'boolean', default: false },
            endpoint: { type: 'string' },
            help: { type: 'boolean', default: false },
        },
    });
} catch (err) {
    usageError(err.message);
}

const { values, positionals } = parsed;
if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
}
if (!positionals.length) usageError('at least one page handle is required');

function positiveInt(name, value, fallback) {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) usageError(`${name} must be a positive integer, got ${value}`);
    return n;
}

const maxPages = positiveInt('--max-pages', values['max-pages'], DEFAULT_MAX_PAGES);
const topPosts = positiveInt('--top-posts', values['top-posts'], DEFAULT_TOP_POSTS);
const handles = positionals.map((handle) => handle.replace(/^@/, '').trim()).filter(Boolean);
if (!handles.length) usageError('at least one non-empty page handle is required');

const outDir = resolve(values.out ?? 'snapshots');

let priorSnapshot = null;
if (values.prior !== undefined) {
    try {
        priorSnapshot = JSON.parse(await readFile(resolve(values.prior), 'utf8'));
    } catch (err) {
        process.stderr.write(`--prior could not be read as JSON: ${err.message}\n`);
        process.exit(2);
    }
    if (!priorSnapshot || typeof priorSnapshot !== 'object' || Array.isArray(priorSnapshot)) {
        process.stderr.write('--prior must contain a snapshot object\n');
        process.exit(2);
    }
    if (!values['start-token']) usageError('--prior requires --start-token from the earlier snapshot');
    if (handles.length > 1) usageError('--prior merges into one handle, so pass a single handle with --prior');
    if (priorSnapshot.handle && priorSnapshot.handle !== handles[0]) {
        process.stderr.write(`--prior was taken for "${priorSnapshot.handle}", not "${positionals[0]}"\n`);
        process.exit(2);
    }
}

let client;
try {
    client = createMcpToolClient({
        endpoint: values.endpoint,
        apiKey: process.env.HASDATA_API_KEY,
        onRetry: ({ attempt, code, delayMs }) => {
            process.stderr.write(`  retry ${attempt} after ${code}, waiting ${delayMs}ms\n`);
        },
    });
} catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
}

await mkdir(outDir, { recursive: true });

let failures = 0;
for (const handle of handles) {
    process.stderr.write(`snapshot ${handle}...\n`);
    let snapshot;
    try {
        snapshot = await snapshotPage({
            handle,
            language: values.language,
            client,
            maxPages,
            topPosts,
            startToken: values['start-token'],
            prior: priorSnapshot ?? undefined,
        });
    } catch (err) {
        // A usage-level failure such as a missing handle, not a page outcome.
        process.stderr.write(`  ${handle}: ${err.message}\n`);
        failures += 1;
        continue;
    }

    const safe = handle.replace(/[^\w.-]+/g, '_');
    const jsonPath = join(outDir, `${safe}.snapshot.json`);
    const mdPath = join(outDir, `${safe}.snapshot.md`);
    await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await writeFile(mdPath, formatSnapshotReport(snapshot), 'utf8');

    if (values.json) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    else if (!values.quiet) process.stdout.write(`${formatSnapshotReport(snapshot)}\n`);

    process.stderr.write(
        `  ${handle}: ${snapshot.stop.reason}, ${snapshot.stats.postsCollected} post(s), ` +
            `${snapshot.calls.billable} call(s) -> ${jsonPath}\n`,
    );
    if (!snapshot.ok) failures += 1;
}

// Set the code rather than calling process.exit(): a hard exit while the HTTP client still has
// sockets open trips a libuv assertion on Windows and reports a bogus 0xC0000409 exit status.
process.exitCode = failures ? 1 : 0;
