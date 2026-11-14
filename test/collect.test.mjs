// Offline tests for the /salary-benchmark collector.
//
// Every scenario runs against scripts/testing/fake-mcp-server.mjs on 127.0.0.1, so the suite needs no
// API key, no network and no credits. That is deliberate: the rules that matter here (token
// chaining, retry budget, mixed salary shapes) are exactly the ones that are expensive or
// impossible to provoke against the live server.
//
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { startFakeServer } from '../scripts/testing/fake-mcp-server.mjs';
import { createMcpClient } from '../scripts/lib/client.mjs';
import {
  collectListings,
  readNextToken,
  groupSalaries,
  normalizeJob,
  clampMaxPages,
  OUTCOME,
  STATUS,
} from '../scripts/lib/collect.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'salary-benchmark.mjs');

// A client whose waits are recorded rather than slept, so a five-retry scenario finishes
// instantly and the test can assert the intervals increased.
function fakeClient(endpoint, { apiKey = 'test-key', maxRetries = 5, retryBaseMs = 100 } = {}) {
  const waits = [];
  const client = createMcpClient({
    endpoint,
    apiKey,
    maxRetries,
    retryBaseMs,
    retryCapMs: 60_000,
    sleep: async (ms) => { waits.push(ms); },
  });
  return { client, waits };
}

async function withFake(scenario, fn) {
  const fake = await startFakeServer({ scenario });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

async function collect(scenario, options = {}) {
  return withFake(scenario, async (fake) => {
    const { client, waits } = fakeClient(fake.url, options.client);
    const result = await collectListings({
      client,
      keyword: 'data engineer',
      location: 'Austin, TX',
      maxPages: options.maxPages ?? 5,
    });
    return { result, fake, waits };
  });
}

// ---------------------------------------------------------------------------------------------
// Pagination

test('two pages merge, and only page one omits the token', async () => {
  const { result, fake } = await collect('two-pages');

  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].outcome, OUTCOME.OK);
  assert.equal(result.pages[0].jobCount, 2);
  assert.equal(result.pages[0].totalJobs, 2);
  // Page two ends the listing naturally: jobs arrived, no token was offered.
  assert.equal(result.pages[1].outcome, OUTCOME.STOP_TOKEN_MISSING);
  assert.equal(result.pages[1].jobCount, 1);
  assert.equal(result.pages[1].totalJobs, 3);

  assert.equal(result.coverage.pagesFetched, 2);
  assert.equal(result.coverage.totalJobs, 3);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.truncated, false);

  // Three postings across two employer-provided annual figures, merged into one set.
  assert.equal(result.stats.sets.length, 1);
  const set = result.stats.sets[0];
  assert.equal(set.source, 'EMPLOYER_PROVIDED');
  assert.equal(set.period, 'ANNUAL');
  assert.equal(set.count, 3);
  assert.equal(set.low, 95000);
  assert.equal(set.median, 100000);
  assert.equal(set.high, 110000);

  // Page one sent no token; page two sent only the token page one returned, and nothing else
  // changed between the two requests.
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[0].args.nextPageToken, undefined);
  assert.equal(fake.requests[1].args.nextPageToken, 'page-2-token');
  assert.equal(fake.requests[1].args.keyword, fake.requests[0].args.keyword);
  assert.equal(fake.requests[1].args.location, fake.requests[0].args.location);
  assert.deepEqual(
    Object.keys(fake.requests[1].args).sort(),
    ['keyword', 'location', 'nextPageToken'],
    'the second request invented a parameter',
  );
});

test('a missing next-page token on page two stops the walk and is reported', async () => {
  const { result, fake } = await collect('token-missing-page-two');

  assert.equal(fake.requests.length, 2, 'the collector should not ask for a page it has no token for');
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[1].outcome, OUTCOME.STOP_TOKEN_MISSING);
  assert.match(result.pages[1].reason, /no token/i);

  // Page two's job is still counted even though the walk ended there.
  assert.equal(result.coverage.totalJobs, 2);
  assert.equal(result.stats.sets[0].count, 2);
  // Nothing was lost, and nothing more was available to lose.
  assert.equal(result.coverage.complete, true);
});

test('a repeated token ends the walk instead of looping', async () => {
  const { result, fake } = await collect('repeated-token');

  // Page 1 (token loop-token) → page 2 (token loop-token again). Stop, never a third request.
  assert.equal(fake.requests.length, 2);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[1].outcome, OUTCOME.STOP_TOKEN_REPEATED);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.totalJobs, 2);
});

test('an empty page ends the walk and is labelled empty', async () => {
  const { result, fake } = await collect('empty-second-page');

  assert.equal(fake.requests.length, 2);
  assert.equal(result.pages[1].outcome, OUTCOME.EMPTY);
  assert.equal(result.pages[1].jobCount, 0);
  assert.equal(result.pages[1].totalJobs, 1, 'the running total must not move on an empty page');
  assert.equal(result.coverage.complete, true);
});

test('maxPages stops the walk while a token is still available and marks it truncated', async () => {
  const { result, fake } = await collect('two-pages', { maxPages: 1 });

  assert.equal(fake.requests.length, 1);
  assert.equal(result.pages[0].outcome, OUTCOME.STOP_MAX_PAGES);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.pagesPlanned, 1);
});

test('sort and domain are forwarded unchanged on every page', async () => {
  await withFake('two-pages', async (fake) => {
    const { client } = fakeClient(fake.url);
    await collectListings({
      client,
      keyword: 'data engineer',
      location: 'Austin, TX',
      sort: 'recent',
      domain: 'www.glassdoor.co.uk',
    });

    assert.equal(fake.requests.length, 2);
    for (const request of fake.requests) {
      assert.equal(request.args.sort, 'recent');
      assert.equal(request.args.domain, 'www.glassdoor.co.uk');
    }
    assert.equal(fake.requests[1].args.nextPageToken, 'page-2-token');
  });
});

test('an omitted sort and domain are not sent as empty strings', async () => {
  await withFake('two-pages', async (fake) => {
    const { client } = fakeClient(fake.url);
    await collectListings({ client, keyword: 'x', location: 'y' });
    assert.equal(fake.requests[0].args.sort, undefined);
    assert.equal(fake.requests[0].args.domain, undefined);
    assert.equal(fake.requests[1].args.sort, undefined);
    assert.equal(fake.requests[1].args.domain, undefined);
  });
});

test('readNextToken takes only the token for the following page', () => {
  const page = { pagination: { otherPages: { 1: 'a', 2: 'b', 3: 'c' } } };
  // After fetching page 1, the next page is 2.
  assert.equal(readNextToken(page, 1), 'b');
  // After fetching page 2, the next page is 3.
  assert.equal(readNextToken(page, 2), 'c');
  // After fetching page 3 there is no page-4 entry, so there is no token.
  assert.equal(readNextToken(page, 3), null);
  assert.equal(readNextToken({ pagination: { otherPages: {} } }, 1), null);
  assert.equal(readNextToken({}, 1), null);
});

test('maxPages input is clamped to a sane range', () => {
  assert.equal(clampMaxPages(undefined), 5);
  assert.equal(clampMaxPages('3'), 3);
  assert.equal(clampMaxPages('0'), 1);
  assert.equal(clampMaxPages('999'), 50);
  assert.equal(clampMaxPages('nonsense'), 5);
});

// ---------------------------------------------------------------------------------------------
// Failure and retry

test('a rate-limited page is retried and the walk continues when the retry succeeds', async () => {
  const { result, fake, waits } = await collect('rate-limit-then-success');

  assert.equal(result.pages[0].outcome, OUTCOME.STOP_TOKEN_MISSING, 'page one itself succeeded after the retry');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.totalJobs, 1);
  assert.equal(waits.length, 1, 'exactly one retry was needed');
  assert.ok(waits[0] > 0);
  assert.equal(fake.requests.length, 2, 'one throttled request plus one successful retry');
});

test('retries back off increasingly and stop at five, keeping collected pages', async () => {
  const { result, fake, waits } = await collect('always-rate-limited');

  assert.equal(result.pages[0].outcome, OUTCOME.RATE_LIMITED);
  assert.equal(result.coverage.pagesFetched, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.truncated, true);
  assert.equal(fake.requests.length, 6, 'the first attempt plus five retries');
  assert.equal(waits.length, 5);
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] > waits[i - 1], `wait ${i} (${waits[i]}) did not exceed wait ${i - 1} (${waits[i - 1]})`);
  }
});

test('a 401 fails at once with no retry', async () => {
  const { result, fake, waits } = await collect('unauthorized');

  assert.equal(result.pages[0].outcome, OUTCOME.AUTH);
  assert.equal(fake.requests.length, 1, 'a rejected key must not be retried');
  assert.equal(waits.length, 0);
  assert.match(result.pages[0].reason, /401|rejected/i);
  assert.equal(result.coverage.complete, false);
});

// The real server answers a bad key with HTTP 200 and an `isError` result, not an HTTP 401.
// Treating that as a generic tool error would tell a user to raise maxPages when the actual
// problem is a key, so the classification has to read the tool result too.
test('a 401 delivered inside a successful HTTP response still counts as auth and is not retried', async () => {
  const { result, fake, waits } = await collect('unauthorized-in-tool-result');

  assert.equal(result.pages[0].outcome, OUTCOME.AUTH);
  assert.equal(result.pages[0].status, STATUS.AUTH);
  assert.equal(fake.requests.length, 1, 'a rejected key must not be retried');
  assert.equal(waits.length, 0);
});

test('the word "unauthorized" inside posting text does not look like an auth failure', async () => {
  const { result } = await collect('unauthorized-word-in-posting');

  assert.equal(result.pages[0].outcome, OUTCOME.STOP_TOKEN_MISSING);
  assert.equal(result.pages[0].status, STATUS.SUCCESS);
  assert.equal(result.coverage.totalJobs, 1);
  assert.equal(result.coverage.complete, true);
});

test('a failed second page keeps the first page in the report', async () => {
  const { result, fake } = await collect('error-on-second-page');

  assert.equal(fake.requests.length, 2);
  assert.equal(result.pages[0].outcome, OUTCOME.OK);
  assert.equal(result.pages[1].outcome, OUTCOME.ERROR);
  assert.equal(result.coverage.pagesFetched, 1, 'only the successful page counts as collected');
  assert.equal(result.coverage.totalJobs, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.truncated, true);
  // The collected posting still yields a statistic rather than being thrown away.
  assert.equal(result.stats.sets[0].count, 1);
  assert.equal(result.stats.sets[0].median, 100000);
});

// ---------------------------------------------------------------------------------------------
// Salary grouping

test('missing salaries count separately, point figures count once, and hourly stays apart', async () => {
  const { result } = await collect('salary-shapes');

  assert.equal(result.coverage.totalJobs, 5);
  assert.equal(result.stats.noSalary, 1, 'the posting with no salary object is counted as no salary');

  const annual = result.stats.sets.filter((set) => set.period === 'ANNUAL');
  const hourly = result.stats.sets.filter((set) => set.period === 'HOURLY');
  assert.equal(annual.length, 2, 'employer-provided and estimated annual figures are separate sets');
  assert.equal(hourly.length, 1, 'hourly figures form their own set');
  // No set ever mixes annual and hourly.
  for (const set of result.stats.sets) assert.ok(['ANNUAL', 'HOURLY'].includes(set.period));

  const employer = annual.find((set) => set.source === 'EMPLOYER_PROVIDED');
  assert.equal(employer.count, 1);
  assert.equal(employer.low, employer.median);
  assert.equal(employer.median, employer.high);
  assert.equal(employer.singleFigureCount, 1, 'min = median = max is one point figure');

  const estimated = annual.find((set) => set.source === 'ESTIMATED');
  assert.equal(estimated.count, 2);
  assert.equal(estimated.low, 92000);
  assert.equal(estimated.median, 98500, 'the midpoint of the two estimates, and nothing else');
  assert.equal(estimated.high, 105000);

  const hourlySet = hourly[0];
  assert.equal(hourlySet.count, 1);
  assert.equal(hourlySet.median, 35);
  assert.equal(hourlySet.currency, 'USD');
});

test('groupSalaries never averages across sources or periods', () => {
  const jobs = [
    normalizeJob({ id: 1, salary: { min: 100, median: 100, max: 100, period: 'HOURLY', currency: 'USD', source: 'EMPLOYER_PROVIDED' } }),
    normalizeJob({ id: 2, salary: { min: 200000, median: 200000, max: 200000, period: 'ANNUAL', currency: 'USD', source: 'ESTIMATED' } }),
  ];
  const stats = groupSalaries(jobs);
  assert.equal(stats.sets.length, 2);
  assert.equal(stats.noSalary, 0);
  const combined = stats.sets.map((set) => set.median).sort((a, b) => a - b);
  assert.deepEqual(combined, [100, 200000]);
});

test('a posting with a salary object but no numbers counts as no salary', () => {
  const job = normalizeJob({ id: 1, salary: { currency: 'USD', period: 'ANNUAL', source: 'EMPLOYER_PROVIDED' } });
  assert.equal(job.hasSalary, false);
  const stats = groupSalaries([job]);
  assert.equal(stats.noSalary, 1);
  assert.equal(stats.sets.length, 0);
});

test('employers are named at both ends of a set', () => {
  const jobs = [90000, 100000, 120000, 130000].map((amount, index) =>
    normalizeJob({
      id: index + 1,
      employer: { name: `Co${index}`, rating: 3.5 },
      ageInDays: index,
      salary: { min: amount, median: amount, max: amount, period: 'ANNUAL', currency: 'USD', source: 'EMPLOYER_PROVIDED' },
    }));
  const stats = groupSalaries(jobs);
  const set = stats.sets[0];
  assert.equal(set.employers.top[0].company, 'Co3');
  assert.equal(set.employers.top[0].amount, 130000);
  assert.equal(set.employers.bottom[0].company, 'Co0');
  assert.equal(set.employers.bottom[0].amount, 90000);
});

// ---------------------------------------------------------------------------------------------
// Command line

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HASDATA_API_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the CLI reports both pages and the credit cost', async () => {
  await withFake('two-pages', async (fake) => {
    const { code, stdout, stderr } = await runCli([
      '--keyword', 'data engineer', '--location', 'Austin, TX', '--endpoint', fake.url,
    ]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /page 1: success/);
    assert.match(stdout, /page 2: success, no next-page token/);
    assert.match(stdout, /3 posting\(s\)/);
    assert.match(stdout, /complete for this query/);
    assert.match(stdout, /2 successful page\(s\) × 10 credits = 20 credits/);
    assert.match(stdout, /employer-provided · annual/);
    assert.match(stdout, /Paying most/);
  });
});

test('the CLI exits non-zero when coverage is incomplete but still prints the statistics', async () => {
  await withFake('repeated-token', async (fake) => {
    const { code, stdout } = await runCli([
      '--keyword', 'data engineer', '--location', 'Austin, TX', '--endpoint', fake.url,
    ]);
    assert.equal(code, 1);
    assert.match(stdout, /INCOMPLETE/);
    assert.match(stdout, /next-page token repeats an earlier one/);
    assert.match(stdout, /Median/);
  });
});

test('the CLI prints an hourly set apart from the annual one', async () => {
  await withFake('salary-shapes', async (fake) => {
    const { code, stdout, stderr } = await runCli([
      '--keyword', 'data engineer', '--location', 'Austin, TX', '--endpoint', fake.url,
    ]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /hourly · USD/);
    assert.match(stdout, /35 USD\/hr/);
    assert.match(stdout, /No salary at all: 1/);
    assert.match(stdout, /Glassdoor estimate` entries|Glassdoor estimate/);
  });
});

test('the CLI emits machine-readable JSON on request', async () => {
  await withFake('two-pages', async (fake) => {
    const { code, stdout } = await runCli([
      '--keyword', 'data engineer', '--location', 'Austin, TX', '--endpoint', fake.url, '--json',
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.coverage.totalJobs, 3);
    assert.equal(parsed.coverage.complete, true);
    assert.equal(parsed.pages.length, 2);
    assert.equal(parsed.stats.sets[0].median, 100000);
  });
});

test('the CLI rejects a bad sort value and a missing keyword without calling the server', async () => {
  await withFake('two-pages', async (fake) => {
    const badSort = await runCli([
      '--keyword', 'x', '--location', 'y', '--sort', 'oldest', '--endpoint', fake.url,
    ]);
    assert.equal(badSort.code, 2);
    assert.match(badSort.stderr, /--sort/);

    const missing = await runCli(['--location', 'y', '--endpoint', fake.url]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Missing --keyword/);

    const badPages = await runCli([
      '--keyword', 'x', '--location', 'y', '--max-pages', '0', '--endpoint', fake.url,
    ]);
    assert.equal(badPages.code, 2);
    assert.match(badPages.stderr, /max-pages/);

    assert.equal(fake.requests.length, 0);
  });
});

test('the CLI refuses to walk the hosted endpoint without a key', async () => {
  const { code, stderr } = await runCli(['--keyword', 'x', '--location', 'y']);
  assert.equal(code, 2);
  assert.match(stderr, /HASDATA_API_KEY/);
});
