// Tests for the collection orchestrator. Every check drives collectTrend through a local fake
// callTool, so the suite needs no API key and costs no credits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTrend, TOOL_NAME } from '../lib/trends-collect.mjs';

const ok = (json) => ({ json, status: 200 });

const TIMESERIES = {
  interestOverTime: {
    timelineData: [
      { date: 'Jan 1', timestamp: '1', isPartial: false, values: [{ query: 'coffee', value: '40', extractedValue: 40, hasData: true }] },
      { date: 'Jan 8', timestamp: '2', isPartial: false, values: [{ query: 'coffee', value: '100', extractedValue: 100, hasData: true }] },
      { date: 'Jan 15', timestamp: '3', isPartial: true, values: [{ query: 'coffee', value: '10', extractedValue: 10, hasData: true }] },
    ],
  },
};

const GEOMAP = {
  geoMap: [
    { geoName: 'California', geoCode: 'US-CA', extractedValue: 40 },
    { geoName: 'Texas', geoCode: 'US-TX', extractedValue: 100 },
    { geoName: 'Oregon', geoCode: 'US-OR', extractedValue: 70 },
  ],
};

const RELATED = {
  relatedQueries: {
    rising: [
      { query: 'cold brew', value: '+120%', extractedValue: 120 },
      { query: 'iced latte', value: 'Breakout', extractedValue: 9_999 },
      { query: 'coffee near me', value: '+400%', extractedValue: 400 },
      { query: 'nitro', value: 'Breakout', extractedValue: 9_999 },
    ],
    top: [
      { query: 'coffee', value: '100', extractedValue: 100 },
      { query: 'espresso', value: '60', extractedValue: 60 },
    ],
  },
};

function recordedFake(handlers = {}) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    const handler = handlers[args.dataType ?? 'timeseries'];
    if (typeof handler === 'function') return handler(args);
    if (handler !== undefined) return handler;
    return args.dataType === 'geoMap' ? GEOMAP : args.dataType === 'relatedQueries' ? RELATED : TIMESERIES;
  };
  return { calls, callTool };
}

const noSleep = async () => {};

test('collects the three blocks in order and names the tool every time', async () => {
  const { calls, callTool } = recordedFake();
  const result = await collectTrend('coffee', { geo: 'US', date: 'today 12-m' }, { callTool, sleep: noSleep });

  assert.deepEqual(calls.map(([name]) => name), [TOOL_NAME, TOOL_NAME, TOOL_NAME]);
  assert.deepEqual(calls[0][1], { q: 'coffee', geo: 'US', date: 'today 12-m' });
  assert.equal(calls[1][1].dataType, 'geoMap');
  assert.equal(calls[2][1].dataType, 'relatedQueries');
  assert.equal(result.term, 'coffee');
  assert.equal(result.geo, 'US');
  assert.equal(result.date, 'today 12-m');
  assert.equal(result.status.series, 'ok');
  assert.equal(result.status.geoMap, 'ok');
  assert.equal(result.status.relatedQueries, 'ok');
});

test('drops isPartial points and reports how many were dropped', async () => {
  const { callTool } = recordedFake();
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.equal(result.series.length, 2);
  assert.equal(result.droppedPartial, 1);
  assert.ok(!result.series.some((point) => point.isPartial));
  assert.ok(result.notes.some((note) => /partial/i.test(note)));
});

test('geoMap always sends region explicitly, defaulting with the geo', async () => {
  const worldwide = recordedFake();
  await collectTrend('coffee', {}, { callTool: worldwide.callTool, sleep: noSleep });
  assert.equal(worldwide.calls[1][1].region, 'country');

  const scoped = recordedFake();
  await collectTrend('coffee', { geo: 'US' }, { callTool: scoped.callTool, sleep: noSleep });
  assert.equal(scoped.calls[1][1].region, 'region');

  const explicit = recordedFake();
  await collectTrend('coffee', { geo: 'US', region: 'dma' }, { callTool: explicit.callTool, sleep: noSleep });
  assert.equal(explicit.calls[1][1].region, 'dma');
});

test('regions come back strongest first', async () => {
  const { callTool } = recordedFake();
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });
  assert.deepEqual(result.regions.map((entry) => entry.geoName), ['Texas', 'Oregon', 'California']);
});

test('rising sorts on the label and keeps Breakout in its own group', async () => {
  const { callTool } = recordedFake();
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.deepEqual(result.rising.map((entry) => entry.query), ['coffee near me', 'cold brew']);
  assert.deepEqual(result.breakout.map((entry) => entry.query), ['iced latte', 'nitro']);
  assert.ok(result.rising.every((entry) => String(entry.value).toLowerCase() !== 'breakout'));
  assert.deepEqual(result.top.map((entry) => entry.query), ['coffee', 'espresso']);
});

test('an empty series is no_interest and stops after one call', async () => {
  const { calls, callTool } = recordedFake({ timeseries: ok({ interestOverTime: { timelineData: [] } }) });
  const result = await collectTrend('unheard of term', {}, { callTool, sleep: noSleep });

  assert.equal(calls.length, 1);
  assert.equal(result.status.series, 'no_interest');
  assert.equal(result.status.geoMap, 'skipped');
  assert.equal(result.status.relatedQueries, 'skipped');
  assert.equal(result.series.length, 0);
  assert.equal(result.regions.length, 0);
  assert.ok(result.notes.some((note) => /no measurable interest/i.test(note)));
});

test('a series that is flat at zero is no_interest too', async () => {
  const flat = {
    interestOverTime: {
      timelineData: [
        { date: 'Jan 1', isPartial: false, values: [{ value: '0', extractedValue: 0, hasData: true }] },
        { date: 'Jan 8', isPartial: false, values: [{ value: '0', extractedValue: 0, hasData: true }] },
      ],
    },
  };
  const { calls, callTool } = recordedFake({ timeseries: ok(flat) });
  const result = await collectTrend('nothing', {}, { callTool, sleep: noSleep });

  assert.equal(calls.length, 1);
  assert.equal(result.status.series, 'no_interest');
});

test('a 429 is retried with 4000ms then 8000ms and succeeds', async () => {
  let attempts = 0;
  const delays = [];
  const handler = () => {
    attempts += 1;
    if (attempts === 1) throw new Error('HasData API error: 429 Too Many Requests concurrency_limit');
    if (attempts === 2) throw new Error('concurrency_limit');
    return TIMESERIES;
  };
  const { callTool } = recordedFake({ timeseries: handler });
  const result = await collectTrend('coffee', {}, {
    callTool,
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [4000, 8000]);
  assert.equal(result.status.series, 'ok');
});

test('a persistent concurrency limit gives rate_limited after four attempts', async () => {
  let attempts = 0;
  const delays = [];
  const handler = () => {
    attempts += 1;
    throw new Error('HTTP 429: concurrency_limit');
  };
  const { callTool } = recordedFake({ timeseries: handler });
  const result = await collectTrend('coffee', {}, {
    callTool,
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [4000, 8000, 16000]);
  assert.equal(result.status.series, 'rate_limited');
  assert.equal(result.status.geoMap, 'ok');
  assert.equal(result.status.relatedQueries, 'ok');
  assert.ok(result.errors.timeseries.message.includes('concurrency_limit'));
});

test('401 Unauthorized fails immediately and is not retried', async () => {
  let attempts = 0;
  const handler = () => {
    attempts += 1;
    throw new Error('HasData API error: 401 Unauthorized');
  };
  const { callTool } = recordedFake({ timeseries: handler });
  const result = await collectTrend('coffee', {}, {
    callTool,
    sleep: async () => { throw new Error('must not sleep on 401'); },
  });

  assert.equal(attempts, 1);
  assert.equal(result.status.series, 'unauthorized');
  assert.equal(result.status.geoMap, 'ok');
});

test('an isError result carrying 401 is classified rather than read as an empty series', async () => {
  const handler = () => ({
    isError: true,
    content: [{ type: 'text', text: 'HasData API error: 401 Unauthorized' }],
  });
  const { callTool } = recordedFake({ timeseries: handler });
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.equal(result.status.series, 'unauthorized');
  assert.equal(result.status.series === 'no_interest', false);
});

test('a returned isError payload with concurrency_limit is retried too', async () => {
  let attempts = 0;
  const handler = () => {
    attempts += 1;
    if (attempts < 2) {
      return { isError: true, content: [{ type: 'text', text: '429 concurrency_limit' }] };
    }
    return TIMESERIES;
  };
  const delays = [];
  const { callTool } = recordedFake({ timeseries: handler });
  const result = await collectTrend('coffee', {}, {
    callTool,
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [4000]);
  assert.equal(result.status.series, 'ok');
});

test('a series carrying only partial points is no_interest and stops early', async () => {
  const onlyPartial = {
    interestOverTime: {
      timelineData: [
        { date: 'Jan 1', isPartial: true, values: [{ value: '80', extractedValue: 80, hasData: true }] },
      ],
    },
  };
  const { calls, callTool } = recordedFake({ timeseries: ok(onlyPartial) });
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.equal(calls.length, 1);
  assert.equal(result.status.series, 'no_interest');
  assert.equal(result.droppedPartial, 1);
  assert.equal(result.series.length, 0);
});

test('other failures are failed, keep the message, and leave the other blocks intact', async () => {
  const { callTool } = recordedFake({
    geoMap: () => { throw new Error('MCP error -32602: Input validation error: region'); },
  });
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.equal(result.status.series, 'ok');
  assert.equal(result.status.geoMap, 'failed');
  assert.equal(result.status.relatedQueries, 'ok');
  assert.match(result.errors.geoMap.message, /Input validation error/);
  assert.ok(result.series.length > 0);
  assert.ok(result.rising.length > 0);
});

test('the result declares that blocks are not comparable with each other', async () => {
  const { callTool } = recordedFake();
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });
  assert.ok(result.notes.some((note) => /not comparable|its own maximum/i.test(note)));
});

test('a HasData envelope with a non-ok status is a failure, not an empty series', async () => {
  const { callTool } = recordedFake({
    geoMap: () => ({ url: 'x', status: 'error', text: 'upstream says no', json: null }),
  });
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.equal(result.status.geoMap, 'failed');
  assert.equal(result.status.series, 'ok');
  assert.match(result.errors.geoMap.message, /upstream says no/);
});

test('unwraps HasData\'s {url, status, text, json} envelope', async () => {
  const envelope = (payload) => ({ url: 'x', status: 'ok', text: 'raw', json: payload });
  const { callTool } = recordedFake({
    timeseries: envelope(TIMESERIES),
    geoMap: envelope(GEOMAP),
    relatedQueries: envelope(RELATED),
  });
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.equal(result.status.series, 'ok');
  assert.equal(result.status.geoMap, 'ok');
  assert.equal(result.status.relatedQueries, 'ok');
  assert.equal(result.regions[0].geoName, 'Texas');
});

test('unwraps an MCP content block whose text is the HasData JSON', async () => {
  const wrapped = (payload) => ({
    content: [{ type: 'text', text: JSON.stringify({ url: 'x', status: 'ok', text: 'raw', json: payload }) }],
  });
  const { callTool } = recordedFake({
    timeseries: wrapped(TIMESERIES),
    geoMap: wrapped(GEOMAP),
    relatedQueries: wrapped(RELATED),
  });
  const result = await collectTrend('coffee', {}, { callTool, sleep: noSleep });

  assert.equal(result.status.series, 'ok');
  assert.equal(result.series.length, 2);
  assert.equal(result.regions.length, 3);
  assert.equal(result.top.length, 2);
});
