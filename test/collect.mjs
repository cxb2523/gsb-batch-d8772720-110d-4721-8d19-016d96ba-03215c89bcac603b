// Reusable batch collector for "keyword + location" job searches.
//
// This is a library module, NOT a command-line tool: it exports functions and has no
// side effects on import. A caller hands it a list of queries and an already-wired RPC
// send function (the module never constructs URLs, headers or API keys itself), and gets
// back one record per query plus a batch summary. Every per-query failure is contained,
// so one bad query never aborts the rest of the batch.
//
// The transport contract is intentionally narrow so a fake can stand in for the network:
//
//   rpcSend(query) -> Promise<{ status: number, body: string | object | null }>
//
// `status` is the raw HTTP status. `body` may be the unparsed response text (plain JSON
// or an SSE stream is fine — only substring checks run on it) or an already-parsed JSON
// value. A rejected rpcSend (DNS failure, aborted request, ...) is caught and recorded as
// a generic failure; a thrown error carries no HTTP answer, so no retry is attempted.
//
// Run the accompanying checks with: node --test test/collect.test.mjs

export const OUTCOMES = Object.freeze({
    // A 200 response whose payload contained at least one job.
    SUCCESS: 'success',
    // A 200 response whose jobs array was empty. An empty result IS a success:
    // the query was answered, the market simply had no matches.
    EMPTY: 'empty',
    // HTTP 401 (or an MCP isError payload reporting 401 Unauthorized). Never retried.
    AUTH_ERROR: 'auth_error',
    // HTTP 429, or a body carrying concurrency_limit, still failing after MAX_ATTEMPTS.
    RATE_LIMITED: 'rate_limited',
    // Anything else: another non-200 status, an unparseable 200, or a thrown rpcSend.
    FAILED: 'failed',
    // Resume hit: the query key was in the completed set, so no request was sent.
    SKIPPED: 'skipped',
});

// At most this many RPC attempts per query. Retries only happen for rate limiting,
// so a query that is rate limited every time makes exactly MAX_ATTEMPTS calls.
export const MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Query keys (the resume checkpoint)
// ---------------------------------------------------------------------------

// Normalization rule for one term (keyword or location):
//   1. coerce to string (null/undefined become the empty string);
//   2. Unicode NFKC-normalize, so composed/decomposed forms compare equal;
//   3. trim leading/trailing whitespace and collapse every internal run of
//      whitespace (including tabs and newlines) to a single ASCII space.
// Case is deliberately preserved: keyword and location casing is sent to the
// upstream API as given, so "react" and "React" stay distinct queries.
export function normalizeQueryTerm(term) {
    return String(term ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ');
}

// Stable query key. The two normalized terms are wrapped in a JSON array rather than
// joined on a separator: JSON escaping makes the encoding collision-free, so a keyword
// that itself contains "::" (or quotes, or newlines) can never alias another query.
// The same { keyword, location } input always produces the same key across runs, which
// is what a resumed run relies on.
export function queryKey(query) {
    return JSON.stringify([
        normalizeQueryTerm(query?.keyword),
        normalizeQueryTerm(query?.location),
    ]);
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

function asText(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    try {
        return JSON.stringify(body);
    } catch {
        return String(body);
    }
}

function snippet(raw, max = 200) {
    const compact = String(raw).replace(/\s+/g, ' ').trim();
    return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

// The hosted MCP server answers HTTP 200 even for a rate-limited tool call and puts
// "concurrency_limit" in the body, while a gateway-level limit answers a real 429.
// Treat either signal the same.
function isRateLimited(status, raw, body) {
    if (status === 429) return true;
    if (raw.includes('concurrency_limit')) return true;
    const code = body?.error?.code;
    return typeof code === 'string' && code.includes('concurrency_limit');
}

// A missing key fails the connection with a real 401; a wrong key arrives as a 200
// whose MCP result has isError=true and the text "HasData API error: 401 Unauthorized".
function isAuthFailure(status, raw, body) {
    if (status === 401) return true;
    if (body?.result?.isError === true && /401|unauthorized/i.test(raw)) return true;
    return false;
}

// A string body may be plain JSON or a streamable-HTTP SSE stream, which can carry
// progress notifications before the answer. Concatenate every data: line and parse the
// first JSON value that looks like an RPC message; malformed text yields null.
function parseBody(body) {
    if (typeof body !== 'string') return body ?? null;
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return null;
        }
    }
    for (const event of trimmed.split(/\r?\n\r?\n+/)) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch {
            // A keep-alive or partial event is not our response.
        }
    }
    return null;
}

// Pull the jobs array out of the several shapes a 200 response can have:
//   MCP envelope  -> result.content[0].text parsed, then .json.jobs (or .jobs)
//   plain payload -> body.jobs or body.json.jobs
// String bodies (plain JSON or SSE) are parsed first. Returns null when no jobs array
// can be located, which the caller treats as a failure.
function extractJobs(rawBody) {
    const body = parseBody(rawBody);
    const textBlock = body?.result?.content?.[0]?.text;
    if (typeof textBlock === 'string') {
        try {
            const parsed = JSON.parse(textBlock);
            if (Array.isArray(parsed?.json?.jobs)) return parsed.json.jobs;
            if (Array.isArray(parsed?.jobs)) return parsed.jobs;
        } catch {
            // The text block was not JSON; fall through to the other shapes.
        }
    }
    if (Array.isArray(body?.json?.jobs)) return body.json.jobs;
    if (Array.isArray(body?.jobs)) return body.jobs;
    return null;
}

function errorTextFromBody(rawBody, raw) {
    const body = parseBody(rawBody);
    const textBlock = body?.result?.content?.[0]?.text;
    if (typeof textBlock === 'string' && textBlock.trim()) return snippet(textBlock);
    if (body?.error?.message) return snippet(String(body.error.message));
    return snippet(raw);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Increasing backoff: after the 1st rate-limited attempt wait 1s, then 2s, 3s, ...
// Tests override both this and sleep, so no real timer ever fires in the suite.
const defaultBackoffMs = (attempt) => attempt * 1000;

// ---------------------------------------------------------------------------
// One query
// ---------------------------------------------------------------------------

async function collectOne(query, key, rpcSend, options) {
    const { sleep, backoffMs, maxAttempts } = options;
    const baseRecord = {
        query: { keyword: query.keyword, location: query.location },
        key,
        attempts: 0,
        lastStatus: null,
        error: null,
    };

    let terminal = null; // 'auth' | 'rate' | null — decides the failure outcome
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        baseRecord.attempts = attempt;
        let response;
        try {
            response = await rpcSend({ keyword: query.keyword, location: query.location });
        } catch (err) {
            // No HTTP answer arrived. It cannot be classified as 401/429, so it is
            // a terminal generic failure and the batch moves on to the next query.
            lastError = `request failed: ${err instanceof Error ? err.message : String(err)}`;
            break;
        }

        const status = typeof response?.status === 'number' ? response.status : null;
        const raw = asText(response?.body);
        const parsedBody = parseBody(response?.body);
        baseRecord.lastStatus = status;

        if (isAuthFailure(status, raw, parsedBody)) {
            lastError = `401 Unauthorized${raw ? `: ${snippet(raw)}` : ''}`;
            terminal = 'auth';
            break;
        }

        if (isRateLimited(status, raw, parsedBody)) {
            lastError = `rate limited (concurrency_limit, HTTP ${status ?? 'n/a'}): ${snippet(raw) || 'no body'}`;
            if (attempt < maxAttempts) {
                // Increasing wait; the delay is derived from the attempt that just failed.
                await sleep(backoffMs(attempt), {
                    attempt,
                    query: baseRecord.query,
                    key,
                });
                continue;
            }
            terminal = 'rate';
            break;
        }

        if (status !== 200) {
            // Every other non-200 is terminal: no retry, no backoff.
            lastError = status === null
                ? `RPC response had no HTTP status: ${snippet(raw) || 'empty response'}`
                : `HTTP ${status}: ${snippet(raw) || 'empty response'}`;
            break;
        }

        const jobs = extractJobs(response?.body);
        if (jobs === null) {
            lastError = `200 response carried no jobs array: ${errorTextFromBody(response?.body, raw) || 'empty response'}`;
            break;
        }

        // Answered successfully — an empty jobs array is still a success outcome.
        return {
            ...baseRecord,
            outcome: jobs.length > 0 ? OUTCOMES.SUCCESS : OUTCOMES.EMPTY,
            error: null,
            jobCount: jobs.length,
        };
    }

    return {
        ...baseRecord,
        outcome:
            terminal === 'auth'
                ? OUTCOMES.AUTH_ERROR
                : terminal === 'rate'
                  ? OUTCOMES.RATE_LIMITED
                  : OUTCOMES.FAILED,
        error: lastError,
    };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

// Collect every query in order. Never rejects because of an individual query.
//
// queries:       array of { keyword, location }
// rpcSend:       injected transport, see the contract at the top of this file
// options:
//   completedKeys: iterable of query keys already collected in an earlier run.
//                  Matching queries are reported as SKIPPED and never sent to rpcSend.
//                  Accepts a Set or an array; the caller's iterable is not mutated.
//   sleep:         (ms, context) => Promise, injectable so tests never really wait.
//   backoffMs:     (attempt) => ms, the increasing delay before retry attempt+1.
//   maxAttempts:   per-query RPC attempt cap, defaults to MAX_ATTEMPTS (5).
//
// Returns:
//   {
//     results: [ { query, key, outcome, attempts, lastStatus, error, jobCount? } ],
//     summary: { total, success, empty, failed, skipped },
//   }
// `failed` covers auth_error, rate_limited and failed together. Results preserve the
// input order, which makes a rerun diff readable.
export async function collectBatch(queries, rpcSend, options = {}) {
    const {
        completedKeys = [],
        sleep = defaultSleep,
        backoffMs = defaultBackoffMs,
        maxAttempts = MAX_ATTEMPTS,
    } = options;

    const completed = new Set(completedKeys);
    const results = [];
    const summary = { total: queries.length, success: 0, empty: 0, failed: 0, skipped: 0 };

    for (const query of queries) {
        const key = queryKey(query);

        if (completed.has(key)) {
            // Resume path: no RPC call, no wait, attempts stay at zero.
            results.push({
                query: { keyword: query.keyword, location: query.location },
                key,
                outcome: OUTCOMES.SKIPPED,
                attempts: 0,
                lastStatus: null,
                error: null,
            });
            summary.skipped++;
            continue;
        }

        const record = await collectOne(query, key, rpcSend, { sleep, backoffMs, maxAttempts });
        results.push(record);

        if (record.outcome === OUTCOMES.SUCCESS) summary.success++;
        else if (record.outcome === OUTCOMES.EMPTY) summary.empty++;
        else summary.failed++;
    }

    return { results, summary };
}
