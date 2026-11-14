// A local stand-in for HasData's hosted Glassdoor MCP server, used by the tests and by a
// manual smoke run. It speaks the same shape as the real server: JSON-RPC over streamable
// HTTP, answers carried as server-sent events, and the tool payload nested as JSON text.
//
// No network and no key: a test can walk a whole scenario offline. That matters because the
// retry and pagination rules must be provable without spending credits or owning an account.
//
// Every request is recorded so a test can assert what was actually sent: which token, whether
// a page number appeared, which parameters changed between pages.

import { createServer } from 'node:http';

export const TOOL_NAME = 'hasdata_glassdoor_listing_getJobListings';

// One posting in the response shape the listing tool uses.
export function makeJob({
  id,
  title = 'Data Engineer',
  company = 'Example Co',
  rating = 4.0,
  ageInDays = 3,
  min = null,
  median = null,
  max = null,
  currency = 'USD',
  period = 'ANNUAL',
  source = 'EMPLOYER_PROVIDED',
  noSalary = false,
} = {}) {
  return {
    id,
    title,
    url: `https://www.glassdoor.com/job-listing/example-${id}.htm?jl=${id}`,
    location: 'Austin, TX',
    ageInDays,
    sponsored: false,
    skills: ['SQL'],
    ...(noSalary
      ? {}
      : { salary: { currency, period, min, median, max, source } }),
    employer: { id: 9000 + id, name: company, shortName: company, rating, sponsored: false },
  };
}

// A page body: jobs plus the pagination object. `tokens` maps the page number a token leads
// to, exactly as `pagination.otherPages` does. An absent token is how a listing ends.
export function makePage(jobs, tokens) {
  return {
    searchInformation: { totalResults: 120, url: 'https://www.glassdoor.com/Job/jobs.htm' },
    jobs,
    pagination: { otherPages: tokens ? { ...tokens } : {} },
  };
}

function sseBody(id, text, { isError = false } = {}) {
  const result = { content: [{ type: 'text', text }], isError };
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

// Scenarios are functions of (state, request) returning an HTTP answer descriptor:
//   { status, body, contentType }                       plain answer
//   { toolPayload: pageObject }                         wrapped as a successful tool result
//   { toolText: 'raw text', isError: true }             an error-shaped tool result
//
// `state.calls` counts every request against this scenario, including retries.
export const SCENARIOS = {
  // Two good pages: page one offers a token, page two offers none. The classic happy path.
  'two-pages': () => {
    const page1 = makePage(
      [
        makeJob({ id: 1, company: 'Acme', min: 90000, median: 110000, max: 140000, source: 'EMPLOYER_PROVIDED' }),
        makeJob({ id: 2, company: 'Borealis', min: 80000, median: 95000, max: 110000, source: 'EMPLOYER_PROVIDED' }),
      ],
      { 2: 'page-2-token' },
    );
    const page2 = makePage(
      [
        makeJob({ id: 3, company: 'Cinder', min: 85000, median: 100000, max: 120000, source: 'EMPLOYER_PROVIDED' }),
      ],
      null,
    );
    return (state, args) => ({ toolPayload: args.nextPageToken === 'page-2-token' ? page2 : page1 });
  },

  // Page two carries jobs but no next-page token. Paging must stop there, not guess page 3.
  'token-missing-page-two': () => {
    const page1 = makePage([makeJob({ id: 1, company: 'Acme', min: 90000, median: 100000, max: 110000 })], {
      2: 'page-2-token',
    });
    // `otherPages` holds only a same-page reference and a top-level token for page 1, none of
    // which is a valid next-page token. A collector must not pick one anyway.
    const page2 = {
      searchInformation: { totalResults: 120 },
      jobs: [makeJob({ id: 2, company: 'Borealis', min: 70000, median: 80000, max: 90000 })],
      pagination: { otherPages: { 1: 'page-1-token' } },
    };
    return (state, args) => ({ toolPayload: args.nextPageToken === 'page-2-token' ? page2 : page1 });
  },

  // Page two hands back the token page one already used. Must stop rather than walk in a circle.
  'repeated-token': () => {
    const page1 = makePage([makeJob({ id: 1, company: 'Acme', min: 90000, median: 100000, max: 110000 })], {
      2: 'loop-token',
    });
    const page2 = makePage([makeJob({ id: 2, company: 'Borealis', min: 70000, median: 80000, max: 90000 })], {
      3: 'loop-token',
    });
    return (state, args) => ({ toolPayload: args.nextPageToken === 'loop-token' && state.calls > 1 ? page2 : page1 });
  },

  // The first request is throttled, the retry succeeds. Proves the retry is per request.
  'rate-limit-then-success': () => (state, args) => {
    if (state.calls === 1) {
      return { status: 429, body: JSON.stringify({ error: 'concurrency_limit' }) };
    }
    if (!args.nextPageToken) {
      return { toolPayload: makePage([makeJob({ id: 1, company: 'Acme', min: 90000, median: 100000, max: 110000 })], null) };
    }
    return { toolPayload: makePage([makeJob({ id: 2, company: 'Borealis' })], null) };
  },

  // Every attempt is throttled. The client gives up after its retry budget and keeps nothing.
  'always-rate-limited': () => () => ({ status: 429, body: JSON.stringify({ error: 'concurrency_limit' }) }),

  // A rejected key. Must fail immediately, with exactly one request.
  'unauthorized': () => () => ({
    status: 401,
    body: JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authorization is required: connect with OAuth or send an x-api-key header' },
      _meta: { 'mcp/www_authenticate': ['Bearer error="invalid_token"'] },
    }),
  }),

  // A rejected key as the real server actually returns it: HTTP 200, an `isError` result, and
  // the 401 in the text. A client that only looks at the HTTP status would mislabel this as a
  // generic tool error, so this scenario pins the real shape.
  'unauthorized-in-tool-result': () => () => ({
    status: 200,
    toolText: 'HasData API error: 401 Unauthorized — {"message":"Invalid api key"}',
    isError: true,
  }),

  // A successful page whose posting text happens to contain "unauthorized". Nothing in it is
  // an auth failure, and a client that greps the body for the word would wrongly stop here.
  'unauthorized-word-in-posting': () => () => ({
    toolPayload: makePage(
      [
        {
          ...makeJob({ id: 1, company: 'Acme', min: 90000, median: 100000, max: 110000 }),
          description: 'This role handles unauthorized access attempts and reports them.',
        },
      ],
      null,
    ),
  }),

  // Salary shapes that must not be mixed: no salary, a point figure, hourly pay, and an
  // estimate. Two pages so the merge path is exercised at the same time.
  'salary-shapes': () => {
    const page1 = makePage(
      [
        makeJob({ id: 1, company: 'NilCo', noSalary: true }),
        makeJob({ id: 2, company: 'PointCo', min: 100000, median: 100000, max: 100000, source: 'EMPLOYER_PROVIDED' }),
        makeJob({ id: 3, company: 'HourlyCo', min: 30, median: 35, max: 45, period: 'HOURLY', source: 'EMPLOYER_PROVIDED' }),
      ],
      { 2: 'shapes-token' },
    );
    const page2 = makePage(
      [
        makeJob({ id: 4, company: 'EstimateCo', min: 95000, median: 105000, max: 130000, source: 'ESTIMATED' }),
        makeJob({ id: 5, company: 'EstimateCo', min: 85000, median: 92000, max: 100000, source: 'ESTIMATED' }),
      ],
      null,
    );
    return (state, args) => ({ toolPayload: args.nextPageToken === 'shapes-token' ? page2 : page1 });
  },

  // A page that answers successfully but with zero postings. A walk should end there.
  'empty-second-page': () => {
    const page1 = makePage([makeJob({ id: 1, company: 'Acme', min: 90000, median: 100000, max: 110000 })], {
      2: 'page-2-token',
    });
    return (state, args) => ({
      toolPayload: args.nextPageToken === 'page-2-token'
        ? makePage([], { 3: 'page-3-token' })
        : page1,
    });
  },

  // A non-throttle server fault on page two. Collected page one must survive in the report.
  'error-on-second-page': () => {
    const page1 = makePage([makeJob({ id: 1, company: 'Acme', min: 90000, median: 100000, max: 110000 })], {
      2: 'page-2-token',
    });
    return (state, args) => (args.nextPageToken === 'page-2-token'
      ? { status: 500, body: JSON.stringify({ message: 'upstream failed' }) }
      : { toolPayload: page1 });
  },
};

/**
 * Start the fake server. `scenario` is a key of SCENARIOS or a custom factory.
 * Returns { url, requests, state, close() }.
 */
export async function startFakeServer({ scenario = 'two-pages' } = {}) {
  const factory = typeof scenario === 'function' ? scenario : SCENARIOS[scenario];
  if (!factory) throw new Error(`unknown fake scenario: ${scenario}`);

  const state = { calls: 0 };
  const respond = factory(state);
  const requests = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      state.calls += 1;
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // A malformed request is answered as a protocol error, as a real server would.
      }
      const toolCall = body?.method === 'tools/call' ? body.params : null;
      requests.push({
        method: body?.method ?? null,
        tool: toolCall?.name ?? null,
        args: toolCall?.arguments ?? null,
        headers: req.headers,
      });

      if (body?.method !== 'tools/call') {
        send(res, 400, JSON.stringify({ error: 'only tools/call is served by this fake' }));
        return;
      }

      const answer = respond(state, toolCall?.arguments ?? {});
      if (answer.status && answer.status !== 200) {
        send(res, answer.status, answer.body ?? '');
        return;
      }
      if (answer.toolText !== undefined) {
        send(res, 200, sseBody(body.id, answer.toolText, answer), 'text/event-stream');
        return;
      }
      const payload = { json: answer.toolPayload };
      send(res, 200, sseBody(body.id, JSON.stringify(payload)), 'text/event-stream');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
