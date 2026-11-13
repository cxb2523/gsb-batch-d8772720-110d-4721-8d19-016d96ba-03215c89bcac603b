// Outcome vocabulary and pure classification helpers shared by the orchestrator and the
// remote adapter. Keeping these free of I/O means every failure-path rule is unit-testable
// with plain objects instead of a live MCP connection.

export const TOOL_NAME = 'hasdata_web_scraping_web_scraping_scrapeWebPage';

export const OUTCOME = Object.freeze({
    SUCCESS: 'success',
    BLOCKED: 'blocked',
    UNREACHABLE: 'unreachable',
    FAILED: 'failed',
});

// Target-page statuses that count as a *successful call* with an empty body rather than an
// infrastructure failure. The README is explicit: a 404/403 is billed and must be checked
// before parsing the body.
const BLOCKED_STATUSES = new Set([403, 404]);

// The MCP transport answers 400 when the managed proxy never opened a connection to the
// target. It is the HTTP-status twin of an errorType: "proxyConnection" payload.
const UNREACHABLE_STATUSES = new Set([400]);

// Error shape raised by every injected scrape call. The remote adapter converts transport,
// JSON-RPC and tool-level failures into this so the orchestrator only has one shape to match
// on; fakes in tests throw it directly.
export class ScrapeToolError extends Error {
    constructor(message, {
        errorType = null,
        statusCode = null,
        retryable = false,
        cause = undefined,
    } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'ScrapeToolError';
        this.errorType = errorType;
        this.statusCode = statusCode;
        this.retryable = retryable;
    }
}

export function normalizeFormats(outputFormat) {
    if (outputFormat === undefined || outputFormat === null) return [];
    return Array.isArray(outputFormat) ? [...outputFormat] : [outputFormat];
}

// A response carries its target status either as a top-level `status` (single non-json
// format) or as json.statusCode (json requested). Prefer the json location.
export function statusCodeOf(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const candidate = payload.json?.statusCode ?? payload.status;
    if (candidate === undefined || candidate === null) return null;
    const code = Number(candidate);
    return Number.isFinite(code) ? code : null;
}

// extractRules fields whose selector matched nothing come back explicitly null (an empty
// match set can also surface as an empty array). The request may legitimately carry no
// extractRules, in which case there is nothing to report. Undefined fields are treated the
// same as null because a rule the server silently dropped is equally unfulfilled, but values
// are never guessed or back-filled here.
export function findMissingFields(extractRules, payload) {
    if (!extractRules || typeof extractRules !== 'object') return [];
    const extracted = payload?.json?.extractedData;
    const bag = extracted && typeof extracted === 'object' ? extracted : {};
    return Object.keys(extractRules).filter((field) => {
        const value = bag[field];
        return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    });
}

export function isBlockedStatus(code) {
    return code !== null && BLOCKED_STATUSES.has(code);
}

export function isUnreachableStatus(code) {
    return code !== null && UNREACHABLE_STATUSES.has(code);
}

export function includesJson(outputFormat) {
    return normalizeFormats(outputFormat).includes('json');
}

// extractLinks/extractEmails only land inside the json object. Without json in the
// outputFormat the server silently drops them, so the caller must be told rather than left
// to assume the data exists.
export function noLandingNotes(request) {
    const notes = [];
    if (!includesJson(request.outputFormat)) {
        if (request.extractLinks) {
            notes.push('extractLinks was requested but outputFormat does not include "json", so no links were returned');
        }
        if (request.extractEmails) {
            notes.push('extractEmails was requested but outputFormat does not include "json", so no emails were returned');
        }
    }
    return notes;
}

// Classification for a tool call that *returned* a payload (the MCP call itself succeeded,
// even when the target page answered 403/404).
export function classifyPayload(payload) {
    const statusCode = statusCodeOf(payload);
    if (isBlockedStatus(statusCode)) return { outcome: OUTCOME.BLOCKED, statusCode };
    return { outcome: OUTCOME.SUCCESS, statusCode };
}

// Only the plan/concurrency ceiling is retried. A dead proxy, a 403 and an unknown error all
// describe a definitive answer for this page; hammering them changes nothing.
export function isRetryableError(error) {
    if (!error) return false;
    if (error.retryable === true) return true;
    if (error.errorType === 'concurrency_limit') return true;
    if (error.statusCode === 429) return true;
    const text = String(error.message ?? '');
    return text.includes('429') || text.toLowerCase().includes('concurrency_limit');
}

// Classification for a call that *threw* (no payload to read a target status from).
export function classifyError(error) {
    const rawCode = error?.statusCode;
    const parsed = rawCode === null || rawCode === undefined ? NaN : Number(rawCode);
    const code = Number.isFinite(parsed) ? parsed : null;
    if (error?.errorType === 'proxyConnection') {
        return { outcome: OUTCOME.UNREACHABLE, statusCode: code };
    }
    if (isUnreachableStatus(code)) {
        return { outcome: OUTCOME.UNREACHABLE, statusCode: code };
    }
    return { outcome: OUTCOME.FAILED, statusCode: code };
}
