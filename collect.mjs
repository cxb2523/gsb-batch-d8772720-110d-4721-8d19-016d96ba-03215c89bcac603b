// Reusable paginated collection flow for the Booking.com search tool.
//
// The launcher (index.mjs) only proxies the MCP server for an interactive client. Batch
// collection needs more: turn pages automatically, say how every page ended, and pick up
// where an interrupted run stopped. collectBookingSearch() does that over the same
// streamable HTTP endpoint and the same tool the launcher exposes, one JSON-RPC tools/call
// per page, 10 credits per successful call.
//
//   import { collectBookingSearch } from './collect.mjs';
//   const progress = await collectBookingSearch({
//     keyword: 'Paris',
//     checkInDate: '2026-12-14',
//     checkOutDate: '2026-12-17',
//     rooms: 1, adults: 2, children: 0,
//     maxPages: 4,
//   });
//   // later, after a rate limit or a crash:
//   const more = await collectBookingSearch({ ...sameInput, maxPages: 8, progress });

const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=booking';
const TOOL_NAME = 'hasdata_booking_search_getBookingSearchResults';

// How every single page ended. `empty` is a success with no rows, not a failure.
export const OUTCOME = {
    SUCCESS: 'success',
    EMPTY: 'empty',
    RATE_LIMITED: 'rate_limited',
    INVALID_INPUT: 'invalid_input',
    ERROR: 'error',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Input mistakes are caught here, before any request leaves the machine, so a bad call
// never spends the 10 credits. Returns a list of { field, message } faults; empty means OK.
export function validateSearchInput(input) {
    const errors = [];
    const { keyword, checkInDate, checkOutDate, rooms, adults, children = 0, childrenAges } = input;

    if (!keyword || !String(keyword).trim()) {
        errors.push({ field: 'keyword', message: 'keyword is required and must not be blank' });
    }
    for (const [field, value] of [['checkInDate', checkInDate], ['checkOutDate', checkOutDate]]) {
        if (!DATE_RE.test(value || '') || Number.isNaN(Date.parse(value))) {
            errors.push({ field, message: `${field} must be a valid YYYY-MM-DD date` });
        }
    }
    if (errors.length === 0 && Date.parse(checkOutDate) <= Date.parse(checkInDate)) {
        errors.push({ field: 'checkOutDate', message: 'checkOutDate must be later than checkInDate' });
    }
    for (const [field, value] of [['rooms', rooms], ['adults', adults]]) {
        if (!Number.isInteger(value) || value < 1) {
            errors.push({ field, message: `${field} must be an integer of at least 1` });
        }
    }
    if (!Number.isInteger(children) || children < 0) {
        errors.push({ field: 'children', message: 'children must be an integer of 0 or more' });
    } else if (children > 0 && (!Array.isArray(childrenAges) || childrenAges.length !== children)) {
        errors.push({
            field: 'childrenAges',
            message: `childrenAges must list one age per child (${children} expected)`,
        });
    }
    return errors;
}

// A streamable HTTP body arrives either as plain JSON or as server-sent events. One SSE
// event can span several data: lines, several events can share one response, and the server
// may send progress notifications before the answer. Collect every event and pick the
// message carrying our request id instead of trusting the first data: line.
function parseRpc(raw, id) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);

    const messages = [];
    for (const event of trimmed.split(/\r?\n\r?\n+/)) {
        const data = event
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
            messages.push(JSON.parse(data));
        } catch {
            // A keep-alive or a partial event is not our response.
        }
    }
    const match = messages.find((m) => m.id === id);
    if (!match) throw new Error(`no message with id ${id} in the response: ${raw.slice(0, 300)}`);
    return match;
}

// The tool answers with MCP content blocks whose text is a JSON document. The stays list
// sits in its `results` array; a bare array is accepted too, so a server-side format tweak
// does not silently read as zero rows.
function extractItems(result) {
    const text = result?.content?.find((c) => c.type === 'text')?.text;
    if (text == null) throw new Error('the tool result carried no text content');
    const payload = JSON.parse(text);
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.results)) return payload.results;
    throw new Error(`no results array in the tool payload: ${text.slice(0, 300)}`);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch one page, retrying HasData's concurrency_limit with a growing wait. The free plan
// runs one call at a time and answers 429-style bodies instead of queueing, so a collision
// is routine and worth waiting out; a caller that keeps nothing but failures is not.
async function fetchPage({ page, args, ctx }) {
    const { endpoint, apiKey, fetchImpl, sleep, maxRetries, retryBaseMs, timeoutMs } = ctx;
    for (let attempt = 0; ; attempt++) {
        const id = ctx.nextId();
        let raw;
        try {
            const res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json',
                    // The server answers over streamable HTTP, so accept a plain body and a stream.
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    method: 'tools/call',
                    params: { name: TOOL_NAME, arguments: { ...args, page } },
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            raw = await res.text();
            if (res.status !== 200 && !raw.includes('concurrency_limit')) {
                return { outcome: OUTCOME.ERROR, detail: `HTTP ${res.status}: ${raw.slice(0, 300)}` };
            }
        } catch (err) {
            return { outcome: OUTCOME.ERROR, detail: String(err) };
        }
        if (raw.includes('concurrency_limit')) {
            if (attempt < maxRetries) {
                await sleep((attempt + 1) * retryBaseMs);
                continue;
            }
            return { outcome: OUTCOME.RATE_LIMITED, detail: `still limited after ${maxRetries} retries` };
        }
        try {
            const msg = parseRpc(raw, id);
            if (msg.error) return { outcome: OUTCOME.ERROR, detail: JSON.stringify(msg.error).slice(0, 300) };
            if (msg.result?.isError) {
                return { outcome: OUTCOME.ERROR, detail: JSON.stringify(msg.result).slice(0, 300) };
            }
            const items = extractItems(msg.result);
            return { outcome: items.length ? OUTCOME.SUCCESS : OUTCOME.EMPTY, items };
        } catch (err) {
            return { outcome: OUTCOME.ERROR, detail: String(err) };
        }
    }
}

// Collect up to maxPages pages of search results. Returns a progress object describing
// every page's outcome; pass it back as `progress` to resume from `nextPage` without
// refetching pages that already succeeded.
export async function collectBookingSearch({
    keyword,
    checkInDate,
    checkOutDate,
    rooms = 1,
    adults = 2,
    children = 0,
    childrenAges,
    maxPages = 1,
    progress,
    apiKey = process.env.HASDATA_API_KEY,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    sleep = defaultSleep,
    maxRetries = 4,
    retryBaseMs = 4000,
    timeoutMs = 30_000,
} = {}) {
    const input = { keyword, checkInDate, checkOutDate, rooms, adults, children, childrenAges };

    // Resume: keep the earlier pages, counts and rows, and continue from the recorded
    // next page. Pages already marked success are never requested again.
    const pages = [...(progress?.pages ?? [])];
    const donePages = new Set(pages.filter((p) => p.outcome === OUTCOME.SUCCESS).map((p) => p.page));
    const results = [...(progress?.results ?? [])];
    let fetched = progress?.fetched ?? 0;
    let page = progress?.nextPage ?? 1;

    const finish = (stoppedReason, resumable, extra = {}) => ({
        params: input,
        pages,
        fetched,
        nextPage: page,
        resumable,
        stoppedReason,
        results,
        ...extra,
    });

    // Validate before anything else: a rejected input costs no request and no credits.
    const errors = validateSearchInput(input);
    if (errors.length) {
        pages.push({ page, outcome: OUTCOME.INVALID_INPUT, count: 0, total: fetched });
        return finish(OUTCOME.INVALID_INPUT, false, { errors });
    }
    if (!apiKey) {
        pages.push({ page, outcome: OUTCOME.ERROR, count: 0, total: fetched });
        return finish(OUTCOME.ERROR, true, {
            errors: [{ field: 'apiKey', message: 'no API key: pass apiKey or set HASDATA_API_KEY' }],
        });
    }
    if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error(`maxPages must be an integer of at least 1, got ${maxPages}`);
    }

    const ctx = {
        endpoint, apiKey, fetchImpl, sleep, maxRetries, retryBaseMs, timeoutMs,
        nextId: (() => { let id = 1; return () => id++; })(),
    };
    const args = { keyword, checkInDate, checkOutDate, rooms, adults, children };
    if (childrenAges) args.childrenAges = childrenAges;

    let fetchedThisRun = 0;
    while (fetchedThisRun < maxPages) {
        if (donePages.has(page)) {
            // Defensive: a hand-edited progress could point nextPage at a finished page.
            page++;
            continue;
        }
        const r = await fetchPage({ page, args, ctx });
        fetchedThisRun++;
        const count = r.items?.length ?? 0;
        fetched += count;
        pages.push({ page, outcome: r.outcome, count, total: fetched, ...(r.detail ? { detail: r.detail } : {}) });

        if (r.outcome === OUTCOME.SUCCESS) {
            results.push(...r.items);
            donePages.add(page);
            page++;
            continue;
        }
        if (r.outcome === OUTCOME.EMPTY) {
            // A successful call that returned no rows: the destination is exhausted.
            page++;
            return finish(OUTCOME.EMPTY, false);
        }
        // rate_limited or error: stop here; nextPage still points at this page so a
        // resumed run retries it instead of skipping or refetching finished pages.
        return finish(r.outcome, true);
    }
    return finish('max_pages', true);
}
