// Minimal JSON-RPC 2.0 client for HasData's streamable-HTTP MCP endpoint.
//
// The endpoint answers either with a plain JSON body or with server-sent events, where one
// response can span several `data:` lines and progress notifications can share the stream.
// Both shapes are handled here, mirroring the parsing the contract test does by hand.
//
// This layer only speaks the transport. Retry policy, billing accounting and the review
// collection flow live in reviews.mjs and are unit-tested against an injected callTool, so
// nothing here retries on its own: a non-200 response becomes a typed error the caller decides
// what to do with.

const DEFAULT_TIMEOUT_MS = 30_000;

/** A non-200 HTTP answer (or a transport failure). Non-200 calls are not billed by HasData. */
export class McpHttpError extends Error {
    constructor(message, { status, body, retryAfterMs } = {}) {
        super(message);
        this.name = 'McpHttpError';
        this.status = status ?? null;
        this.body = body ?? '';
        this.retryAfterMs = retryAfterMs ?? null;
    }

    get isRateLimited() {
        return this.status === 429;
    }
}

/** A JSON-RPC error envelope, or a tool result the server flagged with isError. */
export class McpToolError extends Error {
    constructor(message, { toolName = null, code = null, payload = null } = {}) {
        super(message);
        this.name = 'McpToolError';
        this.toolName = toolName;
        this.code = code;
        this.payload = payload;
    }
}

// Retry-After is either seconds ("120") or an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT").
// Anything unparseable yields null so the caller falls back to its own backoff.
function parseRetryAfter(header, nowMs) {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
    return null;
}

// Split an SSE stream into individual JSON-RPC messages. Plain JSON bodies pass through.
export function parseRpcMessages(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return [JSON.parse(trimmed)];
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
            // A keep-alive comment or a partial event is not a JSON-RPC message.
        }
    }
    return messages;
}

// MCP tool results wrap the payload in text content blocks. HasData's tools return one JSON
// text block; parse it when possible and otherwise hand the raw result back untouched.
function parseToolContent(result, toolName) {
    const textBlock = Array.isArray(result?.content)
        ? result.content.find((block) => block && block.type === 'text' && typeof block.text === 'string')
        : null;
    if (!textBlock) return result;
    try {
        return JSON.parse(textBlock.text);
    } catch {
        throw new McpToolError(`tool ${toolName} returned a non-JSON text payload`, {
            toolName,
            payload: result,
        });
    }
}

export function createMcpClient({
    endpoint,
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    if (!endpoint) throw new Error('createMcpClient needs an endpoint URL');
    if (typeof fetchImpl !== 'function') throw new Error('createMcpClient needs a fetch implementation');

    let nextId = 1;

    async function request(method, params = {}) {
        const id = nextId++;
        let res;
        try {
            res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    ...(apiKey ? { 'x-api-key': apiKey } : {}),
                    'Content-Type': 'application/json',
                    // The server answers over streamable HTTP: accept both a plain body and a stream.
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            // A network failure or timeout never reached a billed response.
            throw new McpHttpError(`MCP ${method} request failed before an answer: ${error.message}`, {
                status: null,
                body: '',
            });
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new McpHttpError(`MCP ${method} failed with HTTP ${res.status}`, {
                status: res.status,
                body,
                retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), Date.now()),
            });
        }

        const raw = await res.text();
        const messages = parseRpcMessages(raw);
        const match = messages.find((message) => message.id === id);
        if (!match) {
            throw new McpToolError(`no JSON-RPC message with id ${id} in the response`, {
                code: null,
                payload: { raw: raw.slice(0, 500) },
            });
        }
        if (match.error) {
            throw new McpToolError(match.error.message || 'JSON-RPC error response', {
                code: match.error.code ?? null,
                payload: match.error,
            });
        }
        return match.result;
    }

    return {
        request,
        listTools: async () => {
            const result = await request('tools/list');
            return result?.tools ?? [];
        },
        // Resolves to the parsed tool payload, or rejects with McpToolError when isError is set.
        callTool: async (name, args = {}) => {
            const result = await request('tools/call', { name, arguments: args });
            if (result?.isError) {
                throw new McpToolError(`tool ${name} returned an error result`, { toolName: name, payload: result });
            }
            return parseToolContent(result, name);
        },
    };
}
