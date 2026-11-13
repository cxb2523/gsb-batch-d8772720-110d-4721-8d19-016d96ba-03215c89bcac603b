// A JSON-RPC client for HasData's streamable-HTTP MCP endpoint, plus the single
// place that maps any server answer onto a typed outcome.
//
// The remote server almost never answers a tools/call with an HTTP error. It answers
// 200 and puts the failure inside the JSON-RPC payload, either as an `error` object or
// as a result whose `isError` flag is set. So classifying a call means looking at the
// payload text as well as the status line. Every outcome below is a stable string the
// orchestration layer (and its callers) can switch on.

export const ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=google_serp';

// Canonical outcomes. Only RATE_LIMITED is ever retried.
export const OUTCOMES = Object.freeze({
    SUCCESS: 'success',
    RATE_LIMITED: 'rate_limited',
    TOKEN_EXPIRED: 'token_expired',
    AUTH_FAILED: 'auth_failed',
    INVALID_PARAMS: 'invalid_params',
    OTHER_ERROR: 'other_error',
});

// A streamable-HTTP body arrives either as plain JSON or as server-sent events. One SSE
// event can span several data: lines, several events can share one response, and a
// server is free to send progress notifications before the answer. Collect every event
// and pick the message carrying our request id.
export function parseRpcMessage(raw, id) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const message = JSON.parse(trimmed);
        return Array.isArray(message) ? message.find((m) => m.id === id) : message;
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
            // A keep-alive or a partial event is not our response.
        }
    }
    const match = messages.find((m) => m && m.id === id);
    if (!match) {
        throw new Error(`no JSON-RPC message with id ${id} in response: ${raw.slice(0, 300)}`);
    }
    return match;
}

// Pull the tool text block out of a tools/call result and, when it is the documented
// envelope, keep both the envelope and the scraped `json` payload.
function extractPayload(message) {
    const text = message?.result?.content?.[0]?.text;
    if (typeof text !== 'string') return { text: undefined, envelope: undefined, json: undefined };
    let envelope;
    try {
        envelope = JSON.parse(text);
    } catch {
        // A non-JSON text block is still a usable response; callers get the raw text.
        return { text, envelope: undefined, json: undefined };
    }
    return { text, envelope, json: envelope?.json };
}

// Turn one HTTP status + JSON-RPC message into a typed classification. Pure: it never
// touches the network, so the whole matrix is unit-testable with hand-written payloads.
export function classifyResponse(httpStatus, message, raw = '') {
    const haystack = (() => {
        if (message?.error) return JSON.stringify(message.error);
        const text = message?.result?.content?.map((c) => c.text).join(' ') ?? '';
        return `${text} ${raw}`;
    })();

    // 1. The concurrency plan limit. The server normally reports it inside a 200 body,
    //    but a gateway can answer 429 directly, so treat the status line the same way.
    if (httpStatus === 429 || /concurrency[_ ]limit|too many concurrent|rate limit/i.test(haystack)) {
        return {
            outcome: OUTCOMES.RATE_LIMITED,
            retryable: true,
            reason: summarize('concurrency limit reached', message, httpStatus),
        };
    }

    // 2. Auth. A missing key is a real HTTP 401; a wrong key comes back as a tool error
    //    carrying the text "401 Unauthorized".
    if (httpStatus === 401 || /401\s*unauthorized/i.test(haystack)) {
        return {
            outcome: OUTCOMES.AUTH_FAILED,
            retryable: false,
            reason: summarize('401 Unauthorized: rejected API key', message, httpStatus),
        };
    }

    // 3. An expired AI Overview / page token. The remote API renders a stale token as a
    //    400 Bad Request tool error. This is distinct from a wrong key and never retried:
    //    the token is dead, so the only remedy is a fresh SERP and a new token.
    if (httpStatus === 400 || /400\s*bad request/i.test(haystack)) {
        return {
            outcome: OUTCOMES.TOKEN_EXPIRED,
            retryable: false,
            reason: summarize('400 Bad Request: token expired or invalid', message, httpStatus),
        };
    }

    // 4. Schema rejection. MCP uses JSON-RPC code -32602 for invalid params, and the
    //    text always starts "MCP error -32602". Nothing is fetched or charged.
    const rpcCode = message?.error?.code;
    if (rpcCode === -32602 || /MCP error -32602|input validation error/i.test(haystack)) {
        return {
            outcome: OUTCOMES.INVALID_PARAMS,
            retryable: false,
            reason: summarize('MCP error -32602: input validation error', message, httpStatus),
        };
    }

    // 5. Any other JSON-RPC error envelope.
    if (message?.error) {
        return {
            outcome: OUTCOMES.OTHER_ERROR,
            retryable: false,
            reason: summarize(`JSON-RPC error ${message.error.code}: ${message.error.message}`, message, httpStatus),
        };
    }

    // 6. A tool result flagged as an error that none of the strings above matched.
    if (message?.result?.isError) {
        return {
            outcome: OUTCOMES.OTHER_ERROR,
            retryable: false,
            reason: summarize('tool returned isError', message, httpStatus),
        };
    }

    // 7. A well-formed success.
    if (message?.result) {
        const { text, envelope, json } = extractPayload(message);
        return {
            outcome: OUTCOMES.SUCCESS,
            retryable: false,
            reason: null,
            text,
            envelope,
            json,
        };
    }

    // 8. No result and no error: a malformed answer we cannot act on.
    return {
        outcome: OUTCOMES.OTHER_ERROR,
        retryable: false,
        reason: `unrecognised JSON-RPC response (HTTP ${httpStatus}): ${raw.slice(0, 300)}`,
    };
}

function summarize(prefix, message, httpStatus) {
    const detail =
        message?.error?.message ||
        message?.result?.content?.map((c) => c.text).filter(Boolean).join(' ') ||
        '';
    const suffix = detail ? ` - ${detail.slice(0, 300)}` : '';
    return `${prefix} (HTTP ${httpStatus})${suffix}`;
}

// Build a callTool function bound to one endpoint/key. Every returned object carries the
// full request bookkeeping (attempt id, http status, raw body, parsed message) alongside
// the classification, so the orchestrator can count calls and explain a failure.
export function createMcpCaller(options = {}) {
    const {
        endpoint = ENDPOINT,
        apiKey = process.env.HASDATA_API_KEY,
        fetchImpl = globalThis.fetch,
        timeoutMs = 60_000,
    } = options;

    if (!fetchImpl) throw new Error('no fetch implementation available');
    let nextId = 1;

    return async function callTool(toolName, args) {
        const id = nextId++;
        const init = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // The server answers over streamable HTTP, so accept plain JSON and SSE.
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: { name: toolName, arguments: args ?? {} },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        };
        if (apiKey) init.headers['x-api-key'] = apiKey;

        let res;
        try {
            res = await fetchImpl(endpoint, init);
        } catch (cause) {
            // A network/transport failure is an answer too: classify it, never throw
            // through the orchestration loop.
            return {
                id,
                toolName,
                args: args ?? {},
                httpStatus: 0,
                raw: '',
                message: null,
                outcome: OUTCOMES.OTHER_ERROR,
                retryable: false,
                reason: `transport error: ${cause?.message ?? cause}`,
                text: undefined,
                envelope: undefined,
                json: undefined,
            };
        }

        const httpStatus = res.status;
        const raw = await res.text();
        let message;
        try {
            message = parseRpcMessage(raw, id);
        } catch (cause) {
            // A non-JSON body (proxy HTML error page, empty 5xx, ...): still let the
            // classifier read the HTTP status, so a gateway 401/429 keeps its real type.
            const classification = classifyResponse(httpStatus, null, raw);
            if (classification.outcome !== OUTCOMES.OTHER_ERROR) {
                return {
                    id,
                    toolName,
                    args: args ?? {},
                    httpStatus,
                    raw,
                    message: null,
                    ...classification,
                };
            }
            return {
                id,
                toolName,
                args: args ?? {},
                httpStatus,
                raw,
                message: null,
                outcome: OUTCOMES.OTHER_ERROR,
                retryable: false,
                reason: `unparseable response: ${cause?.message ?? cause}`,
                text: undefined,
                envelope: undefined,
                json: undefined,
            };
        }

        const classification = classifyResponse(httpStatus, message, raw);
        return {
            id,
            toolName,
            args: args ?? {},
            httpStatus,
            raw,
            message,
            ...classification,
        };
    };
}
