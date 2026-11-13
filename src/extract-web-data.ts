import nodeFetch from 'node-fetch';

export const EXTRACT_TOOL_NAME = 'extract-web-data';
export const AGENTQL_ENDPOINT = 'https://api.agentql.com/v1/query-data';

/** Maximum number of characters of an upstream body that is echoed back to the caller. */
const MAX_EXCERPT_LENGTH = 500;

export interface ToolTextContent {
  type: 'text';
  text: string;
}

export type ToolResult = {
  content: ToolTextContent[];
  isError?: boolean;
};

/**
 * Minimal subset of the WHATWG/node-fetch Response API used by the extraction call.
 * Keeping it small makes it possible to inject a fake upstream in tests.
 */
export interface MinimalResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<MinimalResponse>;

export interface ExtractWebDataOptions {
  /** Override the fetch implementation (tests inject a fake upstream). */
  fetch?: FetchLike;
  /** Override the API key; defaults to AGENTQL_API_KEY from the environment. */
  apiKey?: string;
  /** Override the query-data endpoint; intended for tests pointing at a local mock upstream. */
  endpoint?: string;
}

function successResult(data: unknown): ToolResult {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [
      {
        type: 'text',
        text: text === undefined ? String(data) : text,
      },
    ],
  };
}

function failureResult(text: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Produce a bounded, human-readable excerpt of an upstream response body.
 * Never throws, even if the body is empty.
 */
export function excerptOfBody(body: string, maxLength: number = MAX_EXCERPT_LENGTH): string {
  const normalized = typeof body === 'string' ? body.trim() : '';
  if (!normalized) {
    return '(empty response body)';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}... (truncated, ${normalized.length} characters total)`;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const name = error.name || 'Error';
  const message = error.message || '';
  const parts: string[] = [];

  if (name === 'AbortError') {
    parts.push(`request aborted or timed out (${name}: ${message || 'no message'})`);
  } else {
    parts.push(`${name}: ${message || 'no message'}`);
  }

  const errorWithCode = error as Error & { code?: unknown; cause?: unknown };
  if (errorWithCode.code !== undefined && !parts[0].includes(String(errorWithCode.code))) {
    parts.push(`code: ${String(errorWithCode.code)}`);
  }

  const cause = errorWithCode.cause;
  if (cause instanceof Error) {
    if (cause.message && !parts.join(' ').includes(cause.message)) {
      parts.push(`cause: ${cause.message}`);
    }
  } else if (typeof cause === 'string' && cause && !parts.join(' ').includes(cause)) {
    parts.push(`cause: ${cause}`);
  }

  return parts.join('; ');
}

function readStringArgument(args: unknown, field: 'url' | 'prompt'): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const value = args[field];
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim() === '' ? undefined : value;
}

/**
 * Run the `extract-web-data` tool.
 *
 * Every possible outcome is returned as MCP tool text content: successes contain
 * the extracted data, failures contain a diagnostic explaining what went wrong.
 * This function never throws for expected failure modes (bad arguments, upstream
 * errors, malformed responses, network errors).
 */
export async function runExtractWebData(
  args: unknown,
  options: ExtractWebDataOptions = {},
): Promise<ToolResult> {
  const url = readStringArgument(args, 'url');
  const prompt = readStringArgument(args, 'prompt');

  const missing: Array<'url' | 'prompt'> = [];
  if (url === undefined) {
    missing.push('url');
  }
  if (prompt === undefined) {
    missing.push('prompt');
  }

  if (missing.length > 0) {
    const fields = missing.map((field) => `'${field}'`).join(' and ');
    const label = missing.length > 1 ? 'arguments' : 'argument';
    const hints = missing
      .map((field) =>
        field === 'url'
          ? "'url' must be the non-empty URL of the public webpage to extract data from"
          : "'prompt' must be a non-empty natural-language description of the data to extract",
      )
      .join('; ');
    return failureResult(
      `Extraction failed: missing required ${label} ${fields}. ${hints}. ` +
        `No request was sent to the AgentQL API.`,
    );
  }

  const apiKey = options.apiKey ?? process.env.AGENTQL_API_KEY;
  if (!apiKey) {
    return failureResult(
      `Extraction failed: AGENTQL_API_KEY is not configured, so the AgentQL query-data API could not be called. ` +
        `Set the AGENTQL_API_KEY environment variable and retry. No request was sent to the AgentQL API.`,
    );
  }

  const fetchImpl = options.fetch ?? (nodeFetch as unknown as FetchLike);
  const endpoint = options.endpoint ?? AGENTQL_ENDPOINT;

  let response: MinimalResponse;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key': `${apiKey}`,
        'X-TF-Request-Origin': 'mcp-server',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: url,
        prompt: prompt,
        params: {
          wait_for: 0,
          is_scroll_to_bottom_enabled: false,
          mode: 'fast',
          is_screenshot_enabled: false,
        },
      }),
    });
  } catch (error) {
    return failureResult(
      `Extraction failed: network error while calling the AgentQL query-data API at ${endpoint}. ` +
        `Reason: ${describeError(error)}. No data was extracted.`,
    );
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    return failureResult(
      `Extraction failed: network error while reading the AgentQL query-data API response ` +
        `(HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}). ` +
        `Reason: ${describeError(error)}. The response body could not be read, so no data was extracted.`,
    );
  }

  if (!response.ok) {
    const statusDescription = response.statusText
      ? `HTTP ${response.status} (${response.statusText})`
      : `HTTP ${response.status}`;
    return failureResult(
      `Extraction failed: the AgentQL query-data API returned ${statusDescription}. ` +
        `Upstream response body excerpt: ${excerptOfBody(bodyText)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : String(error);
    return failureResult(
      `Extraction failed: the AgentQL query-data API response is not valid JSON and could not be parsed ` +
        `(parser error: ${parseMessage}). Raw response excerpt: ${excerptOfBody(bodyText)}`,
    );
  }

  if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'data')) {
    return failureResult(
      `Extraction failed: the AgentQL query-data API response is valid JSON but is missing the required 'data' field. ` +
        `Raw response excerpt: ${excerptOfBody(bodyText)}`,
    );
  }

  return successResult(parsed.data);
}
