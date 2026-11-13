// JSON-RPC over streamable HTTP for the Amazon contract tests.
//
// Two concerns live here so they can be exercised offline:
//
//   parseRpc()  turns a raw response body (plain JSON or server-sent events) into the
//               JSON-RPC message that answers our request id.
//   createRpcClient() sends requests through an injectable transport. The production
//               transport is a thin fetch wrapper against the real endpoint; the offline
//               tests hand in a scripted fake transport that replays canned responses.
//
// Every real call leaves a record behind (method, tool name, attempts, concurrency_limit
// retries, final HTTP status, success). A test failure never has to explain itself from a
// bare boolean: the summary printed after the suite is built from those records.

export const ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=amazon';
export const TIMEOUT_MS = 30_000;
// The CI key sits on the free plan, where concurrency is 1. A 429 carrying
// concurrency_limit is a plan limit rather than a broken contract, so the call is retried
// up to MAX_ATTEMPTS times with a wait that grows with the attempt number. A 401 still
// fails on the first attempt and is never retried.
export const MAX_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 4_000;
const SNIPPET_LIMIT = 300;

// Keep only the leading slice of a body for diagnostics, so a huge error payload cannot
// flood the output.
export function snippet(raw) {
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    return text.length <= SNIPPET_LIMIT ? text : `${text.slice(0, SNIPPET_LIMIT)}…`;
}

// A streamable HTTP body arrives either as plain JSON or as server-sent events. One SSE
// event can span several data: lines, several events can share one response, and a server
// is free to send progress notifications before the answer. So collect every event and
// pick the message carrying our request id instead of trusting the first data: line.
export function parseRpc(raw, id) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);

    const messages = [];
    for (const event of trimmed.split(/\r?\n\r?\n+/)) {
        // Per the SSE spec, several data: lines in one event are joined with a newline
        // separator; servers that wrap a single JSON payload across lines separate the
        // fragments with a space instead, so try the spec join first and fall back to a
        // space before giving up on the event.
        const lines = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''));
        if (!lines.length) continue;
        const candidates = [lines.join('\n'), lines.join(' ')];
        const data = candidates.find((candidate) => {
            if (!candidate || candidate === '[DONE]') return false;
            try {
                JSON.parse(candidate);
                return true;
            } catch {
                return false;
            }
        });
        if (!data || data === '[DONE]') continue;
        try {
            messages.push(JSON.parse(data));
        } catch {
            // A keep-alive or a partial event is not our response.
        }
    }
    if (!messages.length) {
        throw new Error(`no JSON-RPC message in the response: ${snippet(raw)}`);
    }
    const match = messages.find((message) => message.id === id);
    if (!match) {
        throw new Error(`no message with id ${id} in the response: ${snippet(raw)}`);
    }
    return match;
}

// Raised when a request cannot be completed: transport failure, an HTTP status that is not
// 200, a body that cannot be parsed, or a JSON-RPC error. The message always carries the
// last status and a fragment of the last body, so a maintainer can tell a dead key, a plan
// limit and an upstream change apart.
export class RpcError extends Error {
    constructor(message, { status, raw, code } = {}) {
        super(message);
        this.name = 'RpcError';
        this.status = status ?? null;
        this.raw = raw ?? null;
        this.code = code ?? null;
    }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Default transport: one POST to the real endpoint with the same headers the suite always
// sent. The timeout keeps a hung connection from stalling the whole run.
export function createFetchTransport({ endpoint = ENDPOINT, apiKey, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
    return async function fetchTransport(request) {
        const res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                ...(apiKey ? { 'x-api-key': apiKey } : {}),
                'Content-Type': 'application/json',
                // The server answers over streamable HTTP, so accept both a plain body and a stream.
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, raw: await res.text() };
    };
}

// A concurrency limit can surface as a 429 status or as a JSON-RPC error embedded in a 200
// body; HasData uses the former, but matching the code string keeps both shapes honest.
function bodyCarriesConcurrencyLimit(raw) {
    return raw.includes('concurrency_limit');
}

// Decide whether the parsed message itself counts as a failure. A tools/call answer with
// isError is a transport success but a tool failure (the retired reviews tool answers that
// way), so its record must not be tallied as a success even though the HTTP layer worked.
export function evaluateOutcome(method, body) {
    if (body && body.error) {
        return { ok: false, reason: `json-rpc error ${body.error.code ?? ''}: ${body.error.message ?? ''}`.trim() };
    }
    if (method === 'tools/call' && body?.result?.isError === true) {
        return { ok: false, reason: 'tool answered with isError' };
    }
    return { ok: true, reason: null };
}

// Build a client. Every call appends an immutable record to client.records and returns
// { body, record } on success; on failure the record is appended first and an RpcError is
// thrown carrying the last status and a body fragment.
export function createRpcClient({
    transport,
    apiKey,
    endpoint = ENDPOINT,
    maxAttempts = MAX_ATTEMPTS,
    retryBaseDelayMs = RETRY_BASE_DELAY_MS,
    sleep = defaultSleep,
} = {}) {
    const chosenTransport = transport ?? createFetchTransport({ endpoint, apiKey });
    let nextId = 1;
    const records = [];

    async function call(method, params = {}) {
        const toolName = method === 'tools/call' ? params?.name ?? null : null;
        let attempt = 0;
        let concurrencyLimit = false;
        let lastStatus = null;
        let lastRaw = '';
        let lastError = null;

        while (attempt < maxAttempts) {
            attempt += 1;
            const id = nextId++;
            const request = { jsonrpc: '2.0', id, method, params };
            let response;
            try {
                response = await chosenTransport(request);
            } catch (err) {
                lastError = err;
                lastStatus = null;
                lastRaw = '';
                const record = finalizeRecord({
                    method, toolName, attempt, concurrencyLimit, status: null,
                    ok: false, reason: `transport error: ${err.message}`,
                });
                throw new RpcError(`${method} failed before an HTTP response: ${err.message}`, { raw: lastRaw });
            }

            lastStatus = response.status;
            lastRaw = response.raw ?? '';

            // 401 is a dead or revoked key: fail on the first attempt, never retry.
            if (lastStatus === 401) {
                const record = finalizeRecord({
                    method, toolName, attempt, concurrencyLimit, status: lastStatus,
                    ok: false, reason: '401 Unauthorized on the first attempt',
                });
                throw new RpcError(
                    `${method} rejected the key with 401 (no retry): ${snippet(lastRaw)}`,
                    { status: lastStatus, raw: lastRaw, code: 'unauthorized' }
                );
            }

            // A plan-level concurrency limit is worth the retry budget; the wait grows with
            // the attempt number so colliding runs spread out.
            if (lastStatus === 429 && bodyCarriesConcurrencyLimit(lastRaw)) {
                concurrencyLimit = true;
                if (attempt < maxAttempts) {
                    await sleep(attempt * retryBaseDelayMs);
                    continue;
                }
                const record = finalizeRecord({
                    method, toolName, attempt, concurrencyLimit, status: lastStatus,
                    ok: false, reason: `concurrency_limit retries exhausted after ${attempt} attempts`,
                });
                throw new RpcError(
                    `${method} still answered 429 concurrency_limit after ${attempt} attempts: ${snippet(lastRaw)}`,
                    { status: lastStatus, raw: lastRaw, code: 'concurrency_limit' }
                );
            }

            // Any other non-200 status is a hard failure: the status and a body fragment go
            // straight into the error and the record.
            if (lastStatus !== 200) {
                const record = finalizeRecord({
                    method, toolName, attempt, concurrencyLimit, status: lastStatus,
                    ok: false, reason: `unexpected HTTP status ${lastStatus}`,
                });
                throw new RpcError(
                    `${method} returned ${lastStatus}: ${snippet(lastRaw)}`,
                    { status: lastStatus, raw: lastRaw }
                );
            }

            let body;
            try {
                body = parseRpc(lastRaw, id);
            } catch (err) {
                const record = finalizeRecord({
                    method, toolName, attempt, concurrencyLimit, status: lastStatus,
                    ok: false, reason: `unparseable response: ${err.message}`,
                });
                throw new RpcError(`${method} response could not be parsed: ${err.message}`, {
                    status: lastStatus,
                    raw: lastRaw,
                });
            }

            const outcome = evaluateOutcome(method, body);
            const record = finalizeRecord({
                method, toolName, attempt, concurrencyLimit, status: lastStatus,
                ok: outcome.ok, reason: outcome.reason,
            });
            return { body, record, raw: lastRaw };
        }

        // Unreachable in practice: every branch above either returns or throws. Kept so a
        // future edit cannot turn an exhausted loop into a silent undefined.
        const record = finalizeRecord({
            method, toolName, attempt, concurrencyLimit, status: lastStatus,
            ok: false, reason: lastError ? `transport error: ${lastError.message}` : 'retry budget exhausted',
        });
        throw new RpcError(`${method} failed after ${attempt} attempts: ${snippet(lastRaw)}`, {
            status: lastStatus,
            raw: lastRaw,
        });

        function finalizeRecord(entry) {
            const record = {
                method: entry.method,
                toolName: entry.toolName,
                attempts: entry.attempt,
                retries: entry.attempt - 1,
                concurrencyLimit: entry.concurrencyLimit,
                status: entry.status,
                ok: entry.ok,
                reason: entry.reason,
            };
            records.push(record);
            return record;
        }
    }

    return {
        call,
        records,
    };
}

// Roll the per-call records up into one row per method/tool pair with totals and the final
// verdict. Rows stay in first-seen order so the summary mirrors the run.
export function summarizeRecords(records) {
    const rows = new Map();
    for (const record of records) {
        const key = `${record.method}${record.toolName ? `:${record.toolName}` : ''}`;
        const existing = rows.get(key);
        if (existing) {
            existing.calls += 1;
            existing.successes += record.ok ? 1 : 0;
            existing.retries += record.retries;
            existing.final = record;
        } else {
            rows.set(key, {
                key,
                method: record.method,
                toolName: record.toolName,
                calls: 1,
                successes: record.ok ? 1 : 0,
                retries: record.retries,
                final: record,
            });
        }
    }
    return [...rows.values()];
}

// Human-readable summary. With no key the live checks are skipped, and the banner must say
// so explicitly rather than printing an empty table that looks like an all-green run.
export function formatSummary(records, { skipped = false, skipReason = 'HASDATA_API_KEY is not set' } = {}) {
    const lines = [];
    lines.push('');
    lines.push('==== HasData Amazon MCP call summary ====');
    if (skipped) {
        lines.push(`Live calls SKIPPED (${skipReason}); no real requests were sent and no verdicts were earned.`);
        lines.push('=========================================');
        return lines.join('\n');
    }
    const rows = summarizeRecords(records);
    if (!rows.length) {
        lines.push('No live calls were recorded.');
        lines.push('=========================================');
        return lines.join('\n');
    }
    for (const row of rows) {
        const target = row.toolName ? ` ${row.toolName}` : '';
        const verdict = row.final.ok
            ? 'SUCCESS'
            : `FAILED${row.final.status !== null ? ` (HTTP ${row.final.status})` : ''}${row.final.reason ? `: ${row.final.reason}` : ''}`;
        lines.push(
            `${row.method}${target} — calls: ${row.calls}, successes: ${row.successes}, `
            + `retries: ${row.retries}, concurrency_limit: ${row.final.concurrencyLimit ? 'yes' : 'no'}, `
            + `final status: ${row.final.status ?? 'n/a'}, final outcome: ${verdict}`
        );
    }
    lines.push('=========================================');
    return lines.join('\n');
}
