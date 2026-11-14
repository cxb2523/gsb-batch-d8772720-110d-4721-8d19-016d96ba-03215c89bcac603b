#!/usr/bin/env node
// Collection entry point for the /salary-benchmark command.
//
// It walks the Glassdoor listing tool page by page and prints a grouped salary picture plus a
// per-page record of how each page ended. It never invents a page number: after page one, the
// only thing that advances the walk is the token the previous page returned.
//
// Usage:
//   node scripts/salary-benchmark.mjs --keyword "data engineer" --location "Austin, TX" \
//     [--sort recent|relevant] [--domain www.glassdoor.co.uk] [--max-pages 5] \
//     [--endpoint URL] [--json]
//
// HASDATA_API_KEY supplies the key. Override the endpoint for a local fake server or a test.
// Every page costs 10 credits, so maxPages is a spending cap as well as a coverage cap.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMcpClient, DEFAULT_ENDPOINT } from './lib/client.mjs';
import {
  collectListings,
  clampMaxPages,
  DEFAULT_MAX_PAGES,
  OUTCOME,
  STATUS,
} from './lib/collect.mjs';

const PAGE_COST_CREDITS = 10;
const SORT_VALUES = ['recent', 'relevant'];

const OUTCOME_LABELS = {
  [OUTCOME.OK]: 'success',
  [OUTCOME.EMPTY]: 'empty page (no postings)',
  [OUTCOME.STOP_TOKEN_MISSING]: 'success, no next-page token',
  [OUTCOME.STOP_TOKEN_REPEATED]: 'success, next-page token repeats an earlier one',
  [OUTCOME.STOP_MAX_PAGES]: 'success, page cap reached with a token still on offer',
  [OUTCOME.RATE_LIMITED]: 'failed: rate limited, abandoned after retries',
  [OUTCOME.AUTH]: 'failed: key rejected (401)',
  [OUTCOME.ERROR]: 'failed: other error',
};

const USAGE = `Usage: node scripts/salary-benchmark.mjs --keyword ROLE --location PLACE [options]

Options:
  --keyword ROLE        required, e.g. "data engineer"
  --location PLACE      required, e.g. "Austin, TX"
  --sort VALUE          recent or relevant (default: Glassdoor's own order)
  --domain HOST         one of the regional Glassdoor sites, e.g. www.glassdoor.co.uk
  --max-pages N         pages to collect, 1-50 (default ${DEFAULT_MAX_PAGES}); each page costs ${PAGE_COST_CREDITS} credits
  --endpoint URL        MCP endpoint (default ${DEFAULT_ENDPOINT}); point it at a fake server to test
  --api-key KEY         HasData key; defaults to HASDATA_API_KEY
  --json                print the full result as JSON instead of the readable report
  --help                show this message
`;

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/i);
    if (!match) throw new UsageError(`unexpected argument: ${arg}`);
    const name = match[1].toLowerCase();
    let value = match[2];
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`--${name} needs a value`);
      }
      i += 1;
    }
    const key = { 'max-pages': 'maxPages', 'api-key': 'apiKey' }[name] ?? name;
    args[key] = value;
  }
  return args;
}

class UsageError extends Error {}

function formatMoney(amount, currency, period) {
  if (amount === null || amount === undefined) return '—';
  const rounded = Math.round(amount * 100) / 100;
  const number = rounded.toLocaleString('en-US');
  const suffix = period === 'HOURLY' ? '/hr' : period === 'MONTHLY' ? '/mo' : '';
  return `${number} ${currency ?? ''}${suffix}`.trim();
}

function formatPeriod(period) {
  if (period === 'ANNUAL') return 'annual';
  if (period === 'HOURLY') return 'hourly';
  if (period === 'MONTHLY') return 'monthly';
  return period.toLowerCase();
}

function formatSource(source) {
  if (source === 'EMPLOYER_PROVIDED') return 'employer-provided';
  if (source === 'ESTIMATED') return 'Glassdoor estimate';
  return source.toLowerCase();
}

function renderReport(result) {
  const lines = [];
  const { query, pages, stats, coverage } = result;

  lines.push(`# Salary benchmark: ${query.keyword} in ${query.location}`);
  lines.push('');
  lines.push(`Scope: ${[query.sort && `sorted ${query.sort}`, query.domain && `site ${query.domain}`]
    .filter(Boolean).join(', ') || 'default sort, US site'}, up to ${query.maxPages} page(s).`);
  lines.push('');

  lines.push('## Coverage');
  lines.push('');
  for (const page of pages) {
    const parts = [
      `page ${page.page}: ${OUTCOME_LABELS[page.outcome] ?? page.outcome}`,
      `status ${page.status ?? 'unknown'}`,
      `${page.jobCount} posting(s)`,
      `${page.totalJobs} collected so far`,
    ];
    if (page.requestedToken) parts.push('sent the previous page\'s token');
    if (page.reason) parts.push(page.reason);
    lines.push(`- ${parts.join(' · ')}`);
  }
  lines.push('');
  const incompleteWhy = {
    [OUTCOME.STOP_MAX_PAGES]: `the page cap of ${coverage.pagesPlanned} was reached while another page was still on offer`,
    [OUTCOME.STOP_TOKEN_REPEATED]: 'the server handed back a token that had already been used',
    [OUTCOME.RATE_LIMITED]: 'a page was still rate limited after its retries',
    [OUTCOME.AUTH]: 'the API key was rejected',
    [OUTCOME.ERROR]: 'a page failed',
  }[coverage.stopReason];
  const stoppedAt = coverage.pagesFetched
    ? `the walk stopped after ${coverage.pagesFetched} page(s)${incompleteWhy ? ` because ${incompleteWhy}` : ''}`
    : `the walk collected no page${incompleteWhy ? ` because ${incompleteWhy}` : ''}`;
  const completeText = coverage.complete
    ? 'complete for this query: the walk ended because the listing did'
    : `INCOMPLETE: ${stoppedAt}. The figures below cover only the pages collected`;
  lines.push(`**Coverage: ${coverage.pagesFetched} of up to ${coverage.pagesPlanned} page(s), `
    + `${coverage.totalJobs} posting(s) — ${completeText}.**`);
  if (coverage.stopReason === OUTCOME.STOP_MAX_PAGES) {
    lines.push('');
    lines.push('Raise `--max-pages` to collect the pages that were on offer. Each extra page costs '
      + `${PAGE_COST_CREDITS} credits.`);
  }
  lines.push('');
  lines.push(`Cost: ${coverage.pagesFetched} successful page(s) × ${PAGE_COST_CREDITS} credits = `
    + `${coverage.pagesFetched * PAGE_COST_CREDITS} credits. A failed page is not billed.`);
  lines.push('');

  lines.push('## Salary by source and period');
  lines.push('');
  if (!stats.sets.length) {
    lines.push('No posting carried a usable salary figure.');
  } else {
    lines.push('Employer-published figures and Glassdoor estimates are separate sets and are never averaged together.');
    lines.push('Annual and hourly figures are also separate; nothing has been converted.');
    lines.push('');
    for (const set of stats.sets) {
      lines.push(
        `### ${formatSource(set.source)} · ${formatPeriod(set.period)} · ${set.currency}`,
      );
      lines.push('');
      lines.push(`- Postings: ${set.count} (${set.singleFigureCount} with a single stated figure)`);
      lines.push(`- Low: ${formatMoney(set.low, set.currency, set.period)}`);
      lines.push(`- Median: ${formatMoney(set.median, set.currency, set.period)}`);
      lines.push(`- High: ${formatMoney(set.high, set.currency, set.period)}`);
      if (set.employers.top.length) {
        lines.push('');
        lines.push('Paying most:');
        for (const entry of set.employers.top) {
          lines.push(
            `- ${entry.company || '(unnamed employer)'} — ${formatMoney(entry.amount, entry.currency, entry.period)}`
            + `${entry.rating !== null ? `, rating ${entry.rating}` : ', no rating'}`
            + `${entry.ageInDays !== null ? `, posted ${entry.ageInDays} day(s) ago` : ''}`,
          );
        }
      }
      if (set.employers.bottom.length) {
        lines.push('');
        lines.push('Paying least:');
        for (const entry of set.employers.bottom) {
          lines.push(
            `- ${entry.company || '(unnamed employer)'} — ${formatMoney(entry.amount, entry.currency, entry.period)}`
            + `${entry.rating !== null ? `, rating ${entry.rating}` : ', no rating'}`
            + `${entry.ageInDays !== null ? `, posted ${entry.ageInDays} day(s) ago` : ''}`,
          );
        }
      }
      lines.push('');
    }
  }

  lines.push('## Postings without a usable figure');
  lines.push('');
  lines.push(`- No salary at all: ${stats.noSalary}`);
  if (stats.unclassified) {
    lines.push(`- Salary with an unrecognised source: ${stats.unclassified} (reported separately, never merged)`);
  }
  lines.push('');

  const failed = pages.filter((page) => page.status !== STATUS.SUCCESS && page.status !== STATUS.EMPTY);
  if (failed.length) {
    lines.push('## Page failures');
    lines.push('');
    for (const page of failed) {
      lines.push(`- Page ${page.page}: ${OUTCOME_LABELS[page.outcome] ?? page.outcome} — ${page.reason}`);
    }
    lines.push('');
  }

  lines.push('Figures are Glassdoor\'s. "Glassdoor estimate" entries are Glassdoor\'s model, not pay the employer reported.');
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const missing = ['keyword', 'location'].filter((key) => !args[key]);
  if (missing.length) {
    process.stderr.write(`Missing ${missing.map((key) => `--${key}`).join(' and ')}.\n\n${USAGE}`);
    return 2;
  }

  if (args.sort !== undefined && !SORT_VALUES.includes(args.sort)) {
    process.stderr.write(`--sort must be one of ${SORT_VALUES.join(', ')}; got "${args.sort}".\n\n${USAGE}`);
    return 2;
  }

  if (args.maxPages !== undefined && String(clampMaxPages(args.maxPages)) !== String(args.maxPages)) {
    process.stderr.write(`--max-pages must be an integer from 1 to 50; got "${args.maxPages}".\n`);
    return 2;
  }

  const apiKey = args.apiKey ?? process.env.HASDATA_API_KEY;
  const endpoint = args.endpoint ?? DEFAULT_ENDPOINT;
  if (!apiKey && endpoint === DEFAULT_ENDPOINT) {
    // A local fake endpoint needs no key. The hosted server does, and a clear message beats a
    // 401 mid-walk.
    process.stderr.write('HASDATA_API_KEY is not set. Set it, pass --api-key, or test against a fake endpoint with --endpoint.\n');
    return 2;
  }

  const client = createMcpClient({
    endpoint,
    apiKey,
    onRetry: ({ attempt, delayMs, status }) => {
      process.stderr.write(`rate limited (status ${status ?? 'n/a'}); retry ${attempt} in ${delayMs} ms\n`);
    },
  });

  const result = await collectListings({
    client,
    keyword: args.keyword,
    location: args.location,
    sort: args.sort,
    domain: args.domain,
    maxPages: args.maxPages,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(result)}\n`);
  }

  // A failed walk still prints the collected statistics but exits non-zero, so an unattended
  // caller can tell complete coverage from partial coverage without parsing prose.
  return result.coverage.complete ? 0 : 1;
}

// Comparing real paths makes the entry check work when the script is invoked through a
// symlink, as a package bin is on Unix, rather than silently doing nothing.
function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}

export { main, parseArgs, renderReport, formatMoney };
