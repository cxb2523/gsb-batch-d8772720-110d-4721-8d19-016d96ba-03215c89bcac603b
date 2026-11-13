// Resumable, auditable review-pagination jobs.
//
// One run of runReviewJob() walks the whole review feed of one Yelp business and produces
// a plain-data Job object that can be serialised to disk after every page. A later run of
// resumeReviewJob() reads that object back and asks only for pages that never succeeded:
// cursors are always taken verbatim from the previous response and never recomputed.
//
// Nothing here touches the network directly. The transport (callToolWithRetry) and the
// clock are injected, so the whole state machine runs offline in tests and examples.

import { callToolWithRetry, HASDATA_YELP_ENDPOINT, REVIEWS_TOOL, RemoteCallError } from './jsonrpc.mjs';

export const JobStatus = Object.freeze({
    RUNNING: 'running',
    COMPLETED: 'completed',
    PARTIAL: 'partial',
    FAILED: 'failed',
});

export class MissingApiKeyError extends Error {
    constructor() {
        super('HASDATA_API_KEY is not set; refusing to start a review job without a key');
        this.name = 'MissingApiKeyError';
    }
}

const SORTS = new Set(['relevanceDesc', 'dateDesc', 'dateAsc', 'ratingDesc', 'ratingAsc', 'elitesDesc']);
export const MAX_PAGE_SIZE = 49;

export function createJob(params = {}) {
    return {
        schemaVersion: 1,
        jobId: params.jobId ?? 'review-job',
        status: JobStatus.RUNNING,
        params: {
            placeId: params.placeId,
            domain: params.domain,
            sortBy: params.sortBy,
            rating: params.rating,
            languageCode: params.languageCode,
            num: params.num ?? MAX_PAGE_SIZE,
            notRecommended: params.notRecommended,
            query: params.query,
        },
        endpoint: params.endpoint ?? HASDATA_YELP_ENDPOINT,
        // The cursor to send on the NEXT request. Null means "first page"; after a
        // successful final page it stays null while hasNextPage is false.
        nextCursor: null,
        // The cursor that produced the most recent successful page, retained for audit.
        lastUsedCursor: null,
        totalCollected: 0,
        pages: [],
        reviews: [],
        error: null,
        warnings: [],
        startedAt: params.startedAt ?? new Date().toISOString(),
        updatedAt: params.startedAt ?? new Date().toISOString(),
        finishedAt: null,
    };
}

// Only include arguments the caller actually supplied; the remote tool applies its own
// defaults otherwise. nextPageToken, when present, is forwarded verbatim.
function buildArgs(job, cursor) {
    const { placeId, domain, sortBy, rating, languageCode, num, notRecommended, query } = job.params;
    const args = { placeId, num };
    if (domain !== undefined) args.domain = domain;
    if (sortBy !== undefined) args.sortBy = sortBy;
    if (rating !== undefined) args.rating = rating;
    if (languageCode !== undefined) args.languageCode = languageCode;
    if (notRecommended !== undefined) args.notRecommended = notRecommended;
    if (query !== undefined) args.query = query;
    if (cursor) args.nextPageToken = cursor;
    return args;
}

function validateOptions(options) {
    if (!options || typeof options.placeId !== 'string' || !options.placeId.trim()) {
        throw new TypeError('placeId (Yelp ID or alias) is required');
    }
    if (options.num !== undefined && (!Number.isInteger(options.num) || options.num < 1 || options.num > MAX_PAGE_SIZE)) {
        throw new RangeError(`num must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    if (options.sortBy !== undefined && !SORTS.has(options.sortBy)) {
        throw new RangeError(`sortBy must be one of: ${[...SORTS].join(', ')}`);
    }
}

function describeError(error) {
    if (error instanceof RemoteCallError) {
        return {
            name: error.name,
            reason: error.reason,
            message: error.message,
            retryable: error.retryable,
            statusCode: error.statusCode,
            retryAfterMs: error.retryAfterMs,
            details: error.details ?? null,
        };
    }
    return { name: error.name ?? 'Error', reason: 'unexpected', message: String(error?.message ?? error) };
}

/**
 * Walk a review feed until hasNextPage is false, a page permanently fails, or maxPages is
 * reached. `onPage(job, pageRecord)` fires after every page, successful or failed, which
 * is the natural point for a caller to persist the job.
 */
export async function runReviewJob(options = {}) {
    validateOptions(options);

    // Checked before any network machinery is touched: a missing key must fail locally.
    const apiKey = options.apiKey ?? process?.env?.HASDATA_API_KEY;
    if (!apiKey) throw new MissingApiKeyError();

    const job = createJob(options);
    const callToolWithRetryImpl = options.callToolWithRetry ?? callToolWithRetry;
    const retry = options.retry ?? { maxAttempts: 4, baseDelayMs: 2000 };
    const fetchImpl = options.fetch;
    const sleep = options.sleep;
    const onPage = options.onPage ?? (() => {});
    const maxPages = options.maxPages ?? Infinity;

    // A page that permanently fails ends the loop. When that happens on page 1 the job is
    // a hard failure with no reviews; on any later page the already collected reviews are
    // kept and the job is only partially complete.
    let fatal = false;

    while (job.status === JobStatus.RUNNING && !fatal && job.pages.length < maxPages) {
        const pageNumber = job.pages.length + 1;
        const requestedCursor = job.nextCursor ?? null;
        let payload;
        let attempts = 1;
        try {
            const result = await callToolWithRetryImpl(
                {
                    endpoint: job.endpoint,
                    apiKey,
                    toolName: REVIEWS_TOOL,
                    args: buildArgs(job, requestedCursor),
                    id: pageNumber * 1000,
                    fetchImpl,
                    timeoutMs: options.timeoutMs,
                },
                retry,
                sleep
            );
            // Accept either the documented { payload, attempts } shape or a bare payload,
            // so a hand-written test double stays trivial.
            if (result && Object.prototype.hasOwnProperty.call(result, 'payload')) {
                payload = result.payload;
                attempts = result.attempts ?? 1;
            } else {
                payload = result;
            }
        } catch (error) {
            attempts = error.attempts ?? attempts;
            const record = {
                page: pageNumber,
                status: 'failed',
                requestedCursor,
                nextCursor: null,
                pageCount: 0,
                cumulativeCount: job.totalCollected,
                hasNextPage: null,
                attempts,
                error: describeError(error),
                fetchedAt: new Date().toISOString(),
            };
            job.pages.push(record);
            job.error = record.error;
            job.status = pageNumber === 1 ? JobStatus.FAILED : JobStatus.PARTIAL;
            job.updatedAt = new Date().toISOString();
            job.finishedAt = new Date().toISOString();
            await onPage(job, record);
            fatal = true;
            break;
        }

        const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
        const pagination = payload.pagination ?? {};
        const hasNextPage = pagination.hasNextPage === true;
        // The token is opaque. We store it exactly as received and send it back exactly;
        // offsets are never derived from page numbers or counts.
        const nextCursor = hasNextPage ? pagination.nextPageToken ?? null : null;

        if (hasNextPage && !nextCursor) {
            job.warnings.push(
                `page ${pageNumber} reported hasNextPage=true but no nextPageToken; stopping to avoid an infinite loop`
            );
        }

        const record = {
            page: pageNumber,
            status: 'success',
            requestedCursor,
            nextCursor,
            pageCount: reviews.length,
            cumulativeCount: job.totalCollected + reviews.length,
            hasNextPage,
            attempts,
            error: null,
            fetchedAt: new Date().toISOString(),
        };

        job.pages.push(record);
        job.reviews.push(...reviews);
        job.totalCollected = job.reviews.length;
        job.lastUsedCursor = requestedCursor;
        job.nextCursor = nextCursor;
        job.updatedAt = new Date().toISOString();

        // Settle the terminal status before the page callback fires, so a job persisted
        // inside onPage is never left looking like it is still running.
        if (!hasNextPage || !nextCursor) {
            job.status = JobStatus.COMPLETED;
            job.finishedAt = new Date().toISOString();
        } else if (job.pages.length >= maxPages) {
            job.warnings.push(`stopped at maxPages=${maxPages}; resume with the saved cursor to continue`);
            // The feed still has pages: partial, so a later resumeReviewJob keeps walking.
            job.status = JobStatus.PARTIAL;
            job.finishedAt = new Date().toISOString();
        }

        await onPage(job, record);

        if (job.status !== JobStatus.RUNNING) break;
    }

    return job;
}

/**
 * Continue a previously saved job. Successful pages are never re-requested: the first
 * request reuses the saved nextCursor verbatim. A job that already completed is returned
 * untouched.
 */
export async function resumeReviewJob(options = {}) {
    const saved = options.job;
    if (!saved || !Array.isArray(saved.pages) || !saved.params) {
        throw new TypeError('resumeReviewJob needs a previously saved job object');
    }
    const apiKey = options.apiKey ?? process?.env?.HASDATA_API_KEY;
    if (!apiKey) throw new MissingApiKeyError();

    if (saved.status === JobStatus.COMPLETED) return saved;

    const job = structuredClone(saved);
    job.status = JobStatus.RUNNING;
    job.error = null;
    job.finishedAt = null;
    // An explicit endpoint (e.g. a test double or a compatible gateway) overrides the one
    // stored when the job was first created.
    if (options.endpoint) job.endpoint = options.endpoint;

    // Drop the trailing failed page record so the page numbering stays contiguous; its
    // error is preserved in failureHistory, which records every failure seen so far.
    job.failureHistory ??= [];
    const last = job.pages[job.pages.length - 1];
    if (last && last.status === 'failed') {
        job.failureHistory.push(last);
        job.pages.pop();
        job.totalCollected = job.reviews.length;
    }

    const callToolWithRetryImpl = options.callToolWithRetry ?? callToolWithRetry;
    const retry = options.retry ?? { maxAttempts: 4, baseDelayMs: 2000 };
    const fetchImpl = options.fetch;
    const sleep = options.sleep;
    const onPage = options.onPage ?? (() => {});
    const maxPages = options.maxPages ?? Infinity;
    let fatal = false;

    while (job.status === JobStatus.RUNNING && !fatal && job.pages.length < maxPages) {
        const pageNumber = job.pages.length + 1;
        const requestedCursor = job.nextCursor ?? null;
        let payload;
        let attempts = 1;
        try {
            const result = await callToolWithRetryImpl(
                {
                    endpoint: job.endpoint,
                    apiKey,
                    toolName: REVIEWS_TOOL,
                    args: buildArgs(job, requestedCursor),
                    id: pageNumber * 1000,
                    fetchImpl,
                    timeoutMs: options.timeoutMs,
                },
                retry,
                sleep
            );
            if (result && Object.prototype.hasOwnProperty.call(result, 'payload')) {
                payload = result.payload;
                attempts = result.attempts ?? 1;
            } else {
                payload = result;
            }
        } catch (error) {
            attempts = error.attempts ?? attempts;
            const record = {
                page: pageNumber,
                status: 'failed',
                requestedCursor,
                nextCursor: null,
                pageCount: 0,
                cumulativeCount: job.totalCollected,
                hasNextPage: null,
                attempts,
                error: describeError(error),
                fetchedAt: new Date().toISOString(),
            };
            job.pages.push(record);
            job.error = record.error;
            job.status = JobStatus.PARTIAL;
            job.updatedAt = new Date().toISOString();
            job.finishedAt = new Date().toISOString();
            await onPage(job, record);
            fatal = true;
            break;
        }

        const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
        const pagination = payload.pagination ?? {};
        const hasNextPage = pagination.hasNextPage === true;
        const nextCursor = hasNextPage ? pagination.nextPageToken ?? null : null;

        if (hasNextPage && !nextCursor) {
            job.warnings.push(
                `page ${pageNumber} reported hasNextPage=true but no nextPageToken; stopping to avoid an infinite loop`
            );
        }

        const record = {
            page: pageNumber,
            status: 'success',
            requestedCursor,
            nextCursor,
            pageCount: reviews.length,
            cumulativeCount: job.totalCollected + reviews.length,
            hasNextPage,
            attempts,
            error: null,
            fetchedAt: new Date().toISOString(),
        };

        job.pages.push(record);
        job.reviews.push(...reviews);
        job.totalCollected = job.reviews.length;
        job.lastUsedCursor = requestedCursor;
        job.nextCursor = nextCursor;
        job.updatedAt = new Date().toISOString();

        // Settle the terminal status before the page callback fires, so a job persisted
        // inside onPage is never left looking like it is still running.
        if (!hasNextPage || !nextCursor) {
            job.status = JobStatus.COMPLETED;
            job.finishedAt = new Date().toISOString();
        } else if (job.pages.length >= maxPages) {
            job.warnings.push(`stopped at maxPages=${maxPages}; resume with the saved cursor to continue`);
            // The feed still has pages: partial, so a later resumeReviewJob keeps walking.
            job.status = JobStatus.PARTIAL;
            job.finishedAt = new Date().toISOString();
        }

        await onPage(job, record);

        if (job.status !== JobStatus.RUNNING) break;
    }

    return job;
}
