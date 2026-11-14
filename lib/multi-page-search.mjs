// Resumable, multi-page Airbnb search over HasData's remote streamable-HTTP MCP server.
//
// The hosted search tool returns one page per call and hands the next page out as
// `pagination.nextPageToken`. This module turns that into a multi-page run:
//
//   - it calls `hasdata_airbnb_listing_getAirbnbListings` page after page,
//   - merges every page into one de-duplicated list (by property id, then url),
//   - records the outcome of every page (success / no more results / failed),
//   - keeps a JSON-serializable resume state holding the next token, every merged
//     property id and the page count, so a later call continues where this one stopped
//     without pulling a page that already succeeded,
//   - retries `concurrency_limit` answers and HTTP 429s with bounded exponential
//     backoff, and on exhaustion marks the page failed while retaining the token.
//
// Everything here uses the platform fetch built into Node 18+, so the module has no
// runtime dependencies and can be exercised against hand-written JSON-RPC/SSE answers.

export const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=airbnb';
export const LISTINGS_TOOL = 'hasdata_airbnb_listing_getAirbnbListings';
export const STATE_VERSION = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

/**
 * Start a fresh resume state for a search.
 *
 * `searchArgs` holds the tool arguments for the first page (location or bounding box,
 * checkIn, checkOut, guest counts, ...). The token is owned by the state, so a
 * nextPageToken passed inside searchArgs is stripped rather than treated as page one.
 *
 * @param {Record<string, unknown>} [searchArgs]
 */
export function createSearchState(searchArgs = {}) {
    const args = { ...searchArgs };
    delete args.nextPageToken;
    return {
        version: STATE_VERSION,
        searchArgs: args,
        // Token to present on the next tools/call. null means "start at page one" or,
        // once complete is true, "there is no next page".
        nextPageToken: null,
        // Ids merged from every successful page so far; the dedup key across runs.
        propertyIds: [],
        // Number of pages already fetched successfully.
        pagesFetched: 0,
        // Set once an empty page or a token-less last page terminates the search.
        complete: false,
    };
}

function validateState(state) {
    if (!state || typeof state !== 'object') {
        throw new Error('a resume state created by createSearchState is required');
    }
    if (state.version !== STATE_VERSION) {
        throw new Error(`unsupported search state version ${state.version}, expected ${STATE_VERSION}`);
    }
    if (!state.searchArgs || typeof state.searchArgs !== 'object') {
        throw new Error('the resume state carries no searchArgs, so the search cannot continue');
    }
}

// ---------------------------------------------------------------------------
// Streamable HTTP / JSON-RPC parsing
// ---------------------------------------------------------------------------

/**
 * Pick the JSON-RPC message answering `requestId` out of a streamable-HTTP body.
 *
 * The body is either plain JSON (one object or a batch) or server-sent events. One SSE
 * event can span several `data:` lines, one response can carry several events, and
 * progress notifications may arrive before the answer, so every event is collected and
 * the message carrying our request id wins instead of the first data line.
 */
export function parseStreamableHttp(raw, requestId) {
    const trimmed = String(raw).trim();
    let messages;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        messages = Array.isArray(parsed) ? parsed : [parsed];
    } else {
        messages = [];
        for (const event of trimmed.split(/\r?\n\r?\n+/)) {
            if (!event.includes('data:')) continue;
            const data = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).replace(/^ /, ''))
                .join('\n');
            if (!data || data === '[DONE]') continue;
            try {
                messages.push(JSON.parse(data));
            } catch {
                // A keep-alive comment or a partial event is not our response.
            }
        }
    }

    const match = messages.find((message) => message && message.id === requestId);
    if (!match) {
        throw new Error(`no JSON-RPC message with id ${requestId} in the response body`);
    }
    return match;
}

/**
 * Unwrap a tools/call JSON-RPC message into the scraped payload.
 *
 * The MCP layer answers HTTP 200 even on failure and puts the reason in a JSON-RPC
 * error or in result.isError; those are thrown as ToolError so callers can tell a
 * rejected call (401, validation, ...) apart from a transport problem. The success
 * shape is result.content[0].text parsed as JSON, with the data under `.json`.
 */
export function extractToolPayload(message) {
    if (message.error) {
        const detail = message.error.data
            ? (typeof message.error.data === 'string' ? message.error.data : JSON.stringify(message.error.data))
            : JSON.stringify(message.error.message ?? message.error);
        throw new ToolError(`JSON-RPC error ${message.error.code ?? ''}: ${detail}`.trim());
    }

    const result = message.result;
    if (!result) throw new ToolError('the JSON-RPC message carried no result');
    if (result.isError) {
        const text = (result.content ?? [])
            .map((block) => block?.text)
            .filter(Boolean)
            .join('\n');
        throw new ToolError(text || 'the tool call returned isError without a message');
    }

    // Structured-output responses skip the text envelope entirely.
    if (result.structuredContent && typeof result.structuredContent === 'object') {
        return normalizePayload(result.structuredContent);
    }

    const textBlock = (result.content ?? []).find((block) => block?.type === 'text' && block.text);
    if (!textBlock) throw new ToolError('the tool result carried no text content');

    let envelope;
    try {
        envelope = JSON.parse(textBlock.text);
    } catch (err) {
        throw new ToolError(`the tool result text is not JSON: ${err.message}`);
    }
    return normalizePayload(envelope);
}

class ToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolError';
    }
}

function normalizePayload(envelope) {
    // The documented shape wraps the scraped body as { url, status, text, json }.
    // Tolerate servers that return the body fields at the top level instead.
    if (envelope && typeof envelope === 'object' && envelope.json && typeof envelope.json === 'object') {
        return envelope.json;
    }
    return envelope;
}

/**
 * Rate limiting shows up two ways: an outright HTTP 429, or a 200 body whose text
 * mentions the plan's concurrency_limit code. Either is worth backing off and retrying.
 */
export function isConcurrencyLimited(status, rawText) {
    return status === 429 || /concurrency_limit/.test(String(rawText ?? ''));
}

function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
    // `attempt` is the failed attempt number (1-based): base, 2*base, 4*base, ...
    return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

function propertyKey(property, index) {
    if (property == null || typeof property !== 'object') return `__no_id_${index}`;
    if (property.id != null && property.id !== '') return String(property.id);
    if (property.url != null && property.url !== '') return String(property.url);
    return `__no_id_${index}`;
}

// ---------------------------------------------------------------------------
// One page, with bounded retries
// ---------------------------------------------------------------------------

async function fetchPage({ fetchImpl, endpoint, apiKey, requestId, args }) {
    let response;
    try {
        response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
                // The server answers over streamable HTTP: accept a plain body or a stream.
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                method: 'tools/call',
                params: { name: LISTINGS_TOOL, arguments: args },
            }),
        });
    } catch (err) {
        // A dropped connection is transient: back off and use the same token again.
        return { kind: 'transient', reason: `network error: ${err.message}` };
    }

    const raw = await response.text();

    if (isConcurrencyLimited(response.status, raw)) {
        return {
            kind: 'transient',
            reason: `rate limited (HTTP ${response.status}${response.status === 429 ? '' : ', concurrency_limit'})`,
        };
    }
    if (response.status !== 200) {
        // A non-200 that is not a 429 is a hard failure (e.g. 401): retrying will not help.
        return {
            kind: 'fatal',
            reason: `HTTP ${response.status} ${response.statusText ?? ''}: ${raw.slice(0, 200)}`.trim(),
        };
    }

    let message;
    try {
        message = parseStreamableHttp(raw, requestId);
    } catch (err) {
        return { kind: 'fatal', reason: err.message };
    }

    try {
        return { kind: 'ok', payload: extractToolPayload(message) };
    } catch (err) {
        // Tool-level failures (bad key, schema rejection, removed listing) are not retried.
        return { kind: 'fatal', reason: err.message };
    }
}

async function fetchPageWithRetries(options) {
    const { maxRetries, baseDelayMs, maxDelayMs, sleepImpl } = options;
    let attempts = 0;
    for (;;) {
        attempts += 1;
        const outcome = await fetchPage(options);
        if (outcome.kind !== 'transient') return { ...outcome, attempts };
        if (attempts > maxRetries) {
            // The budget is spent. The caller keeps the token, so this page remains fetchable.
            return { kind: 'exhausted', reason: outcome.reason, attempts };
        }
        await sleepImpl(backoffDelay(attempts, baseDelayMs, maxDelayMs));
    }
}

// ---------------------------------------------------------------------------
// The multi-page run
// ---------------------------------------------------------------------------

/**
 * Fetch up to `maxPages` search pages and merge them into one de-duplicated result.
 *
 * Pass either `searchArgs` (first run) or a previous `state` (resume). On resume the
 * run starts at state.nextPageToken, so pages that already succeeded are never pulled
 * again; state.propertyIds still guards against duplicate listings if a page overlaps.
 *
 * Page outcomes:
 *   - "success":        properties returned and merged; continues when a token exists
 *   - "no_more_results": an empty properties array; the search terminates cleanly
 *   - "failed":         retries exhausted or a hard error; token retained for resume
 * A non-empty last page without a nextPageToken also terminates, as a "success" page.
 *
 * @returns {Promise<{status: string, requestMetadataId: string|null,
 *   properties: object[], pages: object[], state: object}>}
 */
export async function searchAllListings(options = {}) {
    const {
        endpoint = DEFAULT_ENDPOINT,
        apiKey = process.env.HASDATA_API_KEY,
        searchArgs = undefined,
        state = null,
        maxPages = 10,
        maxRetries = 3,
        baseDelayMs = 1000,
        maxDelayMs = 30_000,
        sleepImpl = sleep,
        fetchImpl = globalThis.fetch,
        requestIdStart = 1,
    } = options;

    if (!fetchImpl) throw new Error('global fetch is unavailable; provide options.fetchImpl');
    if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error('maxPages must be a positive integer');
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
        throw new Error('maxRetries must be a non-negative integer');
    }

    // The state is plain, JSON-serializable data, so a JSON round-trip clones it without
    // mutating the caller's object (and stays independent of structuredClone availability).
    const run = state ? JSON.parse(JSON.stringify(state)) : createSearchState(searchArgs);
    validateState(run);

    if (run.complete) {
        // Nothing left to do; do not spend a call re-confirming a finished search.
        return {
            status: 'complete',
            requestMetadataId: run.requestMetadataId ?? null,
            properties: [],
            pages: [],
            state: run,
        };
    }

    const knownIds = new Set(run.propertyIds);
    const properties = [];
    const pages = [];
    let requestMetadataId = run.requestMetadataId ?? null;
    let status = 'failed';
    let requestId = requestIdStart;
    let pagesThisRun = 0;

    while (pagesThisRun < maxPages) {
        const pageNumber = run.pagesFetched + 1;
        const args = { ...run.searchArgs };
        if (run.nextPageToken) args.nextPageToken = run.nextPageToken;

        const outcome = await fetchPageWithRetries({
            fetchImpl,
            endpoint,
            apiKey,
            requestId,
            args,
            maxRetries,
            baseDelayMs,
            maxDelayMs,
            sleepImpl,
        });
        requestId += 1;

        if (outcome.kind === 'fatal' || outcome.kind === 'exhausted') {
            // Do NOT advance pagesFetched and do NOT touch nextPageToken: the same page
            // must be re-fetchable on the next call. resumable is exactly "a token is
            // parked on this page" — page one failures restart from scratch and report
            // false because there is no prior successful page to continue from.
            pages.push({
                page: pageNumber,
                status: 'failed',
                newProperties: 0,
                totalProperties: knownIds.size,
                reason: outcome.reason,
                resumable: run.nextPageToken !== null,
                attempts: outcome.attempts,
            });
            status = 'failed';
            break;
        }

        const payload = outcome.payload ?? {};
        if (payload.requestMetadata?.id != null) {
            requestMetadataId = payload.requestMetadata.id;
            run.requestMetadataId = requestMetadataId;
        }

        const pageProperties = Array.isArray(payload.properties) ? payload.properties : [];

        // An empty page means the location/date window has no more availability. It is a
        // clean stop, not an error, even if the body still carries a token. The page was
        // still fetched, so pagesFetched advances; only failed fetches leave it untouched.
        if (pageProperties.length === 0) {
            run.pagesFetched += 1;
            run.propertyIds = [...knownIds];
            run.nextPageToken = null;
            run.complete = true;
            pages.push({
                page: pageNumber,
                status: 'no_more_results',
                newProperties: 0,
                totalProperties: knownIds.size,
                attempts: outcome.attempts,
            });
            status = 'no_more_results';
            break;
        }

        let newProperties = 0;
        pageProperties.forEach((property, index) => {
            const key = propertyKey(property, index);
            if (knownIds.has(key)) return;
            knownIds.add(key);
            properties.push(property);
            newProperties += 1;
        });

        const nextToken = payload.pagination?.nextPageToken ?? null;
        run.pagesFetched += 1;
        run.propertyIds = [...knownIds];
        run.nextPageToken = nextToken;

        pages.push({
            page: pageNumber,
            status: 'success',
            newProperties,
            totalProperties: knownIds.size,
            attempts: outcome.attempts,
        });
        pagesThisRun += 1;

        // A non-empty page without a token is the documented last page.
        if (!nextToken) {
            run.complete = true;
            status = 'complete';
            break;
        }
        if (pagesThisRun >= maxPages) {
            status = 'max_pages_reached';
        }
    }

    return { status, requestMetadataId, properties, pages, state: run };
}
