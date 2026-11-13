// Default scrape-call adapter: one JSON-RPC tools/call against the same remote MCP endpoint
// the stdio launcher proxies to. The remote server is untouched and still exposes exactly
// one tool; this module is just a local, injectable way to call it programmatically.
//
// Nothing here is imported by index.mjs, so the stdio launcher behaves exactly as before.
// Tests replace this adapter (or just the fetch dependency) and therefore need no API key.

import { ScrapeToolError, TOOL_NAME, statusCodeOf } from './scrape-errors.mjs';

export const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=web_scraping';
const DEFAULT_TIMEOUT_MS = 45_000;

// A streamable HTTP body arrives either as plain JSON or as server-sent events. One SSE
// event can span several data: lines, and progress notifications can precede the answer, so
// collect every event and pick the message carrying our request id.
function parseRpc(raw, id) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);

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
        throw new ScrapeToolError(`the MCP server returned no JSON-RPC message: ${raw.slice(0, 300)}`);
    }
    const match = messages.find((message) => message.id === id);
    if (!match) {
        throw new ScrapeToolError(`no JSON-RPC message with id ${id} in: ${raw.slice(0, 300)}`);
    }
    return match;
}

function asNumber(value) {
    if (value === undefined || value === null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// JSON-RPC level errors: HTTP 4xx envelopes and server-side error objects. 429 and the
// concurrency_limit code are flagged retryable so the orchestrator can back off.
function rpcErrorToToolError(rpcError, httpStatus) {
    const data = rpcError?.data && typeof rpcError.data === 'object' ? rpcError.data : {};
    const message = String(rpcError?.message || 'the MCP server rejected the tools/call request');
    // A 200 envelope means the transport itself succeeded; only the JSON-RPC layer failed.
    // Attaching that 200 as the outcome status would pretend the target answered, so only a
    // non-200 transport status is meaningful here (e.g. 400 unreachable, 429 rate limited).
    const transportStatus = httpStatus && httpStatus !== 200 ? httpStatus : null;
    const statusCode = asNumber(transportStatus) ?? asNumber(data.statusCode) ?? asNumber(data.status) ?? null;
    const errorType = data.errorType ?? (String(message).includes('proxyConnection') ? 'proxyConnection' : null);
    const retryable =
        statusCode === 429 ||
        errorType === 'concurrency_limit' ||
        message.includes('429') ||
        message.toLowerCase().includes('concurrency_limit');
    return new ScrapeToolError(message, { errorType, statusCode, retryable });
}

// Tool-level errors are returned with HTTP 200: isError on the result object and/or an
// error block inside the tool's JSON payload. A 403/404 target status is NOT an error here,
// it stays a normal payload so the orchestrator can classify it as blocked.
function parseToolResultError(result) {
    if (result?.isError !== true) return null;
    const text = result.content?.find?.((part) => part?.type === 'text')?.text;
    let parsed = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            // The text part may itself be the human-readable error.
        }
    }
    const errorBlock = parsed?.error && typeof parsed.error === 'object' ? parsed.error : null;
    const message =
        errorBlock?.message ||
        (typeof text === 'string' && text ? text : 'the scrape tool reported an error');
    const errorType = errorBlock?.errorType ?? null;
    const statusCode = asNumber(errorBlock?.statusCode) ?? statusCodeOf(parsed);
    const retryable =
        statusCode === 429 ||
        errorType === 'concurrency_limit' ||
        String(message).includes('429') ||
        String(message).toLowerCase().includes('concurrency_limit');
    return new ScrapeToolError(String(message), { errorType, statusCode, retryable });
}

// Some failure payloads come back as a successful tool result carrying an error/errorType
// block alongside the usual fields (proxy connection failures do this). Surface them as
// errors, while leaving 403/404 target responses untouched.
function inspectPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const block = payload.error && typeof payload.error === 'object' ? payload.error : null;
    const errorType = block?.errorType ?? payload.errorType ?? null;
    if (block || errorType) {
        const statusCode = asNumber(block?.statusCode) ?? statusCodeOf(payload);
        const message = String(block?.message || payload.message || 'the scrape call failed');
        const retryable =
            statusCode === 429 ||
            errorType === 'concurrency_limit' ||
            String(message).includes('429') ||
            String(message).toLowerCase().includes('concurrency_limit');
        throw new ScrapeToolError(message, { errorType, statusCode, retryable });
    }
    return payload;
}

function buildArguments(request) {
    // Pass through exactly the documented parameters; only set what the caller supplied so
    // the server's own defaults (e.g. jsRendering on) keep applying.
    const args = { url: request.url };
    for (const key of [
        'outputFormat', 'jsRendering', 'proxyType', 'proxyCountry', 'headers', 'wait', 'waitFor',
        'jsScenario', 'extractRules', 'aiExtractRules', 'extractLinks', 'extractEmails',
        'screenshot', 'blockResources', 'blockAds', 'blockUrls', 'includeOnlyTags',
        'excludeTags', 'removeBase64Images',
    ]) {
        if (request[key] !== undefined) args[key] = request[key];
    }
    return args;
}

// Creates the default scrape call. All collaborators are injectable so tests exercise the
// JSON-RPC/SSE/error translation with a fake fetch and never touch the network or need a key.
export function createRemoteScraper(options = {}) {
    const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const apiKey = options.apiKey ?? process.env.HASDATA_API_KEY;
    let nextId = 1;

    return async function scrape(request) {
        if (!fetchImpl) {
            throw new ScrapeToolError('no fetch implementation is available', {
                errorType: 'transportError',
            });
        }
        if (!apiKey) {
            // Match the launcher's wording; fail lazily on the first call rather than at
            // import time, so modules that only use an injected fake never require a key.
            throw new ScrapeToolError(
                'HASDATA_API_KEY is not set. Create a free key at https://app.hasdata.com and set HASDATA_API_KEY.',
                { errorType: 'configurationError' },
            );
        }

        let httpStatus = null;
        let raw;
        const requestId = nextId++;
        try {
            const res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'tools/call',
                    params: { name: TOOL_NAME, arguments: buildArguments(request) },
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            httpStatus = res.status;
            raw = await res.text();
        } catch (error) {
            if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                throw new ScrapeToolError(`the MCP request timed out after ${timeoutMs}ms`, {
                    errorType: 'timeout',
                    cause: error,
                });
            }
            // DNS failure, connection refused, reset ... the endpoint itself is unreachable.
            throw new ScrapeToolError(`could not reach the MCP endpoint: ${error?.message ?? error}`, {
                errorType: 'transportError',
                cause: error,
            });
        }

        // A non-200 transport status carries an error envelope rather than a tool result.
        if (httpStatus !== 200) {
            let rpcError = null;
            try {
                const envelope = JSON.parse(raw);
                rpcError = envelope.error ?? envelope;
            } catch {
                rpcError = { message: `the MCP endpoint answered HTTP ${httpStatus}: ${raw.slice(0, 200)}` };
            }
            throw rpcErrorToToolError(rpcError, httpStatus);
        }

        const message = parseRpc(raw, requestId);
        if (message.error) throw rpcErrorToToolError(message.error, httpStatus);

        const result = message.result;
        if (!result || typeof result !== 'object') {
            throw new ScrapeToolError('the MCP response carried no tools/call result');
        }

        const toolError = parseToolResultError(result);
        if (toolError) throw toolError;

        const text = result.content?.find?.((part) => part?.type === 'text')?.text;
        if (typeof text !== 'string') {
            throw new ScrapeToolError('the tool result contained no text content');
        }
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            throw new ScrapeToolError(`the tool result was not valid JSON: ${text.slice(0, 200)}`, {
                cause: error,
            });
        }
        return inspectPayload(payload);
    };
}
