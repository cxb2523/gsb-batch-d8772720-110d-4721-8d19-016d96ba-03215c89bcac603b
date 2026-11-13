// Local batch orchestration for the HasData scrape tool.
//
// Given a list of page requests it calls one scrape function per request, strictly in input
// order and one at a time (the free plan allows a single concurrent request), and returns an
// outcome list of the same length and order. The three "nothing came back" situations are
// kept apart because their remedies differ:
//
//   blocked     - the target page itself answered 403/404; the API call succeeded and was billed
//   unreachable - the managed proxy never connected to the target (proxyConnection / HTTP 400)
//   failed      - anything else that went wrong, including a 429 once retries are exhausted
//
// The scrape call is injected: production code passes createRemoteScraper(), tests pass a
// fake that returns scripted per-page responses. No test here needs an API key or network.

import { createRemoteScraper } from './remote-scraper.mjs';
import {
    OUTCOME,
    ScrapeToolError,
    classifyError,
    classifyPayload,
    findMissingFields,
    isRetryableError,
    noLandingNotes,
} from './scrape-errors.mjs';

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with deterministic jitter. `attempt` is zero-based: the first retry
// waits roughly one base delay, the last can be capped. Jitter is derived from the attempt
// and url rather than Math.random so behaviour stays reproducible in tests that inject a
// fake sleep.
export function backoffDelay(attempt, {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}, url = '') {
    const exponential = baseDelayMs * 2 ** attempt;
    let hash = 0;
    for (const ch of String(url)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const jitter = hash % Math.max(1, Math.floor(baseDelayMs / 2));
    return Math.min(maxDelayMs, exponential + jitter);
}

function failureOutcome(request, error, context) {
    const { outcome, statusCode } = classifyError(error);
    const notes = [];
    if (context.attempts > 1) {
        notes.push(
            `retried ${context.attempts - 1} time(s) after rate/concurrency limits; ` +
            `gave up after ${context.attempts} attempt(s): ${error.message}`,
        );
    } else {
        notes.push(error.message);
    }
    notes.push(...noLandingNotes(request));
    return {
        url: request.url,
        outcome,
        statusCode,
        missingFields: [],
        notes,
        attempts: context.attempts,
        payload: null,
    };
}

function payloadOutcome(request, payload, attempts) {
    const { outcome, statusCode } = classifyPayload(payload);
    const notes = [];
    const missingFields = findMissingFields(request.extractRules, payload);
    if (missingFields.length) {
        notes.push(
            `extractRules field(s) matched nothing and were left null: ${missingFields.join(', ')}`,
        );
    }
    if (outcome === OUTCOME.BLOCKED) {
        notes.push(`the target page answered ${statusCode}; the call succeeded but no content was scraped`);
    }
    if (attempts > 1) {
        notes.push(`succeeded after ${attempts - 1} retry attempt(s) following rate/concurrency limits`);
    }
    notes.push(...noLandingNotes(request));
    return {
        url: request.url,
        outcome,
        statusCode,
        missingFields,
        notes,
        attempts,
        payload,
    };
}

// Run one request through the injected scrape function with backoff retries limited to the
// rate-limit / concurrency-limit family of errors.
async function runOne(request, scrape, options) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const doSleep = options.sleep ?? sleep;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const payload = await scrape(request);
            return payloadOutcome(request, payload, attempt + 1);
        } catch (error) {
            lastError = error instanceof Error ? error : new ScrapeToolError(String(error));
            if (!isRetryableError(lastError) || attempt === maxRetries) {
                return failureOutcome(request, lastError, { attempts: attempt + 1 });
            }
            const delay = backoffDelay(attempt, options, request.url);
            await doSleep(delay);
        }
    }
    // Unreachable in practice: the loop always returns on the final attempt.
    return failureOutcome(request, lastError ?? new ScrapeToolError('unknown failure'), {
        attempts: maxRetries + 1,
    });
}

// Orchestrate a batch. Sequential on purpose - the free tier has concurrency 1 - and fully
// isolated per page: a throw that is not even a ScrapeToolError becomes a `failed` outcome
// instead of tearing down the whole run.
export async function batchScrape(requests, options = {}) {
    if (!Array.isArray(requests)) {
        throw new TypeError('batchScrape expects an array of page requests');
    }
    const scrape = options.scrape ?? createRemoteScraper(options);
    const outcomes = [];
    for (const request of requests) {
        if (!request || typeof request !== 'object' || typeof request.url !== 'string' || !request.url) {
            outcomes.push({
                url: request?.url ?? null,
                outcome: OUTCOME.FAILED,
                statusCode: null,
                missingFields: [],
                notes: ['invalid request entry: every entry must be an object with a non-empty url string'],
                attempts: 0,
                payload: null,
            });
            continue;
        }
        try {
            outcomes.push(await runOne(request, scrape, options));
        } catch (error) {
            // Last-resort guard so one page can never break the equal-length guarantee.
            outcomes.push({
                url: request.url,
                outcome: OUTCOME.FAILED,
                statusCode: null,
                missingFields: [],
                notes: [`unexpected orchestrator error: ${error?.message ?? error}`, ...noLandingNotes(request)],
                attempts: 0,
                payload: null,
            });
        }
    }
    return outcomes;
}

export { OUTCOME, ScrapeToolError };
