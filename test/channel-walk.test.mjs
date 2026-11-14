// Channel tab walk tests.
//
// Everything here is a hand-built rpc stub: no fetch, no network, and no HASDATA_API_KEY.
// The stub returns the same { raw, body } pair the contract tests produce, with the payload
// nested the way a tools/call result actually nests it: result.content[0].text is a JSON
// string whose `json` field holds the scraped data and whose `requestMetadata` sits beside it.
//
// Run: node --test test/channel-walk.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkChannelTab, CHANNEL_TOOL, PAGE_STATUS, OUTCOME } from '../lib/channel-walk.mjs';

// The envelope the server puts in result.content[0].text. `json` is omitted when a call
// succeeded and found nothing, which is how the README documents an empty result.
function envelope(json, { status = 'ok', text = '', id = 'req_1' } = {}) {
  const payload = { url: 'https://www.youtube.com/@test', status, text };
  if (json !== undefined) payload.json = json;
  payload.requestMetadata = { id, status };
  return payload;
}

function okBody(payload) {
  return {
    raw: '',
    body: {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    },
  };
}

function concurrentBody() {
  const raw = JSON.stringify({ error: 'concurrency_limit: too many concurrent requests' });
  return { raw, body: { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'concurrency_limit' } } };
}

function unauthorizedBody() {
  return {
    raw: '',
    body: {
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: [{ type: 'text', text: 'HasData API error: 401 Unauthorized' }] },
    },
  };
}

// A video page: entries under the tab-specific array, with a pagination block.
function videoPage(ids, { nextPageToken, metadataId = 'req_1' } = {}) {
  const json = {
    channelInfo: { channelId: 'UC_test', name: 'Test Channel' },
    videos: ids.map((videoId) => ({ videoId, title: `Video ${videoId}`, duration: '10:00' })),
  };
  if (nextPageToken !== undefined) json.pagination = { nextPageToken };
  return okBody(envelope(json, { id: metadataId }));
}

// A scripts a sequence of stub answers and records every tools/call it received.
function stubRpc(answers) {
  const calls = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const handler = answers.handler ?? null;

  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (queue) {
      if (!queue.length) throw new Error('stubRpc ran out of answers');
      return queue.shift();
    }
    return handler(method, params, calls.length);
  };

  rpc.calls = calls;
  return rpc;
}

// Tests must never sleep for real; the injected sleep records the requested waits instead.
function fakeSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  sleep.delays = delays;
  return sleep;
}

const baseOptions = () => ({ sleep: fakeSleep(), retryDelayMs: 1_000 });

test('two normal pages walk to the end and report each page', async () => {
  const rpc = stubRpc([
    videoPage(['a', 'b'], { nextPageToken: 'tok-1' }),
    videoPage(['c'], { metadataId: 'req_2' }),
  ]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.outcome, OUTCOME.COMPLETED);
  assert.equal(result.pageCount, 2);
  assert.equal(result.itemCount, 3);
  assert.equal(result.resumeToken, null);
  assert.equal(result.resumedFrom, null);

  assert.deepEqual(
    result.pages.map((p) => p.page),
    [1, 2]
  );
  assert.deepEqual(
    result.pages.map((p) => p.status),
    [PAGE_STATUS.SUCCESS, PAGE_STATUS.SUCCESS]
  );
  assert.deepEqual(
    result.pages.map((p) => p.itemCount),
    [2, 1]
  );
  assert.deepEqual(
    result.pages.map((p) => p.hasNext),
    [true, false]
  );
  assert.equal(result.pages[0].nextPageToken, 'tok-1');
  assert.equal(result.pages[1].requestMetadata.id, 'req_2');
  assert.equal(result.lastPage, result.pages[1]);

  // The tool name and arguments are the documented contract.
  assert.equal(rpc.calls.length, 2);
  assert.equal(rpc.calls[0].method, 'tools/call');
  assert.equal(rpc.calls[0].params.name, CHANNEL_TOOL);
  assert.deepEqual(rpc.calls[0].params.arguments, { channelId: 'UC_test', tab: 'videos' });
  // The token from page one is what page two sends back.
  assert.deepEqual(rpc.calls[1].params.arguments, {
    channelId: 'UC_test',
    tab: 'videos',
    paginationToken: 'tok-1',
  });
});

test('a successful page with no data key is an empty page and a normal ending', async () => {
  const rpc = stubRpc([
    videoPage(['a'], { nextPageToken: 'tok-1' }),
    // Success, requestMetadata ok, but the tab's array is simply absent.
    okBody(envelope(undefined)),
  ]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.outcome, OUTCOME.COMPLETED);
  assert.equal(result.pageCount, 2);
  assert.equal(result.itemCount, 1);
  assert.equal(result.pages[1].status, PAGE_STATUS.EMPTY);
  assert.equal(result.pages[1].missingDataKey, true);
  assert.equal(result.pages[1].itemCount, 0);
  // An empty successful page is not a failure, so nothing is marked as an error.
  assert.equal(result.outcomeReason, null);
  assert.equal(result.pages[1].reason, null);
});

test('sections-shaped tabs count the items inside every section', async () => {
  const json = {
    channelInfo: { channelId: 'UC_test' },
    featuredVideo: { videoId: 'featured' },
    sections: [
      { title: 'Uploads', items: [{ videoId: 'a' }, { videoId: 'b' }] },
      { title: 'Playlists', items: [{ playlistId: 'p' }] },
    ],
  };
  const rpc = stubRpc([okBody(envelope(json))]);

  const result = await walkChannelTab(rpc, 'UC_test', 'featured', baseOptions());

  assert.equal(result.outcome, OUTCOME.COMPLETED);
  assert.equal(result.pageCount, 1);
  assert.equal(result.itemCount, 3);
  assert.equal(result.pages[0].status, PAGE_STATUS.SUCCESS);
  assert.equal(result.pages[0].itemsKey, 'sections');
});

test('concurrency_limit is retried with increasing waits, then the page succeeds', async () => {
  const sleep = fakeSleep();
  const rpc = stubRpc([
    concurrentBody(),
    concurrentBody(),
    videoPage(['a'], { nextPageToken: 'tok-1' }),
    videoPage(['b']),
  ]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', {
    sleep,
    retryDelayMs: 1_000,
  });

  assert.equal(result.outcome, OUTCOME.COMPLETED);
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages[0].status, PAGE_STATUS.SUCCESS);
  assert.equal(result.pages[0].attempts, 3);
  // Retry n waits base * n, so the waits grow rather than hammering the endpoint.
  assert.deepEqual(sleep.delays, [1_000, 2_000]);
  assert.equal(result.pages[0].waitedMs, 3_000);
  assert.equal(rpc.calls.length, 4);
  // A retried page still requests the same pagination token it started with.
  assert.deepEqual(rpc.calls[1].params.arguments, { channelId: 'UC_test', tab: 'videos' });
});

test('retries exhausted marks the page rate-limited and exposes its resume token', async () => {
  const sleep = fakeSleep();
  const rpc = stubRpc({ handler: () => concurrentBody() });

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', {
    sleep,
    retryDelayMs: 500,
    maxConcurrencyRetries: 2,
    paginationToken: 'tok-1',
  });

  assert.equal(result.outcome, OUTCOME.RATE_LIMITED);
  assert.equal(result.pageCount, 1);
  assert.equal(result.pages[0].status, PAGE_STATUS.RATE_LIMITED);
  assert.equal(result.pages[0].attempts, 3); // the first try plus two retries
  assert.deepEqual(sleep.delays, [500, 1_000]);
  assert.match(result.pages[0].reason, /concurrency_limit/);
  assert.match(result.outcomeReason, /concurrency_limit/);
  // Feed this back to resume the same page.
  assert.equal(result.resumeToken, 'tok-1');
  assert.equal(rpc.calls.length, 3);
  assert.equal(rpc.calls[0].params.arguments.paginationToken, 'tok-1');
});

test('a rate limit on the first page resumes from null, restarting the tab', async () => {
  const rpc = stubRpc({ handler: () => concurrentBody() });

  const result = await walkChannelTab(rpc, 'UC_test', 'shorts', {
    sleep: fakeSleep(),
    retryDelayMs: 0,
    maxConcurrencyRetries: 0,
  });

  assert.equal(result.outcome, OUTCOME.RATE_LIMITED);
  assert.equal(result.resumeToken, null);
  assert.equal(result.pages[0].attempts, 1);
});

test('401 is not retried: it stops immediately with the reason in the outcome', async () => {
  const sleep = fakeSleep();
  const rpc = stubRpc([unauthorizedBody(), videoPage(['never'])]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', { sleep, retryDelayMs: 1_000 });

  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.equal(result.pageCount, 1);
  assert.equal(result.pages[0].status, PAGE_STATUS.FAILED);
  assert.equal(result.pages[0].attempts, 1);
  assert.match(result.outcomeReason, /401 Unauthorized/);
  assert.equal(result.resumeToken, null);
  assert.equal(sleep.delays.length, 0);
  assert.equal(rpc.calls.length, 1, 'nothing after a 401 is fetched');
});

test('any other isError stops the walk and names the reason', async () => {
  const rpc = stubRpc([
    {
      raw: '',
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'MCP error -32602: Input validation error' }],
        },
      },
    },
  ]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.equal(result.pages[0].status, PAGE_STATUS.FAILED);
  assert.match(result.outcomeReason, /Input validation error/);
});

test('a requestMetadata error stops the walk', async () => {
  const rpc = stubRpc([okBody(envelope(undefined, { status: 'error', text: 'channel not found' }))]);

  const result = await walkChannelTab(rpc, 'UC_missing', 'videos', baseOptions());

  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.match(result.outcomeReason, /channel not found/);
});

test('maxPages truncates rather than pretending the tab ended', async () => {
  const rpc = stubRpc([
    videoPage(['a'], { nextPageToken: 'tok-1' }),
    videoPage(['b'], { nextPageToken: 'tok-2' }),
    videoPage(['c']),
  ]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', { ...baseOptions(), maxPages: 2 });

  assert.equal(result.outcome, OUTCOME.TRUNCATED);
  assert.equal(result.pageCount, 2);
  assert.equal(result.itemCount, 2);
  assert.match(result.outcomeReason, /maxPages=2/);
  // tok-2 is what picks the walk up on the next run.
  assert.equal(result.resumeToken, 'tok-2');
  assert.equal(rpc.calls.length, 2, 'the third page is not fetched');
});

test('maxPages of one on a tab with more pages is reported as truncated', async () => {
  const rpc = stubRpc([videoPage(['a'], { nextPageToken: 'tok-1' })]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', { ...baseOptions(), maxPages: 1 });

  assert.equal(result.outcome, OUTCOME.TRUNCATED);
  assert.equal(result.pageCount, 1);
  assert.equal(result.resumeToken, 'tok-1');
});

test('a run resumes from the token it was given and finishes the tab', async () => {
  const rpc = stubRpc([videoPage(['c', 'd'], { nextPageToken: 'tok-3' }), videoPage(['e'])]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', {
    ...baseOptions(),
    paginationToken: 'tok-2',
  });

  assert.equal(result.resumedFrom, 'tok-2');
  assert.equal(result.outcome, OUTCOME.COMPLETED);
  assert.equal(result.pageCount, 2);
  assert.equal(result.itemCount, 3);
  // Page numbering restarts at 1 for this run while the first request carries the old token.
  assert.equal(result.pages[0].page, 1);
  assert.deepEqual(rpc.calls[0].params.arguments, {
    channelId: 'UC_test',
    tab: 'videos',
    paginationToken: 'tok-2',
  });
  assert.equal(rpc.calls[1].params.arguments.paginationToken, 'tok-3');
});

test('resuming after a rate limit retries exactly the page that failed', async () => {
  // First run: page one succeeds, page two is rate-limited out.
  const firstRun = stubRpc([
    videoPage(['a'], { nextPageToken: 'tok-1' }),
    concurrentBody(),
  ]);
  const first = await walkChannelTab(firstRun, 'UC_test', 'videos', {
    ...baseOptions(),
    maxConcurrencyRetries: 0,
  });
  assert.equal(first.outcome, OUTCOME.RATE_LIMITED);
  assert.equal(first.resumeToken, 'tok-1');

  // Second run: feed the token back and the tab finishes from that page.
  const secondRun = stubRpc([videoPage(['b'])]);
  const second = await walkChannelTab(secondRun, 'UC_test', 'videos', {
    ...baseOptions(),
    paginationToken: first.resumeToken,
  });

  assert.equal(second.outcome, OUTCOME.COMPLETED);
  assert.equal(second.pageCount, 1);
  assert.deepEqual(secondRun.calls[0].params.arguments, {
    channelId: 'UC_test',
    tab: 'videos',
    paginationToken: 'tok-1',
  });
});

test('scraped text mentioning an error string does not stop the walk', async () => {
  // A video title is scraped data, not a failure. Matching on the whole payload would turn a
  // perfectly good page into a 401 or a rate limit.
  const json = {
    videos: [
      { videoId: 'a', title: '401 Unauthorized explained' },
      { videoId: 'b', title: 'concurrency_limit in plain English' },
    ],
  };
  const rpc = stubRpc([okBody(envelope(json))]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.outcome, OUTCOME.COMPLETED);
  assert.equal(result.pages[0].status, PAGE_STATUS.SUCCESS);
  assert.equal(result.pages[0].attempts, 1);
  assert.equal(result.pages[0].itemCount, 2);
});

test('a populated array beside an empty one still counts as a success', async () => {
  const json = {
    videos: [],
    sections: [{ title: 'Uploads', items: [{ videoId: 'a' }, { videoId: 'b' }] }],
  };
  const rpc = stubRpc([okBody(envelope(json))]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.pages[0].status, PAGE_STATUS.SUCCESS);
  assert.equal(result.pages[0].itemCount, 2);
  assert.equal(result.pages[0].itemsKey, 'sections');
});

test('the scraped data is read from result.content[0].text, not the body top level', async () => {
  // A body that also carries a decoy `json` at the top level proves the module reads the
  // documented path and not the convenient one.
  const body = {
    jsonrpc: '2.0',
    id: 1,
    json: { videos: [{ videoId: 'decoy' }] },
    result: {
      content: [
        { type: 'text', text: JSON.stringify(envelope({ videos: [{ videoId: 'real' }] })) },
      ],
    },
  };
  const rpc = stubRpc([{ raw: '', body }]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.pages[0].itemCount, 1);
  assert.equal(result.pages[0].data.videos[0].videoId, 'real');
  assert.equal(result.pages[0].requestMetadata.id, 'req_1');
});

test('a pagination block beside json still advances the walk', async () => {
  const payload = envelope({ videos: [{ videoId: 'a' }] });
  payload.pagination = { nextPageToken: 'tok-1' };
  const rpc = stubRpc([okBody(payload), videoPage(['b'], { metadataId: 'req_2' })]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.outcome, OUTCOME.COMPLETED);
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages[0].nextPageToken, 'tok-1');
});

test('an rpc that throws concurrency_limit retries, then ends as rate-limited', async () => {
  const sleep = fakeSleep();
  const rpc = stubRpc({
    handler: () => {
      throw new Error('429 concurrency_limit');
    },
  });

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', {
    sleep,
    retryDelayMs: 100,
    maxConcurrencyRetries: 1,
  });

  assert.equal(result.outcome, OUTCOME.RATE_LIMITED);
  assert.equal(result.pages[0].status, PAGE_STATUS.RATE_LIMITED);
  assert.equal(result.pages[0].attempts, 2);
  assert.deepEqual(sleep.delays, [100]);
});

test('a non-concurrency throw fails the page instead of retrying', async () => {
  const sleep = fakeSleep();
  const rpc = stubRpc({
    handler: () => {
      throw new Error('socket hang up');
    },
  });

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', { sleep, retryDelayMs: 100 });

  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.equal(result.pages[0].status, PAGE_STATUS.FAILED);
  assert.match(result.outcomeReason, /socket hang up/);
  assert.equal(sleep.delays.length, 0);
});

test('options.resumeToken is accepted, so a prior result can be fed straight back', async () => {
  const rpc = stubRpc([videoPage(['b'])]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', {
    ...baseOptions(),
    resumeToken: 'tok-9',
  });

  assert.equal(result.resumedFrom, 'tok-9');
  assert.equal(rpc.calls[0].params.arguments.paginationToken, 'tok-9');
});

test('a pagination token that never advances stops instead of looping', async () => {
  const rpc = stubRpc({ handler: () => videoPage(['a'], { nextPageToken: 'same' }) });

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', baseOptions());

  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages[1].loopDetected, true);
  assert.match(result.outcomeReason, /did not advance/);
  assert.equal(rpc.calls.length, 2);
});

test('onPage reports every page as it lands, failures included', async () => {
  const seen = [];
  const rpc = stubRpc([
    videoPage(['a'], { nextPageToken: 'tok-1' }),
    concurrentBody(),
  ]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', {
    ...baseOptions(),
    maxConcurrencyRetries: 0,
    onPage: (page) => {
      seen.push({ page: page.page, status: page.status });
    },
  });

  assert.equal(result.outcome, OUTCOME.RATE_LIMITED);
  assert.deepEqual(seen, [
    { page: 1, status: PAGE_STATUS.SUCCESS },
    { page: 2, status: PAGE_STATUS.RATE_LIMITED },
  ]);
});

test('includeData: false keeps the report small while the counts stay accurate', async () => {
  const rpc = stubRpc([videoPage(['a', 'b'])]);

  const result = await walkChannelTab(rpc, 'UC_test', 'videos', {
    ...baseOptions(),
    includeData: false,
  });

  assert.equal(result.pages[0].itemCount, 2);
  assert.equal(result.pages[0].data, undefined);
  assert.equal(result.pages[0].envelope, undefined);
});

test('rejects bad arguments before spending a call', async () => {
  const rpc = stubRpc([]);

  await assert.rejects(() => walkChannelTab(null, 'UC_test', 'videos'), TypeError);
  await assert.rejects(() => walkChannelTab(rpc, '', 'videos'), TypeError);
  await assert.rejects(() => walkChannelTab(rpc, 'UC_test', ''), TypeError);
  await assert.rejects(() => walkChannelTab(rpc, 'UC_test', 'videos', { maxPages: 0 }), RangeError);
  await assert.rejects(
    () => walkChannelTab(rpc, 'UC_test', 'videos', { retryDelayMs: -1 }),
    RangeError
  );
  assert.equal(rpc.calls.length, 0);
});
