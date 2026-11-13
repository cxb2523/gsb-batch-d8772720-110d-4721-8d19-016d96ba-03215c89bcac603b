import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENTQL_ENDPOINT,
  type FetchLike,
  type MinimalResponse,
  type RequestInitLike,
  runExtractWebData,
} from '../src/extract-web-data.js';

interface RecordedCall {
  url: string;
  init: RequestInitLike;
}

/**
 * Build a fake upstream `fetch` from a canned outcome. Records every call so a
 * test can assert that no request escaped the tool.
 */
function fakeFetch(
  outcome: { response: MinimalResponse } | { error: unknown },
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if ('error' in outcome) {
      throw outcome.error;
    }
    return outcome.response;
  };
  return { fetch, calls };
}

function jsonResponse(status: number, statusText: string, body: string): MinimalResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
  };
}

/** Extract the single text payload returned by the tool. */
function textOf(result: { content: Array<{ type: 'text'; text: string }> }): string {
  assert.equal(result.content.length, 1, 'expected exactly one content block');
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

const API_KEY = 'test-api-key';
const ARGS = {
  url: 'https://example.com/pricing',
  prompt: 'Extract each pricing plan as name and monthly price',
};

describe('extract-web-data tool', () => {
  it('returns the upstream data as indented JSON on success', async () => {
    const payload = { data: { plans: [{ name: 'Basic', price: 9 }, { name: 'Pro', price: 29 }] } };
    const { fetch, calls } = fakeFetch({
      response: jsonResponse(200, 'OK', JSON.stringify(payload)),
    });

    const result = await runExtractWebData(ARGS, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.equal(text, JSON.stringify(payload.data, null, 2));
    assert.deepEqual(JSON.parse(text), payload.data);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, AGENTQL_ENDPOINT);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-API-Key'], API_KEY);
    assert.equal(calls[0].init.headers['X-TF-Request-Origin'], 'mcp-server');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    const sentBody = JSON.parse(calls[0].init.body);
    assert.equal(sentBody.url, ARGS.url);
    assert.equal(sentBody.prompt, ARGS.prompt);
  });

  it('reports a missing url without calling the upstream API', async () => {
    const { fetch, calls } = fakeFetch({
      response: jsonResponse(200, 'OK', JSON.stringify({ data: {} })),
    });

    const result = await runExtractWebData({ prompt: ARGS.prompt }, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /missing required argument 'url'/);
    assert.doesNotMatch(text, /'prompt'/);
    assert.equal(calls.length, 0, 'no HTTP request must be sent when url is missing');
  });

  it('reports a missing prompt without calling the upstream API', async () => {
    const { fetch, calls } = fakeFetch({
      response: jsonResponse(200, 'OK', JSON.stringify({ data: {} })),
    });

    const result = await runExtractWebData({ url: ARGS.url }, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /missing required argument 'prompt'/);
    assert.doesNotMatch(text, /'url'/);
    assert.equal(calls.length, 0, 'no HTTP request must be sent when prompt is missing');
  });

  it('reports both missing arguments (and empty strings) without calling the upstream API', async () => {
    const cases: Array<[Record<string, unknown> | undefined, RegExp]> = [
      [undefined, /missing required arguments 'url' and 'prompt'/],
      [{}, /missing required arguments 'url' and 'prompt'/],
      [{ url: '', prompt: '   ' }, /missing required arguments 'url' and 'prompt'/],
    ];

    for (const [args, expected] of cases) {
      const { fetch, calls } = fakeFetch({
        response: jsonResponse(200, 'OK', JSON.stringify({ data: {} })),
      });

      const result = await runExtractWebData(args, { fetch, apiKey: API_KEY });

      assert.equal(result.isError, true);
      assert.match(textOf(result), expected);
      assert.equal(calls.length, 0, 'no HTTP request must be sent when arguments are missing');
    }
  });

  it('reports the HTTP status and an upstream body excerpt on a non-2xx response', async () => {
    const upstreamBody = '{"error":"invalid_api_key","message":"The provided API key is not valid."}';
    const { fetch } = fakeFetch({
      response: jsonResponse(401, 'Unauthorized', upstreamBody),
    });

    const result = await runExtractWebData(ARGS, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /HTTP 401/);
    assert.match(text, /Unauthorized/);
    assert.match(text, /invalid_api_key/);
    assert.match(text, /provided API key is not valid/);
  });

  it('reports an unparseable response body together with a readable raw excerpt', async () => {
    const upstreamBody = '<html><body>Bad Gateway</body></html>';
    const { fetch } = fakeFetch({
      response: jsonResponse(200, 'OK', upstreamBody),
    });

    const result = await runExtractWebData(ARGS, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /not valid JSON/);
    assert.match(text, /could not be parsed/);
    assert.ok(text.includes(upstreamBody), 'raw upstream snippet should be preserved');
  });

  it('reports a missing data field together with a readable raw excerpt', async () => {
    const upstreamBody = JSON.stringify({ error: 'no_data', meta: { request_id: 'abc-123' } });
    const { fetch } = fakeFetch({
      response: jsonResponse(200, 'OK', upstreamBody),
    });

    const result = await runExtractWebData(ARGS, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /missing the required 'data' field/);
    assert.ok(text.includes(upstreamBody), 'raw upstream snippet should be preserved');
  });

  it('reports a connection failure as a failure outcome', async () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 104.18.0.1:443'), {
      name: 'FetchError',
      code: 'ECONNREFUSED',
    });
    const { fetch, calls } = fakeFetch({ error: connectionError });

    const result = await runExtractWebData(ARGS, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /network error/);
    assert.match(text, /ECONNREFUSED/);
    assert.equal(calls.length, 1);
  });

  it('reports a timeout as a failure outcome', async () => {
    const timeoutError = Object.assign(new Error('network timeout at: ' + AGENTQL_ENDPOINT), {
      name: 'FetchError',
      type: 'request-timeout',
    });
    const { fetch } = fakeFetch({ error: timeoutError });

    const result = await runExtractWebData(ARGS, { fetch, apiKey: API_KEY });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /network error/);
    assert.match(text, /network timeout/);
  });

  it('reports a failure when the API key is not configured, without calling the upstream API', async () => {
    const { fetch, calls } = fakeFetch({
      response: jsonResponse(200, 'OK', JSON.stringify({ data: {} })),
    });

    const result = await runExtractWebData(ARGS, { fetch, apiKey: '' });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /AGENTQL_API_KEY is not configured/);
    assert.equal(calls.length, 0);
  });
});
