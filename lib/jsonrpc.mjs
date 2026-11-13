// JSON-RPC transport for HasData's hosted MCP endpoint.
//
// This module knows only how to make ONE tools/call round trip and how to classify the
// failure modes that round trip can hit. Pagination policy, retry budgets and job state
// live in review-job.mjs so they can be tested without any network machinery.
//
// The endpoint answers over streamable HTTP: a body can be plain JSON or a sequence of
// server-sent events, and a server is free to emit progress notifications before the
// answer. Both shapes are handled here, mirroring the contract suite in test/tools.test.mjs.

export const HASDATA_YELP_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=yelp';
export const REVIEWS_TOOL = 'hasdata_yelp_reviews_getPlaceReviews';

export class RemoteCallError extends Error {
    constructor(message, { retryable = false, reason = 'unknown', statusCode = null, retryAfterMs = null, details = null } = {}) {
        super(message);
        this.name = 'RemoteCallError';
        // retryable === true means the caller is allowed to send the exact same request again.
        this.retryable = retryable;
        // Stable machine-readable code, recorded verbatim on a failed page record.
        this.reason = reason;
        this.statusCode = statusCode;
        this.retryAfterMs = retryAfterMs;
        this.details = details;
    }
}

const RATE_LIMIT_PATTERN = /concurrency_limit|rate.?limit|too many requests/i;

function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    // Retry-After is either delta-seconds or an HTTP date. We only need the delay form;
    // a date gets converted against the local clock, and a garbage value is ignored.
    if (/^\s*\d+\s*$/.test(headerValue)) return Number(headerValue) * 1000;
    const dateMs = Date.parse(headerValue);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
}

function parseRpcMessage(raw, id) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return JSON.parse(trimmed);
    }

    const messages = [];
    for (const event of trimmed.split(/\r?\n\r?\n+/)) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
            messages.push(JSON.parse(data));
        } catch {
            // A keep-alive or partial event is not our response.
        }
    }
    if (!messages.length) {
        throw new RemoteCallError(`response carried no JSON-RPC message: ${raw.slice(0, 200)}`, {
            reason: 'bad_response',
        });
    }
    return messages.find((message) => message.id === id) ?? messages[messages.length - 1];
}

/**
 * One tools/call request. Never resolves to an envelope: it unwraps the MCP text content
 * item and parses the tool's own JSON payload. Throws RemoteCallError on every failure,
 * with `retryable` set for 429 / concurrency_limit / transport-level errors.
 */
export async function callTool({
    endpoint = HASDATA_YELP_ENDPOINT,
    apiKey,
    toolName = REVIEWS_TOOL,
    args = {},
    id,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
}) {
    let response;
    // An explicit controller rather than AbortSignal.timeout(): on Windows the latter's
    // internal timer can race process teardown and trip a libuv handle assertion when the
    // CLI exits right after the final response. Clearing the timer ourselves avoids it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        response = await fetchImpl(endpoint, {
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
            signal: controller.signal,
        });
    } catch (error) {
        // A dropped connection, DNS failure or timeout never produced an answer, so the
        // same request is safe to replay.
        throw new RemoteCallError(`network error: ${error.message}`, {
            retryable: true,
            reason: 'network_error',
            details: { name: error.name },
        });
    } finally {
        clearTimeout(timer);
    }

    const raw = await response.text();
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));

    if (response.status === 429 || RATE_LIMIT_PATTERN.test(raw)) {
        throw new RemoteCallError('rate limited: 429 / concurrency_limit', {
            retryable: true,
            reason: 'concurrency_limit',
            statusCode: response.status,
            retryAfterMs,
        });
    }
    if (!response.ok) {
        // 401, 400, 500 (non-rate-limit) and friends: replaying the same request cannot
        // help, so the page fails immediately instead of burning the retry budget.
        throw new RemoteCallError(`remote answered HTTP ${response.status}`, {
            reason: `http_${response.status}`,
            statusCode: response.status,
        });
    }

    const message = parseRpcMessage(raw, id);

    if (message.error) {
        const rendered = JSON.stringify(message.error);
        if (RATE_LIMIT_PATTERN.test(rendered)) {
            throw new RemoteCallError(message.error.message || 'concurrency_limit', {
                retryable: true,
                reason: 'concurrency_limit',
                details: message.error,
            });
        }
        throw new RemoteCallError(
            `JSON-RPC error ${message.error.code ?? '?'}: ${message.error.message ?? 'unknown'}`,
            { reason: 'jsonrpc_error', details: message.error }
        );
    }

    const result = message.result;
    const textItem = Array.isArray(result?.content)
        ? result.content.find((item) => item.type === 'text')
        : null;

    if (result?.isError || !textItem) {
        const detail = textItem?.text ?? raw.slice(0, 300);
        if (RATE_LIMIT_PATTERN.test(detail)) {
            throw new RemoteCallError('tool call reported concurrency_limit', {
                retryable: true,
                reason: 'concurrency_limit',
            });
        }
        throw new RemoteCallError(`tool call failed: ${detail.slice(0, 200)}`, {
            reason: 'tool_error',
        });
    }

    try {
        return JSON.parse(textItem.text);
    } catch (error) {
        throw new RemoteCallError(`tool output was not JSON: ${error.message}`, {
            reason: 'bad_payload',
        });
    }
}

/**
 * Run callTool with an increasing backoff. Retry-After wins over the computed delay when
 * the server supplies one. Returns the payload plus the number of attempts spent, which
 * the job records on the page for audit purposes.
 */
export async function callToolWithRetry(options, retryOptions = {}, sleepOverride) {
    const { maxAttempts = 4, baseDelayMs = 2000 } = retryOptions;
    const doSleep =
        sleepOverride ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let lastError;
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attempts = attempt;
        try {
            const payload = await callTool({ ...options, id: attempt === 1 ? options.id : options.id + attempt - 1 });
            return { payload, attempts };
        } catch (error) {
            lastError = error;
            const retriesLeft = attempt < maxAttempts;
            if (!error.retryable || !retriesLeft) break;
            const delayMs = error.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1);
            await doSleep(delayMs, attempt);
        }
    }
    // Surface how many attempts the page consumed so the job record can audit it.
    lastError.attempts = attempts;
    throw lastError;
}
