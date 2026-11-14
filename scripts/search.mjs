#!/usr/bin/env node
// Command-line driver for the resumable multi-page Airbnb search in lib/multi-page-search.mjs.
//
// It talks JSON-RPC to the same remote streamable-HTTP endpoint the stdio launcher proxies
// to, so it needs HASDATA_API_KEY but no mcp-remote bridge. State is written as JSON after
// every run: point --resume at that file to continue a stopped or rate-limited search
// without repeating pages that already succeeded.
//
// Examples:
//   node scripts/search.mjs --location "Austin, Texas" --check-in 2026-12-10 \
//       --check-out 2026-12-13 --max-pages 3 --state ./austin-state.json
//   node scripts/search.mjs --resume ./austin-state.json --max-pages 3

import { readFile, writeFile } from 'node:fs/promises';
import { searchAllListings } from '../lib/multi-page-search.mjs';

function parseArgs(argv) {
    const flags = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags[key] = true;
            } else {
                flags[key] = next;
                i += 1;
            }
        } else {
            flags._.push(arg);
        }
    }
    return flags;
}

function buildSearchArgs(flags) {
    const args = {};
    if (flags.location) args.location = flags.location;
    if (flags['check-in']) args.checkIn = flags['check-in'];
    if (flags['check-out']) args.checkOut = flags['check-out'];
    if (flags.adults !== undefined) args.adults = Number(flags.adults);
    if (flags.children !== undefined) args.children = Number(flags.children);
    if (flags.infants !== undefined) args.infants = Number(flags.infants);
    if (flags.pets !== undefined) args.pets = Number(flags.pets);
    if (flags['ne-lat'] !== undefined) args.neLat = Number(flags['ne-lat']);
    if (flags['ne-lng'] !== undefined) args.neLng = Number(flags['ne-lng']);
    if (flags['sw-lat'] !== undefined) args.swLat = Number(flags['sw-lat']);
    if (flags['sw-lng'] !== undefined) args.swLng = Number(flags['sw-lng']);
    return args;
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    const apiKey = process.env.HASDATA_API_KEY;
    if (!apiKey) {
        process.stderr.write('HASDATA_API_KEY is not set. Create a free key at https://app.hasdata.com.\n');
        process.exit(1);
    }

    let state = null;
    let searchArgs;
    if (flags.resume) {
        try {
            state = JSON.parse(await readFile(flags.resume, 'utf8'));
        } catch (err) {
            process.stderr.write(`cannot read resume state from ${flags.resume}: ${err.message}\n`);
            process.exit(1);
        }
    } else {
        if (!flags['check-in']) {
            process.stderr.write('--check-in is required when starting a new search\n');
            process.exit(1);
        }
        searchArgs = buildSearchArgs(flags);
        if (!searchArgs.location && !(searchArgs.neLat && searchArgs.neLng && searchArgs.swLat && searchArgs.swLng)) {
            process.stderr.write('give --location or all four of --ne-lat/--ne-lng/--sw-lat/--sw-lng\n');
            process.exit(1);
        }
    }

    const result = await searchAllListings({
        endpoint: flags.endpoint || undefined,
        apiKey,
        searchArgs,
        state,
        maxPages: flags['max-pages'] ? Number(flags['max-pages']) : 10,
        maxRetries: flags['max-retries'] ? Number(flags['max-retries']) : 3,
    });

    if (flags.state) {
        await writeFile(flags.state, `${JSON.stringify(result.state, null, 2)}\n`);
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.status === 'failed' ? 2 : 0);
}

main().catch((err) => {
    process.stderr.write(`search failed: ${err.stack || err.message}\n`);
    process.exit(1);
});
