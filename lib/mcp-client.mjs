// Minimal JSON-RPC client for HasData's streamable-HTTP MCP endpoint.
//
// The package's index.mjs reaches the same server through mcp-remote for an interactive MCP
// client. The catalogue runner needs plain request/response calls from Node instead, so this
// speaks JSON-RPC 2.0 directly. A body arrives either as plain JSON or as server-sent events;
// several events can share one response and progress notifications may precede the answer, so
// every event is collected and the message matching the request id wins.

const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=shopify';
const DEFAULT_TIMEOUT_MS = 60_000;

export const TOOLS = Object.freeze({
    PRODUCTS: 'hasdata_shopify_products_getProducts',
    COLLECTIONS: 'hasdata_shopify_collections_getCollections',
});

function parseRpc(raw, id) {
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
    if (messages.length === 0) {
        throw new Error(`the MCP server returned no JSON-RPC message: ${raw.slice(0, 300)}`);
    }
    const match = messages.find((message) => message.id === id);
    if (!match) {
        throw new Error(`no JSON-RPC message with id ${id} in: ${raw.slice(0, 300)}`);
    }
    return match;
}

// Tool results are JSON-RPC content parts, each carrying a text blob. Parse every blob and hand
// back the first object that parses: that is the documented products/collections payload.
function extractPayload(message, raw) {
    const content = message?.result?.content;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (part?.type !== 'text' || typeof part.text !== 'string') continue;
            try {
                return JSON.parse(part.text);
            } catch {
                // Some text parts are human-readable notes; keep looking.
            }
        }
    }
    // Keep the raw text available so concurrency_limit markers cannot disappear into a parse error.
    return { error: raw.slice(0, 500) };
}

export class HasdataShopifyClient {
    constructor(options = {}) {
        this.apiKey = options.apiKey ?? process.env.HASDATA_API_KEY;
        this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.nextId = 1;

        if (!this.apiKey) {
            throw new Error(
                'HASDATA_API_KEY is not set. Create a free key at https://app.hasdata.com and set HASDATA_API_KEY.'
            );
        }
    }

    async callTool(name, args = {}) {
        const id = this.nextId++;
        let response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (cause) {
            // Normalised into the same reply shape the engine understands; a transport failure is
            // not a rate limit, so scanCollection records it as a non-Shopify outcome and moves on.
            return { status: 0, payload: { error: `network error calling ${name}: ${cause.message}` }, raw: '' };
        }

        const raw = await response.text();
        if (response.status === 429) {
            return { status: 429, payload: null, raw };
        }
        if (!response.ok) {
            return { status: response.status, payload: { error: `HTTP ${response.status}: ${raw.slice(0, 300)}` }, raw };
        }

        let message;
        try {
            message = parseRpc(raw, id);
        } catch (cause) {
            return { status: response.status, payload: { error: cause.message }, raw };
        }

        if (message.error) {
            return { status: response.status, payload: { error: JSON.stringify(message.error) }, raw };
        }
        return { status: response.status, payload: extractPayload(message, raw), raw, isError: Boolean(message.result?.isError) };
    }

    // Bound call shaped for scanCollection: ({collection, limit, page}) -> reply.
    makeProductsFetcher(url) {
        return ({ collection, limit, page }) =>
            this.callTool(TOOLS.PRODUCTS, { url, collection, limit, page });
    }

    async listCollections(url) {
        const reply = await this.callTool(TOOLS.COLLECTIONS, { url, limit: 250, page: 1 });
        if (!reply.payload || !Array.isArray(reply.payload.collections)) {
            return { ok: false, error: reply.payload?.error ?? 'no collections array in the response', reply };
        }
        return { ok: true, collections: reply.payload.collections, reply };
    }
}
