// Minimal MCP client for HasData's hosted Glassdoor server.
//
// The server speaks JSON-RPC over streamable HTTP. A response body arrives either as plain
// JSON or as server-sent events, so both are parsed here. The only method this collector
// needs is tools/call, and the server accepts it without a separate initialize handshake.
//
// Retry policy lives here so every caller gets the same one:
//   * HTTP 429, or a body carrying `concurrency_limit`, is retried with an increasing wait.
//   * A 401, or an authorization error inside a 200 response, fails at once and is never retried.
//   * Every other non-2xx status and every other error stops the page.
//
// The client never invents request parameters. It sends exactly what the caller passes.

export const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=glassdoor';
export const DEFAULT_MAX_RETRIES = 5;

const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_CAP_MS = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortSignal(ms) {
  if (!ms || ms <= 0) return undefined;
  // AbortSignal.timeout exists in every Node version this package supports (>=18).
  return AbortSignal.timeout(ms);
}

// A streamable HTTP body is either JSON or a run of SSE events. Several events can share one
// response, a single event can span several data: lines, and the server may send progress
// notifications before the answer. Collect every message and pick the one with our id.
export function parseRpc(raw, id) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('the response body was empty');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const match = parsed.find((m) => m && m.id === id);
      if (match) return match;
      throw new Error('the JSON-RPC response carried no message for this request');
    }
    return parsed;
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

  return messages.find((m) => m && m.id === id) ?? messages[messages.length - 1];
}

// The hosted server reports a rejected key in more than one way: a real HTTP 401, an
// `isError` tool result whose text says the key is invalid or the key is missing, or a body
// carrying `invalid_token` / `WWW-Authenticate`. All of them are terminal: retrying a bad key
// only burns time and credits.
//
// The plain-text patterns are only consulted when the body actually reports an error. A
// successful payload is full of job text, and matching "unauthorized" inside a posting would
// be a false positive.
const AUTH_TEXT_PATTERN = /invalid_token|invalid api key|unauthorized|authorization is required/i;
const AUTH_HEADER_PATTERN = /www_authenticate|mcp\/www_authenticate|oauth-protected-resource/i;

function isAuthorizationFailure(status, raw) {
  if (status === 401 || status === 403) return true;
  const text = String(raw ?? '');
  if (AUTH_HEADER_PATTERN.test(text)) return true;
  const reportsError = /"isError"\s*:\s*true/.test(text) || /"error"\s*:/.test(text);
  return reportsError && AUTH_TEXT_PATTERN.test(text);
}

// The tool result nests the actual payload as JSON text. Restrict to the listing response:
// `{ json: { jobs, pagination, ... } }`. Some deployments answer with the inner object
// directly, so both shapes are accepted.
function extractToolPayload(result) {
  if (result && typeof result === 'object' && result.structuredContent && typeof result.structuredContent === 'object') {
    return { data: unwrap(result.structuredContent) };
  }

  const content = Array.isArray(result?.content) ? result.content : [];
  const textPart = content.find((part) => part?.type === 'text' && typeof part.text === 'string');
  if (!textPart) return { error: 'the tool result carried no text content' };

  let parsed;
  try {
    parsed = JSON.parse(textPart.text);
  } catch {
    return { error: 'the tool result text was not JSON' };
  }
  return { data: unwrap(parsed) };
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'json' in payload) {
    let inner = payload.json;
    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner);
      } catch {
        return payload;
      }
    }
    return inner;
  }
  return payload;
}

function truncate(value, limit = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Create a client bound to one endpoint.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint]
 * @param {string} [options.apiKey] sent as x-api-key when present
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRetries] retries after the first attempt; default 5
 * @param {number} [options.retryBaseMs] first backoff wait, doubled on each retry
 * @param {number} [options.retryCapMs] upper bound on a single wait
 * @param {Function} [options.sleep]
 * @param {Function} [options.onRetry] called with { attempt, delayMs, status, tool }
 */
export function createMcpClient({
  endpoint = DEFAULT_ENDPOINT,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryCapMs = DEFAULT_RETRY_CAP_MS,
  sleep: sleepImpl = sleep,
  onRetry,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('a fetch implementation is required');
  if (!endpoint) throw new TypeError('an endpoint is required');

  let nextId = 1;

  async function callTool(name, args = {}) {
    const attemptsAllowed = Math.max(0, Number(maxRetries) || 0) + 1;

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      const id = nextId++;
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (apiKey) headers['x-api-key'] = apiKey;

      let response;
      let raw;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
          signal: abortSignal(timeoutMs),
        });
        raw = await response.text();
      } catch (error) {
        return {
          ok: false,
          kind: 'network',
          attempts: attempt,
          status: null,
          message: `the request failed before a response arrived: ${truncate(error?.message ?? error)}`,
        };
      }

      if (isAuthorizationFailure(response.status, raw)) {
        return {
          ok: false,
          kind: 'auth',
          attempts: attempt,
          status: response.status,
          message: 'the API key was rejected (401 / invalid_token)',
        };
      }

      const text = String(raw ?? '');
      const rateLimited = response.status === 429 || text.includes('concurrency_limit');
      if (rateLimited) {
        if (attempt <= maxRetries) {
          const delayMs = Math.min(retryCapMs, retryBaseMs * 2 ** (attempt - 1));
          onRetry?.({ attempt, delayMs, status: response.status, tool: name });
          await sleepImpl(delayMs);
          continue;
        }
        return {
          ok: false,
          kind: 'rate_limited',
          attempts: attempt,
          status: response.status,
          message: `still rate limited after ${attempt} attempts`,
        };
      }

      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          kind: 'http',
          attempts: attempt,
          status: response.status,
          message: `HTTP ${response.status}: ${truncate(text)}`,
        };
      }

      let message;
      try {
        message = parseRpc(text, id);
      } catch (error) {
        return {
          ok: false,
          kind: 'invalid',
          attempts: attempt,
          status: response.status,
          message: `the response was not JSON-RPC: ${truncate(error?.message ?? error)}`,
        };
      }

      if (message?.error) {
        return {
          ok: false,
          kind: 'rpc',
          attempts: attempt,
          status: response.status,
          message: `JSON-RPC error ${message.error.code ?? ''}: ${truncate(message.error.message)}`.trim(),
        };
      }

      const result = message?.result;
      if (result?.isError) {
        return {
          ok: false,
          kind: 'tool',
          attempts: attempt,
          status: response.status,
          message: `the tool returned an error: ${truncate(text)}`,
        };
      }

      const extracted = extractToolPayload(result);
      if (extracted.error) {
        return {
          ok: false,
          kind: 'invalid',
          attempts: attempt,
          status: response.status,
          message: extracted.error,
        };
      }

      return { ok: true, data: extracted.data, status: response.status, attempts: attempt };
    }

    // Unreachable: the loop either returns or exhausts attemptsAllowed.
    return { ok: false, kind: 'unknown', attempts: attemptsAllowed, status: null, message: 'retry loop ended unexpectedly' };
  }

  return { endpoint, callTool };
}
