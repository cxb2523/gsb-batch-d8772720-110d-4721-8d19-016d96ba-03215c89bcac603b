// Minimal JSON-RPC transport for HasData's hosted MCP endpoint.
//
// This is the same call chain the launcher uses: a JSON-RPC `tools/call` over
// streamable HTTP with an `x-api-key` header. Keeping it in a module lets the
// batch collector (lib/collect.mjs) be driven by a real client or by a fake one
// in tests, without the collector knowing anything about HTTP.
//
// A response body arrives either as plain JSON or as server-sent events. One SSE
// event can span several `data:` lines, several events can share one response,
// and a server may send progress notifications before the answer, so every event
// is collected and the one carrying our request id is picked.

export const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=redfin';

/**
 * Parse a streamable-HTTP MCP response body and return the JSON-RPC message
 * with the given request id.
 *
 * @param {string} raw
 * @param {string|number} [id] omit to get the last message
 * @returns {object}
 */
export function parseRpcBody(raw, id) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new Error('empty MCP response');

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return parsed;
        if (id === undefined) return parsed[parsed.length - 1];
        const match = parsed.find((m) => m && m.id === id);
        if (!match) throw new Error(`no JSON-RPC message with id ${id} in the response`);
        return match;
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
    if (!messages.length) throw new Error('no JSON-RPC message in the response');
    if (id === undefined) return messages[messages.length - 1];
    const match = messages.find((m) => m && m.id === id);
    if (!match) throw new Error(`no JSON-RPC message with id ${id} in the response`);
    return match;
}

/**
 * Build a `callTool(name, args)` function that posts JSON-RPC to the hosted
 * endpoint and returns the parsed response message.
 *
 * HTTP failures are thrown as Errors carrying `status` and `body`, so the
 * collector can tell a 429 apart from a broken call.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.endpoint]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {(name: string, args?: object) => Promise<object>}
 */
export function createHttpToolCaller({
    apiKey,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
} = {}) {
    if (!apiKey) throw new Error('apiKey is required to call the Redfin MCP endpoint');
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation is available');
    let nextId = 1;

    return async function callTool(name, args = {}) {
        const id = nextId++;
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
                // The server answers over streamable HTTP, so accept both shapes.
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: { name, arguments: args },
            }),
            signal: timeoutMs && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(timeoutMs)
                : undefined,
        });

        const raw = await response.text();
        if (!response.ok) {
            const error = new Error(`MCP endpoint returned HTTP ${response.status}`);
            error.status = response.status;
            error.body = raw;
            throw error;
        }
        return parseRpcBody(raw, id);
    };
}
