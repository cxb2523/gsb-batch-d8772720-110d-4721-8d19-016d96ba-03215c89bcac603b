// Paginated listing collection and salary aggregation for /salary-benchmark.
//
// Rules this module enforces, because a benchmark that quietly stops at page one is worse than
// no benchmark at all:
//   * Page one is requested with keyword/location/sort/domain and no token. Every later page
//     is requested with the token taken from the previous page's `pagination.otherPages`, and
//     the other parameters stay exactly as they were. No page number is ever synthesised.
//   * Paging stops when the token is missing, when a token repeats one already used, when a
//     page comes back empty, or when maxPages is reached. Each stop is recorded with a reason.
//   * A page failure never discards pages already collected. If a page fails, its outcome is
//     recorded and paging stops; the statistics over what was collected are still returned.
//   * `salary.source` splits employer-provided figures from Glassdoor estimates.
//   * A missing salary counts as "no salary", not as zero and not as an error.
//   * min = median = max is a single point figure.
//   * HOURLY and ANNUAL never mix: each period is its own group.

export const SALARY_SOURCES = ['EMPLOYER_PROVIDED', 'ESTIMATED'];
export const SALARY_PERIODS = ['ANNUAL', 'HOURLY', 'MONTHLY'];
export const LISTING_TOOL = 'hasdata_glassdoor_listing_getJobListings';

export const DEFAULT_MAX_PAGES = 5;
export const MAX_MAX_PAGES = 50;

// How a single page ended. `reason` narrows a stop or a failure to the exact condition the
// brief asks to be reported.
export const OUTCOME = {
  OK: 'ok',
  EMPTY: 'empty',
  STOP_TOKEN_MISSING: 'stop_token_missing',
  STOP_TOKEN_REPEATED: 'stop_token_repeated',
  STOP_MAX_PAGES: 'stop_max_pages',
  RATE_LIMITED: 'rate_limited',
  AUTH: 'auth',
  ERROR: 'error',
};

// The four page statuses a reader needs: the page delivered postings, delivered none, was
// abandoned after retries, or failed another way. `status` is that coarse answer; `outcome`
// and `stopReason` carry the detail.
export const STATUS = {
  SUCCESS: 'success',
  EMPTY: 'empty',
  RATE_LIMITED: 'rate_limited',
  AUTH: 'auth',
  ERROR: 'error',
};

// The token to use for the next page. `pagination.otherPages` maps a page number to an opaque
// token. Given the page just fetched (1-based), the next page is the one at index page + 1.
// Only a token the server actually returned for that page is accepted: nothing is guessed,
// and a mapping with no entry for the next page means the listing ends there.
export function readNextToken(payload, pageIndex) {
  const pagination = payload?.pagination;
  if (!pagination || typeof pagination !== 'object') return null;

  const otherPages = pagination.otherPages;
  if (!otherPages || typeof otherPages !== 'object') return null;

  const entry = otherPages[String(pageIndex + 1)];
  // A deployment may wrap the token, but the key still has to name the next page.
  const candidate = typeof entry === 'string' ? entry : entry && typeof entry.token === 'string' ? entry.token : null;
  if (candidate === null) return null;
  const trimmed = candidate.trim();
  return trimmed || null;
}

export function normalizeJob(rawJob) {
  const salary = rawJob && typeof rawJob.salary === 'object' && rawJob.salary ? rawJob.salary : null;
  const employer = rawJob && typeof rawJob.employer === 'object' && rawJob.employer ? rawJob.employer : null;
  const normalizedSalary = {
    min: finiteOrNull(salary?.min),
    median: finiteOrNull(salary?.median),
    max: finiteOrNull(salary?.max),
    currency: salary?.currency ?? salary?.payCurrency ?? null,
    period: typeof salary?.period === 'string' ? salary.period.toUpperCase() : null,
    source: typeof salary?.source === 'string' ? salary.source.toUpperCase() : null,
  };
  return {
    id: rawJob?.id ?? rawJob?.jobId ?? null,
    title: rawJob?.title ?? '',
    company: employer?.name ?? employer?.shortName ?? rawJob?.company ?? '',
    rating: typeof employer?.rating === 'number' ? employer.rating : null,
    ageInDays: typeof rawJob?.ageInDays === 'number' ? rawJob.ageInDays : null,
    url: rawJob?.url ?? null,
    salary: normalizedSalary,
    // A salary object with no usable number is the same as no salary. Using the same point
    // rule as the aggregation keeps the counts consistent with the groups.
    hasSalary: Boolean(salary) && salaryPoint(normalizedSalary) !== null,
  };
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// One usable salary point: the median when there is one, otherwise the middle of min/max,
// and a lone min or max when that is all the posting states. `isPoint` marks a single stated
// figure (min = median = max), which is one point rather than a range of zero. Returns null
// when the object carries no usable number.
export function salaryPoint(salary) {
  if (!salary) return null;
  const { min, median, max } = salary;
  if (median !== null) return { value: median, isPoint: min !== null && min === median && max === median };
  if (min !== null && max !== null) return { value: (min + max) / 2, isPoint: min === max };
  if (min !== null) return { value: min, isPoint: false };
  if (max !== null) return { value: max, isPoint: false };
  return null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Group by source × period × currency. A group with a single currency is a salary set that can
// carry a low/median/high; currencies are never converted or averaged together.
export function groupSalaries(jobs) {
  const groups = new Map();
  let noSalary = 0;
  let unclassified = 0;

  for (const job of jobs) {
    if (!job.hasSalary) {
      noSalary += 1;
      continue;
    }
    const point = salaryPoint(job.salary);
    if (!point) {
      noSalary += 1;
      continue;
    }
    const source = job.salary.source;
    if (!SALARY_SOURCES.includes(source)) {
      // An undocumented source cannot be attributed to either set, so it is reported on its
      // own rather than folded into one.
      unclassified += 1;
    }
    const period = job.salary.period ?? 'UNKNOWN';
    const currency = job.salary.currency ?? 'UNKNOWN';
    const key = `${source ?? 'UNKNOWN'}|${period}|${currency}`;
    if (!groups.has(key)) {
      groups.set(key, { source: source ?? 'UNKNOWN', period, currency, jobs: [] });
    }
    groups.get(key).jobs.push({ ...job, point: point.value, isPoint: point.isPoint });
  }

  const sets = [...groups.values()].map((group) => {
    const values = group.jobs.map((job) => job.point);
    return {
      source: group.source,
      period: group.period,
      currency: group.currency,
      count: values.length,
      low: values.length ? Math.min(...values) : null,
      median: median(values),
      high: values.length ? Math.max(...values) : null,
      singleFigureCount: group.jobs.filter((job) => job.isPoint).length,
      employers: highAndLow(group.jobs),
    };
  });

  const rank = (list, value) => {
    const index = list.indexOf(value);
    return index === -1 ? list.length : index;
  };
  const order = (a, b) =>
    rank(SALARY_PERIODS, a.period) - rank(SALARY_PERIODS, b.period)
    || rank(SALARY_SOURCES, a.source) - rank(SALARY_SOURCES, b.source)
    || a.currency.localeCompare(b.currency);

  return { sets: sets.sort(order), noSalary, unclassified };
}

function employerEntry(job, amount) {
  return {
    company: job.company,
    title: job.title,
    rating: job.rating,
    ageInDays: job.ageInDays,
    amount,
    source: job.salary.source,
    period: job.salary.period,
    currency: job.salary.currency,
    url: job.url,
  };
}

// Named top and bottom employers, deduplicated by company. A company that appears twice only
// contributes its strongest figure to the top list and its weakest to the bottom one.
function highAndLow(jobs, limit = 5) {
  const byCompany = new Map();
  for (const job of jobs) {
    const key = job.company || job.url || String(job.id);
    const current = byCompany.get(key);
    if (!current) {
      byCompany.set(key, { best: job, worst: job });
      continue;
    }
    if (job.point > current.best.point) current.best = job;
    if (job.point < current.worst.point) current.worst = job;
  }

  const ranked = [...byCompany.values()];
  const top = ranked
    .map((entry) => employerEntry(entry.best, entry.best.point))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
  const bottom = ranked
    .map((entry) => employerEntry(entry.worst, entry.worst.point))
    .sort((a, b) => a.amount - b.amount)
    .slice(0, limit);
  return { top, bottom };
}

function pageOutcomeFromFailure(failure) {
  if (failure.kind === 'rate_limited') return OUTCOME.RATE_LIMITED;
  if (failure.kind === 'auth') return OUTCOME.AUTH;
  return OUTCOME.ERROR;
}

const FAILURE_STATUS = {
  [OUTCOME.RATE_LIMITED]: STATUS.RATE_LIMITED,
  [OUTCOME.AUTH]: STATUS.AUTH,
  [OUTCOME.ERROR]: STATUS.ERROR,
};

/**
 * Walk pages until one of the stop conditions, recording every page's ending.
 *
 * @param {object} options
 * @param {{ callTool: Function }} options.client
 * @param {string} options.keyword
 * @param {string} options.location
 * @param {string} [options.sort]
 * @param {string} [options.domain]
 * @param {number} [options.maxPages]
 * @param {Function} [options.onPage]
 */
export async function collectListings({ client, keyword, location, sort, domain, maxPages = DEFAULT_MAX_PAGES, onPage } = {}) {
  if (typeof client?.callTool !== 'function') throw new TypeError('a client is required');
  if (!keyword || !location) throw new TypeError('keyword and location are required');

  const pageLimit = clampMaxPages(maxPages);
  const baseArgs = { keyword, location };
  if (sort) baseArgs.sort = sort;
  if (domain) baseArgs.domain = domain;

  const pages = [];
  const jobs = [];
  const seenTokens = new Set();
  let nextToken = null;
  let pagesFetched = 0;
  let stopReason = null;

  for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex++) {
    const args = pageIndex === 1 ? { ...baseArgs } : { ...baseArgs, nextPageToken: nextToken };
    const requestedToken = args.nextPageToken ?? null;

    const response = await client.callTool(LISTING_TOOL, args);

    if (!response.ok) {
      const outcome = pageOutcomeFromFailure(response);
      const record = {
        page: pageIndex,
        status: FAILURE_STATUS[outcome] ?? STATUS.ERROR,
        outcome,
        reason: response.message,
        stopReason: outcome,
        requestedToken,
        returnedToken: null,
        jobCount: 0,
        totalJobs: jobs.length,
        jobs: [],
      };
      pages.push(record);
      onPage?.(record);
      stopReason = outcome;
      break;
    }

    const payloadJobs = Array.isArray(response.data?.jobs) ? response.data.jobs : [];
    const normalized = payloadJobs.map(normalizeJob);
    jobs.push(...normalized);

    const token = readNextToken(response.data, pageIndex);
    const repeated = token !== null && seenTokens.has(token);

    // `outcome` is the page's own result; `stopReason` says whether the walk continues after
    // it. A page can succeed and still be the last one, which is why they are separate fields:
    // a missing token and a repeated token are both successful pages in a failed walk.
    let outcome;
    let reason;
    let pageStop = null;
    if (!normalized.length) {
      outcome = OUTCOME.EMPTY;
      reason = `page ${pageIndex} returned no jobs`;
      pageStop = OUTCOME.EMPTY;
    } else if (token === null) {
      outcome = OUTCOME.STOP_TOKEN_MISSING;
      reason = 'pagination.otherPages carried no token for the next page';
      pageStop = OUTCOME.STOP_TOKEN_MISSING;
    } else if (repeated) {
      outcome = OUTCOME.STOP_TOKEN_REPEATED;
      reason = 'the next-page token has already been used';
      pageStop = OUTCOME.STOP_TOKEN_REPEATED;
    } else if (pageIndex === pageLimit) {
      outcome = OUTCOME.STOP_MAX_PAGES;
      reason = `maxPages (${pageLimit}) reached while a next-page token was still available`;
      pageStop = OUTCOME.STOP_MAX_PAGES;
    } else {
      outcome = OUTCOME.OK;
      reason = null;
    }

    const record = {
      page: pageIndex,
      // A page that delivered postings succeeded, whatever the walk does next.
      status: normalized.length ? STATUS.SUCCESS : STATUS.EMPTY,
      outcome,
      reason,
      stopReason: pageStop,
      requestedToken,
      returnedToken: token,
      jobCount: normalized.length,
      totalJobs: jobs.length,
      jobs: normalized,
    };
    pages.push(record);
    onPage?.(record);
    pagesFetched += 1;

    if (outcome !== OUTCOME.OK) {
      stopReason = outcome;
      break;
    }

    seenTokens.add(token);
    nextToken = token;
  }

  const stats = groupSalaries(jobs);
  // The natural end is an empty page or a page that offered no token. Anything else means the
  // walk stopped before the end of the listing, so the statistics cover part of the market.
  const naturalEnd = stopReason === OUTCOME.EMPTY || stopReason === OUTCOME.STOP_TOKEN_MISSING;
  const complete = naturalEnd;

  return {
    query: { keyword, location, sort: sort ?? null, domain: domain ?? null, maxPages: pageLimit },
    pages,
    jobs,
    stats,
    coverage: {
      pagesFetched,
      pagesPlanned: pageLimit,
      totalJobs: jobs.length,
      complete,
      stopReason,
      // `truncated` is the complement of `complete`: something the listing still offered was
      // not collected, whatever the cause.
      truncated: !complete,
    },
  };
}

export function clampMaxPages(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PAGES;
  return Math.min(Math.max(parsed, 1), MAX_MAX_PAGES);
}
