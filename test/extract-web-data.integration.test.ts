import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { runExtractWebData } from '../src/extract-web-data.js';

interface CapturedRequest {
  method: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface MockUpstream {
  server: Server;
  endpoint: string;
  requests: CapturedRequest[];
  reply: { status: number; statusText: string; body: string };
}

/**
 * Start a real HTTP server acting as a stand-in for the AgentQL query-data API,
 * so the whole request/response path (node-fetch, headers, body) can be checked.
 */
async function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    // Assigned below.
    server: undefined as unknown as Server,
    endpoint: '',
    requests: [],
    reply: { status: 200, statusText: 'OK', body: '{"data":{}}' },
  };

  state.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.requests.push({
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(state.reply.status, state.reply.statusText, { 'Content-Type': 'application/json' });
      res.end(state.reply.body);
    });
  });

  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const address = state.server.address() as AddressInfo;
  state.endpoint = `http://127.0.0.1:${address.port}/v1/query-data`;
  return state;
}

describe('extract-web-data against a local mock upstream', () => {
  let upstream: MockUpstream;

  before(async () => {
    upstream = await startMockUpstream();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      upstream.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('POSTs the documented headers and JSON body and returns the data field', async () => {
    upstream.requests.length = 0;
    upstream.reply = {
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ data: { title: 'Example', items: [1, 2] } }),
    };

    const result = await runExtractWebData(
      { url: 'https://example.com', prompt: 'Extract the title and items' },
      { apiKey: 'local-test-key', endpoint: upstream.endpoint },
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { title: 'Example', items: [1, 2] });

    assert.equal(upstream.requests.length, 1);
    const received = upstream.requests[0];
    assert.equal(received.method, 'POST');
    assert.equal(received.headers['x-api-key'], 'local-test-key');
    assert.equal(received.headers['x-tf-request-origin'], 'mcp-server');
    assert.match(String(received.headers['content-type']), /^application\/json/);
    const sentBody = JSON.parse(received.body);
    assert.equal(sentBody.url, 'https://example.com');
    assert.equal(sentBody.prompt, 'Extract the title and items');
  });

  it('turns a real non-2xx reply into a failure outcome with status and body excerpt', async () => {
    upstream.requests.length = 0;
    upstream.reply = { status: 503, statusText: 'Service Unavailable', body: 'upstream is overloaded' };

    const result = await runExtractWebData(
      { url: 'https://example.com', prompt: 'Extract the title' },
      { apiKey: 'local-test-key', endpoint: upstream.endpoint },
    );

    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /HTTP 503/);
    assert.match(text, /Service Unavailable/);
    assert.match(text, /upstream is overloaded/);
  });

  it('turns a real connection failure into a failure outcome', async () => {
    // Start a server, take its port, then stop it so connecting is refused.
    const throwaway = await startMockUpstream();
    const endpoint = throwaway.endpoint;
    await new Promise<void>((resolve, reject) =>
      throwaway.server.close((error) => (error ? reject(error) : resolve())),
    );

    const result = await runExtractWebData(
      { url: 'https://example.com', prompt: 'Extract the title' },
      { apiKey: 'local-test-key', endpoint },
    );

    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /network error/);
    assert.match(text, /ECONNREFUSED|ECONNRESET|socket hang up/i);
  });
});
