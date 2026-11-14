// Minimal JSON-RPC client for the hosted HasData Facebook MCP server.
//
// The snapshot runner needs three things the raw endpoint does not give it: a way to tell a
// retryable throttle (429 / concurrency_limit) from a real failure, a bounded backoff, and the
// exact number of billable calls each page cost. They live here rather than in the runner so
// the runner can be tested with a plain object instead of the network.
//
// A streamable-HTTP response is either plain JSON or server-sent events. Several events may
// share one response, and progress notifications can precede the answer, so every event is
// collected and the one carrying our request id is used.

export const TOOL_NAME = 'hasdata_facebook_profile_getFacebookProfile';
export const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=facebook';

const CONCURRENCY_RE = /concurrency[_\s-]?limit|too many concurrent|rate[_\s-]?limit|too many requests/i;

export class ToolCallError extends Error {
    constructor(message, { code = 'request_failed', retryable = false, attempts = 1, billed = false, status = null, retryAfterMs = null, cause } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'ToolCallError';
        this.code = code;
        this.retryable = retryable;
        this.attempts = attempts;
        this.billed = billed;
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            attempts: this.attempts,
            billed: this.billed,
            status: this.status,
        };
    }
}

/**
 * Build a client that calls the one Facebook tool over streamable HTTP.
 *
 * Retry policy is deliberately narrow. Only throttles, timeouts, network errors and 5xx are
 * retried; a 401, a 4xx other than 429, a malformed payload or a JSON-RPC error is final. The
 * caller gets a ToolCallError carrying `attempts` and `billed` so a failed page can still be
 * accounted for.
 */
export function createMcpToolClient({
    endpoint = DEFAULT_ENDPOINT,
    apiKey,
    toolName = TOOL_NAME,
    fetchImpl,
    timeoutMs = 45_000,
    maxAttempts = 4,
    baseDelayMs = 2_000,
    maxDelayMs = 30_000,
    backoffFactor = 2,
    jitterRatio = 0,
    sleep,
    onRetry,
    random = Math.random,
} = {}) {
    if (!endpoint) throw new TypeError('endpoint is required');
    if (!toolName) throw new TypeError('toolName is required');
    if (apiKey === undefined || apiKey === null || apiKey === '') {
        throw new ToolCallError('An API key is required. Set HASDATA_API_KEY.', { code: 'missing_api_key' });
    }
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new TypeError('No fetch implementation is available');
    const attemptsLimit = Math.max(1, Math.trunc(maxAttempts));
    const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let nextId = 1;

    function delayFor(attempt, retryAfterMs) {
        if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.round(retryAfterMs);
        const exponential = Math.min(maxDelayMs, baseDelayMs * backoffFactor ** (attempt - 1));
        const jitter = jitterRatio > 0 ? exponential * jitterRatio * (random() * 2 - 1) : 0;
        return Math.max(0, Math.round(exponential + jitter));
    }

    async function callOnce(args, attempt) {
        const id = nextId++;
        let response;
        try {
            response = await doFetch(endpoint, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    method: 'tools/call',
                    params: { name: toolName, arguments: args },
                }),
                signal: timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
            });
        } catch (err) {
            const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
            throw new ToolCallError(
                timedOut ? `The tool call timed out after ${timeoutMs}ms` : `The tool call failed: ${err?.message ?? err}`,
                { code: timedOut ? 'timeout' : 'network_error', retryable: true, attempts: attempt, billed: false, cause: err },
            );
        }

        const status = Number(response?.status ?? 0);
        const retryAfterMs = parseRetryAfter(response);
        let raw;
        try {
            raw = await response.text();
        } catch (err) {
            throw new ToolCallError(`The response body could not be read: ${err?.message ?? err}`, {
                code: 'network_error',
                retryable: true,
                attempts: attempt,
                billed: false,
                status,
                cause: err,
            });
        }

        if (status !== 200) {
            const { code, retryable } = classifyHttpStatus(status, raw);
            throw new ToolCallError(`HTTP ${status} from the Facebook MCP endpoint${trimSnippet(raw) ? `: ${trimSnippet(raw)}` : ''}`, {
                code,
                retryable,
                attempts: attempt,
                billed: false,
                status,
                retryAfterMs,
            });
        }

        let message;
        try {
            message = parseRpcMessage(raw, id);
        } catch (err) {
            if (CONCURRENCY_RE.test(raw)) {
                throw new ToolCallError('The endpoint reported a concurrency limit', {
                    code: 'concurrency_limit',
                    retryable: true,
                    attempts: attempt,
                    billed: false,
                    status,
                    retryAfterMs,
                });
            }
            throw new ToolCallError(`The endpoint returned a response without a usable JSON-RPC message: ${trimSnippet(raw) || (err?.message ?? err)}`, {
                code: 'invalid_response',
                retryable: false,
                attempts: attempt,
                billed: false,
                status,
            });
        }

        if (message.error) {
            const text = typeof message.error === 'string' ? message.error : message.error.message ?? JSON.stringify(message.error);
            const concurrency = CONCURRENCY_RE.test(text);
            throw new ToolCallError(`The endpoint returned a JSON-RPC error: ${text}`, {
                code: concurrency ? 'concurrency_limit' : 'rpc_error',
                retryable: concurrency,
                attempts: attempt,
                billed: false,
                status,
                retryAfterMs,
            });
        }

        const result = message.result;
        if (!result || typeof result !== 'object') {
            throw new ToolCallError('The JSON-RPC response carried no tool result', {
                code: 'invalid_response',
                retryable: false,
                attempts: attempt,
                billed: false,
                status,
            });
        }

        if (result.isError) {
            const text = contentText(result) || 'the tool reported an error';
            const concurrency = CONCURRENCY_RE.test(text);
            throw new ToolCallError(`The tool call failed: ${text}`, {
                code: concurrency ? 'concurrency_limit' : 'tool_error',
                retryable: concurrency,
                attempts: attempt,
                // A throttle is not billed; any other tool error is a completed call.
                billed: !concurrency,
                status,
                retryAfterMs,
            });
        }

        let payload;
        try {
            payload = extractPayload(result);
        } catch (err) {
            if (CONCURRENCY_RE.test(raw)) {
                throw new ToolCallError('The endpoint reported a concurrency limit', {
                    code: 'concurrency_limit',
                    retryable: true,
                    attempts: attempt,
                    billed: false,
                    status,
                    retryAfterMs,
                });
            }
            throw new ToolCallError(err.message, {
                code: 'invalid_response',
                retryable: false,
                attempts: attempt,
                billed: false,
                status,
            });
        }

        return { payload, attempts: attempt, billed: true, status, toolResult: result };
    }

    return {
        endpoint,
        toolName,
        /** Call the tool once, retrying only throttles and transient transport failures. */
        async call(args = {}) {
            let lastError;
            for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
                try {
                    return await callOnce(args, attempt);
                } catch (err) {
                    const error = err instanceof ToolCallError ? err : new ToolCallError(err?.message ?? String(err), { attempts: attempt });
                    error.attempts = attempt;
                    lastError = error;
                    if (!error.retryable || attempt >= attemptsLimit) throw error;
                    const delayMs = delayFor(attempt, error.retryAfterMs);
                    onRetry?.({ attempt, code: error.code, status: error.status, delayMs, error });
                    await wait(delayMs);
                }
            }
            throw lastError ?? new ToolCallError('The tool call never ran', { code: 'no_attempt' });
        },
    };
}

function classifyHttpStatus(status, raw) {
    if (status === 429 || CONCURRENCY_RE.test(raw)) return { code: 'rate_limited', retryable: true };
    if (status >= 500) return { code: 'server_error', retryable: true };
    if (status === 401 || status === 403) return { code: 'unauthorized', retryable: false };
    return { code: 'http_error', retryable: false };
}

function parseRetryAfter(response) {
    const value = response?.headers?.get?.('retry-after') ?? response?.headers?.['retry-after'];
    if (value === undefined || value === null || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return null;
}

function parseRpcMessage(raw, id) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new Error('empty response');

    const chunks = [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        chunks.push(trimmed);
    } else {
        for (const event of trimmed.split(/\r?\n\r?\n+/)) {
            const data = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).replace(/^ /, ''))
                .join('\n');
            if (data && data !== '[DONE]') chunks.push(data);
        }
    }

    const messages = [];
    for (const chunk of chunks) {
        try {
            const parsed = JSON.parse(chunk);
            if (Array.isArray(parsed)) messages.push(...parsed);
            else messages.push(parsed);
        } catch {
            // A keep-alive or partial event is not our answer.
        }
    }

    const match = messages.find((message) => message && message.id === id);
    if (!match) throw new Error(`no JSON-RPC message with id ${id}`);
    return match;
}

function contentText(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const texts = content
        .filter((item) => item && (item.type === 'text' || typeof item.text === 'string'))
        .map((item) => item.text)
        .filter((text) => typeof text === 'string');
    return texts.join('\n').trim();
}

function extractPayload(result) {
    const text = contentText(result);
    let parsed;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error(`The tool returned text that is not JSON: ${trimSnippet(text)}`);
        }
    } else if (result?.structuredContent && typeof result.structuredContent === 'object') {
        parsed = result.structuredContent;
    } else {
        throw new Error('The tool result carried no text or structured content');
    }

    // The hosted Facebook tool wraps the API body in a `json` field; accept a bare body too so a
    // change of envelope does not silently turn into an empty snapshot.
    const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.json !== undefined ? parsed.json : parsed;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('The tool payload is not a JSON object');
    }
    return payload;
}

function trimSnippet(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}
