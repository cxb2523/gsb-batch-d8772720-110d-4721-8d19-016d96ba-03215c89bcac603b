#!/usr/bin/env node
// Reproducible, resumable catalogue scan runner.
//
//   node bin/catalog-scan.mjs https://www.example.com --output scan.json
//   node bin/catalog-scan.mjs --resume scan.json
//
// The JSON record is rewritten (atomically) after every collection, so killing the process loses
// at most the collection in flight and `--resume` continues from the checkpoint without
// re-pulling completed collections. A companion .md report is written next to it.

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { HasdataShopifyClient } from '../lib/mcp-client.mjs';
import { scanStore, DEFAULT_BACKOFF_MS, MAX_ATTEMPTS } from '../lib/catalog-scan.mjs';
import { renderMarkdownReport } from '../lib/report.mjs';

function parseArgs(argv) {
    const args = {
        url: null,
        output: null,
        resume: null,
        collections: null,
        maxAttempts: MAX_ATTEMPTS,
        endpoint: null,
    };
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined) throw new Error(`${flag} needs a value`);
            i += 1;
            return value;
        };
        if (flag === '--output') args.output = next();
        else if (flag === '--resume') args.resume = next();
        else if (flag === '--collections') args.collections = next().split(',').map((s) => s.trim()).filter(Boolean);
        else if (flag === '--max-attempts') args.maxAttempts = Number(next());
        else if (flag === '--endpoint') args.endpoint = next();
        else if (flag === '--help' || flag === '-h') args.help = true;
        else if (flag.startsWith('--')) throw new Error(`unknown flag: ${flag}`);
        else positional.push(flag);
    }
    args.url = positional[0] ?? null;
    return args;
}

const HELP = `Usage:
  catalog-scan <store-url> [--output FILE] [--collections h1,h2] [--max-attempts N] [--endpoint URL]
  catalog-scan --resume FILE [--output FILE] [--collections h1,h2] [--endpoint URL]

Options:
  --output FILE        Checkpoint JSON path (default: catalog-scan-<host>-<timestamp>.json).
  --resume FILE        Resume a previous run from its checkpoint.
  --collections LIST   Comma-separated collection handles; skips the collections listing.
  --max-attempts N     Rate-limit attempts per page (default 5, increasing backoff).
  --endpoint URL      Override the HasData MCP endpoint.

Exit codes: 0 all collections complete, 2 some collections need another run, 1 fatal error.
`;

function sanitizeFileName(value) {
    return value.replace(/^https?:\/\//, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'store';
}

async function writeAtomic(filePath, contents) {
    const temporary = `${filePath}.tmp-${process.pid}`;
    await writeFile(temporary, contents);
    await rename(temporary, filePath);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1) {
        throw new Error('--max-attempts must be a positive integer');
    }

    let priorRecord = null;
    if (args.resume) {
        priorRecord = JSON.parse(await readFile(args.resume, 'utf8'));
    }

    const url = args.url ?? priorRecord?.url;
    if (!url) {
        throw new Error('a store URL is required, either as an argument or inside the --resume record');
    }

    const startedAt = new Date().toISOString();
    const output =
        args.output ??
        args.resume ??
        path.join(process.cwd(), `catalog-scan-${sanitizeFileName(url)}-${startedAt.replace(/[:.]/g, '-')}.json`);
    const reportPath = output.replace(/\.json$/i, '') + '.md';

    const client = new HasdataShopifyClient(args.endpoint ? { endpoint: args.endpoint } : {});
    const fetcher = client.makeProductsFetcher(url);

    let collections = args.collections;
    if (!collections) {
        if (priorRecord && priorRecord.url === url) {
            collections = priorRecord.collections.map((summary) => summary.collection);
        } else {
            // Step 1 of the workflow: show the catalogue shape before spending product calls.
            const listing = await client.listCollections(url);
            if (!listing.ok) {
                throw new Error(
                    `collections listing failed (${listing.error}). Retry a known Shopify store as https://<shop>.myshopify.com`
                );
            }
            collections = listing.collections.map((entry) => entry.handle);
            process.stderr.write(
                `Collections (${listing.collections.length}):\n` +
                    listing.collections
                        .map((entry) => `  - ${entry.handle} (products_count=${entry.products_count ?? 'n/a'})`)
                        .join('\n') +
                    '\n'
            );
        }
    }

    if (collections.length === 0) {
        process.stderr.write('No collections to scan; writing an empty record.\n');
    }

    const backoffMs = DEFAULT_BACKOFF_MS;
    const record = await scanStore({
        url,
        collections,
        fetcher,
        maxAttempts: args.maxAttempts,
        backoffMs,
        priorRecord,
        onCollectionComplete: async (snapshot, handle) => {
            const complete = snapshot.collections.length;
            process.stderr.write(
                `[${complete}/${collections.length}] ${handle}: ${
                    snapshot.collections.at(-1)?.status
                } (backoff schedule between retries: ${backoffMs.join(', ')} ms)\n`
            );
            await writeAtomic(output, JSON.stringify(snapshot, null, 2));
        },
    });

    await writeAtomic(output, JSON.stringify(record, null, 2));
    await writeAtomic(reportPath, renderMarkdownReport(record));

    process.stdout.write(`\nRecord: ${output}\nReport: ${reportPath}\n\n`);
    process.stdout.write(renderMarkdownReport(record));
    process.stdout.write('\n');

    return record.collections_needing_resume.length > 0 ? 2 : 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        process.stderr.write(`catalog-scan failed: ${error.message}\n`);
        process.exit(1);
    });
