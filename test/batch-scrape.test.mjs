// Orchestrator tests with an injected fake scrape call. Nothing here opens a socket or
// reads HASDATA_API_KEY: every per-page response is scripted, which is what lets the
// failure taxonomy be tested deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { batchScrape, backoffDelay } from '../lib/batch-scrape.mjs';
import { ScrapeToolError, OUTCOME } from '../lib/scrape-errors.mjs';

// Builds a scrape function whose per-URL script is either a payload to return or an error to
// throw. Records every invocation so tests can assert order and the arguments forwarded.
function fakeScrape(scripts, { calls = [] } = {}) {
    return async function scrape(request) {
        const script = scripts.get(request.url);
        if (!script) throw new ScrapeToolError(`no scripted response for ${request.url}`);
        calls.push({ request, throwIndex: script.throws?.length ? script.throws.length : 0 });
        if (script.throws?.length) {
            throw script.throws.shift();
        }
        return script.payload;
    };
}

const jsonPayload = (statusCode, extractedData = {}) => ({
    url: 'https://example.test/',
    json: { statusCode, statusText: 'OK', extractedData },
    text: null,
});

const noSleep = async () => {};
const baseOptions = { maxRetries: 3, baseDelayMs: 10, sleep: noSleep };

test('returns one outcome per request, in input order, calling pages sequentially', async () => {
    const calls = [];
    const urls = ['https://a.test/', 'https://b.test/', 'https://c.test/'];
    const scripts = new Map(
        urls.map((url) => [url, { payload: { url, status: 200, json: null, text: 'ok' } }]),
    );
    const outcomes = await batchScrape(
        urls.map((url) => ({ url, outputFormat: ['markdown'], jsRendering: false })),
        { ...baseOptions, scrape: fakeScrape(scripts, { calls }) },
    );

    assert.equal(outcomes.length, urls.length);
    assert.deepEqual(outcomes.map((o) => o.url), urls);
    assert.deepEqual(calls.map((c) => c.request.url), urls);
    assert.ok(outcomes.every((o) => o.outcome === OUTCOME.SUCCESS));
    assert.ok(outcomes.every((o) => o.statusCode === 200));
    assert.ok(outcomes.every((o) => Array.isArray(o.missingFields) && o.notes.length >= 0));
});

test('classifies a target 403 and 404 as blocked while preserving the status code', async () => {
    const scripts = new Map([
        ['https://forbidden.test/', { payload: jsonPayload(403) }],
        ['https://gone.test/', { payload: jsonPayload(404) }],
    ]);
    const outcomes = await batchScrape(
        [
            { url: 'https://forbidden.test/', outputFormat: ['json'], jsRendering: false },
            { url: 'https://gone.test/', outputFormat: ['json'], jsRendering: false },
        ],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );

    assert.equal(outcomes[0].outcome, OUTCOME.BLOCKED);
    assert.equal(outcomes[0].statusCode, 403);
    assert.equal(outcomes[1].outcome, OUTCOME.BLOCKED);
    assert.equal(outcomes[1].statusCode, 404);
    assert.ok(outcomes.every((o) => o.notes.join(' ').includes('403') || o.notes.join(' ').includes('404')));
});

test('classifies proxyConnection errors and HTTP 400s as unreachable', async () => {
    const scripts = new Map([
        ['https://dead-proxy.test/', {
            throws: [new ScrapeToolError('proxy connection to the target failed', {
                errorType: 'proxyConnection',
            })],
        }],
        ['https://bad-request.test/', {
            throws: [new ScrapeToolError('the host could not be reached', { statusCode: 400 })],
        }],
    ]);
    const outcomes = await batchScrape(
        [{ url: 'https://dead-proxy.test/' }, { url: 'https://bad-request.test/' }],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );

    assert.deepEqual(outcomes.map((o) => o.outcome), [OUTCOME.UNREACHABLE, OUTCOME.UNREACHABLE]);
    assert.equal(outcomes[0].statusCode, null);
    assert.equal(outcomes[1].statusCode, 400);
    assert.ok(outcomes.every((o) => o.attempts === 1), 'unreachable errors must not be retried');
});

test('classifies every other exception as failed', async () => {
    const scripts = new Map([
        ['https://boom.test/', { throws: [new ScrapeToolError('internal server error', { statusCode: 500 })] }],
        ['https://plain.test/', { throws: [new Error('something threw without a status')] }],
    ]);
    const outcomes = await batchScrape(
        [{ url: 'https://boom.test/' }, { url: 'https://plain.test/' }],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );

    assert.ok(outcomes.every((o) => o.outcome === OUTCOME.FAILED));
    assert.equal(outcomes[0].statusCode, 500);
    assert.equal(outcomes[1].statusCode, null);
    assert.ok(outcomes[1].notes[0].includes('something threw without a status'));
});

test('lists every extractRules field that came back null, never guessing values', async () => {
    const extractRules = { title: 'h1', price: '.price', link: 'a @href', present: 'title' };
    const scripts = new Map([
        ['https://partial.test/', {
            payload: jsonPayload(200, { title: null, price: null, link: null, present: 'A real title' }),
        }],
    ]);
    const outcomes = await batchScrape(
        [{ url: 'https://partial.test/', outputFormat: ['json'], extractRules }],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );

    assert.equal(outcomes[0].outcome, OUTCOME.SUCCESS);
    assert.deepEqual(outcomes[0].missingFields, ['title', 'price', 'link']);
    assert.ok(!outcomes[0].missingFields.includes('present'));
    assert.ok(outcomes[0].notes.join(' ').includes('title, price, link'));
    // The nulls are carried through untouched in the payload.
    assert.equal(outcomes[0].payload.json.extractedData.price, null);
});

test('treats an empty extracted array and a dropped field as missing too', async () => {
    const extractRules = { items: '.item', dropped: '.nope' };
    const scripts = new Map([
        ['https://empty.test/', { payload: jsonPayload(200, { items: [] }) }],
    ]);
    const [outcome] = await batchScrape(
        [{ url: 'https://empty.test/', outputFormat: ['json'], extractRules }],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );
    assert.deepEqual(outcome.missingFields, ['items', 'dropped']);
});

test('warns in notes when extractLinks/extractEmails have no json landing spot', async () => {
    const scripts = new Map([
        ['https://markdown.test/', { payload: { url: 'https://markdown.test/', status: 200, json: null, text: '# hi' } }],
    ]);
    const [outcome] = await batchScrape(
        [{
            url: 'https://markdown.test/',
            outputFormat: ['markdown'],
            extractLinks: true,
            extractEmails: true,
        }],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );

    assert.equal(outcome.outcome, OUTCOME.SUCCESS);
    const notes = outcome.notes.join(' ');
    assert.ok(notes.includes('extractLinks'));
    assert.ok(notes.includes('extractEmails'));
    assert.ok(notes.includes('no links were returned'));
    assert.ok(notes.includes('no emails were returned'));
});

test('stays silent about landing spots when json is included, and still warns on a failed page', async () => {
    const okScripts = new Map([
        ['https://json.test/', { payload: jsonPayload(200, {}) }],
    ]);
    const [ok] = await batchScrape(
        [{ url: 'https://json.test/', outputFormat: ['json', 'markdown'], extractLinks: true, extractEmails: true }],
        { ...baseOptions, scrape: fakeScrape(okScripts) },
    );
    assert.equal(ok.notes.filter((n) => n.includes('extractLinks') || n.includes('extractEmails')).length, 0);

    const failScripts = new Map([
        ['https://down.test/', { throws: [new ScrapeToolError('proxy connection to the target failed', {
            errorType: 'proxyConnection',
        })] }],
    ]);
    const [failed] = await batchScrape(
        [{ url: 'https://down.test/', outputFormat: ['text'], extractLinks: true }],
        { ...baseOptions, scrape: fakeScrape(failScripts) },
    );
    assert.equal(failed.outcome, OUTCOME.UNREACHABLE);
    assert.ok(failed.notes.join(' ').includes('extractLinks'));
});

test('retries 429 with backoff and records failure with the retry count once exhausted', async () => {
    const delays = [];
    const scripts = new Map([
        ['https://limited.test/', {
            throws: Array.from({ length: 4 }, () => new ScrapeToolError('429 Too Many Requests', {
                statusCode: 429,
                retryable: true,
            })),
        }],
    ]);
    const [outcome] = await batchScrape(
        [{ url: 'https://limited.test/' }],
        {
            maxRetries: 3,
            baseDelayMs: 10,
            sleep: (ms) => { delays.push(ms); return noSleep(); },
            scrape: fakeScrape(scripts),
        },
    );

    assert.equal(outcome.outcome, OUTCOME.FAILED);
    assert.equal(outcome.statusCode, 429);
    assert.equal(outcome.attempts, 4);
    assert.equal(delays.length, 3, 'three retries sleep three times');
    assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]), 'backoff is non-decreasing');
    const note = outcome.notes.join(' ');
    assert.ok(note.includes('retried 3 time(s)'));
    assert.ok(note.includes('429'));
});

test('retries concurrency_limit errors and succeeds once the ceiling clears', async () => {
    const scripts = new Map([
        ['https://contended.test/', {
            throws: [
                new ScrapeToolError('concurrency_limit exceeded', { errorType: 'concurrency_limit' }),
                new ScrapeToolError('concurrency_limit exceeded', { errorType: 'concurrency_limit' }),
            ],
            payload: jsonPayload(200, {}),
        }],
    ]);
    const [outcome] = await batchScrape(
        [{ url: 'https://contended.test/', outputFormat: ['json'] }],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );

    assert.equal(outcome.outcome, OUTCOME.SUCCESS);
    assert.equal(outcome.attempts, 3);
    assert.ok(outcome.notes.join(' ').includes('succeeded after 2 retry attempt(s)'));
});

test('does not retry errors that are not rate or concurrency limits', async () => {
    const scripts = new Map([
        ['https://blocked-host.test/', {
            throws: [new ScrapeToolError('forbidden', { statusCode: 403 })],
            payload: jsonPayload(200),
        }],
    ]);
    const [outcome] = await batchScrape(
        [{ url: 'https://blocked-host.test/' }],
        { ...baseOptions, scrape: fakeScrape(scripts) },
    );
    assert.equal(outcome.outcome, OUTCOME.FAILED);
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.notes[0], 'forbidden');
});

test('a single page failing never interrupts the rest of the batch', async () => {
    const scripts = new Map([
        ['https://ok-1.test/', { payload: { status: 200, json: null, text: 'one' } }],
        ['https://dead.test/', { throws: [new ScrapeToolError('proxy connection to the target failed', {
            errorType: 'proxyConnection',
        })] }],
        ['https://ok-2.test/', { payload: jsonPayload(404) }],
        ['https://limited.test/', {
            throws: Array.from({ length: 4 }, () => new ScrapeToolError('concurrency_limit', {
                errorType: 'concurrency_limit',
            })),
        }],
        ['https://ok-3.test/', { payload: jsonPayload(200, { h: 'x' }) }],
    ]);
    const requests = [...scripts.keys()].map((url) => ({ url, outputFormat: ['json'] }));
    const outcomes = await batchScrape(requests, { ...baseOptions, scrape: fakeScrape(scripts) });

    assert.equal(outcomes.length, requests.length);
    assert.deepEqual(outcomes.map((o) => o.url), requests.map((r) => r.url));
    assert.deepEqual(outcomes.map((o) => o.outcome), [
        OUTCOME.SUCCESS,
        OUTCOME.UNREACHABLE,
        OUTCOME.BLOCKED,
        OUTCOME.FAILED,
        OUTCOME.SUCCESS,
    ]);
});

test('forwards the full request arguments to the injected scrape call', async () => {
    const calls = [];
    const request = {
        url: 'https://args.test/',
        outputFormat: ['json', 'markdown'],
        jsRendering: true,
        extractRules: { title: 'h1' },
        extractLinks: true,
        proxyCountry: 'DE',
    };
    const scripts = new Map([[request.url, { payload: jsonPayload(200, { title: 'T' }) }]]);
    await batchScrape([request], { ...baseOptions, scrape: fakeScrape(scripts, { calls }) });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request, request);
});

test('records malformed entries as failed instead of throwing', async () => {
    const outcomes = await batchScrape(
        [{ outputFormat: ['json'] }, null, 'https://not-an-object.test/'],
        { ...baseOptions, scrape: fakeScrape(new Map()) },
    );
    assert.equal(outcomes.length, 3);
    assert.ok(outcomes.every((o) => o.outcome === OUTCOME.FAILED));
    assert.ok(outcomes.every((o) => o.notes[0].includes('invalid request entry')));
    assert.equal(outcomes[0].url, null);
});

test('rejects a non-array batch up front', async () => {
    await assert.rejects(() => batchScrape({ url: 'https://x.test/' }), TypeError);
    assert.deepEqual(await batchScrape([], baseOptions), []);
});

test('backoff delays grow exponentially and respect the cap', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
    const first = backoffDelay(0, opts, 'a');
    assert.ok(first >= 100 && first < 150, `first delay ${first} should sit in the base+jitter band`);
    assert.ok(backoffDelay(1, opts, 'a') >= 200);
    assert.ok(backoffDelay(2, opts, 'a') >= 400);
    assert.equal(backoffDelay(10, opts, 'a'), 1000);
});

test('survives a scrape call that throws a non-Error value', async () => {
    const scrape = async () => { throw 'stringly-typed failure'; };
    const [outcome] = await batchScrape([{ url: 'https://x.test/' }], { ...baseOptions, scrape });
    assert.equal(outcome.outcome, OUTCOME.FAILED);
    assert.ok(outcome.notes[0].includes('stringly-typed failure'));
});
