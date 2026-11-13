/**
 * Offline tests for the tiered scraping orchestrator.
 *
 * Runs entirely on Node's built-in test runner — no third-party
 * dependencies, no browser, no network, no API keys. The three scraping
 * engines (Crawl4AI / Playwright / Jina) are replaced with injected fakes
 * so the tests are fully deterministic.
 *
 * Run from the backend directory:
 *     node --test
 * or explicitly:
 *     node --test test/scrapeOrchestrator.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ENGINES,
    STATUS,
    MIN_VALID_CONTENT_LENGTH,
    validateCrawl4AIPayload,
    buildAllFailedResult,
    runScrapePipeline,
    mergeDeepResearchResults,
} = require('../scrapeOrchestrator');

// --- Helpers -------------------------------------------------------------

// A payload identical in shape to what the real Crawl4AI runner emits,
// with content comfortably above the 30-character validity threshold.
const LONG_MARKDOWN = '# Real Article\n\nThis is a long enough body with well over thirty characters of content.';

function crawl4aiSuccess(overrides = {}) {
    return {
        success: true,
        title: 'Crawl4AI Title',
        markdown: LONG_MARKDOWN,
        images: [],
        url: 'https://example.com',
        charCount: LONG_MARKDOWN.length,
        method: 'crawl4ai',
        ...overrides,
    };
}

function playwrightSuccess(markdown = 'Playwright extracted markdown body that is also longer than thirty characters.') {
    return {
        title: 'Playwright Title',
        markdown,
        url: 'https://example.com',
        charCount: markdown.length,
        method: 'readability',
    };
}

function jinaSuccess(markdown = 'Jina reader markdown content that is also longer than thirty characters.') {
    return {
        title: 'Jina Reader Result',
        markdown,
        url: 'https://example.com',
        charCount: markdown.length,
        method: 'jina-fallback',
    };
}

// Build the exact engine list smartScraper uses for a markdown request.
function buildEngines(runners) {
    return [
        { name: ENGINES.CRAWL4AI, run: runners.crawl4ai },
        { name: ENGINES.PLAYWRIGHT, run: runners.playwright },
        { name: ENGINES.JINA, run: runners.jina },
    ];
}

// The same validation wrapper used by runSmartBrowsePipeline: only the
// Crawl4AI tier applies the short-content validity rule.
function smartBrowseValidate(engineName, payload) {
    return engineName === ENGINES.CRAWL4AI
        ? validateCrawl4AIPayload(payload)
        : payload;
}

// --- Scenario 1: Crawl4AI succeeds --------------------------------------

test('Scenario 1: Crawl4AI succeeds — only one attempt, content untouched', async () => {
    const expected = crawl4aiSuccess();
    const calls = [];

    const result = await runScrapePipeline(
        buildEngines({
            crawl4ai: async () => { calls.push(ENGINES.CRAWL4AI); return expected; },
            playwright: async () => { calls.push(ENGINES.PLAYWRIGHT); throw new Error('must not be called'); },
            jina: async () => { calls.push(ENGINES.JINA); throw new Error('must not be called'); },
        }),
        { url: expected.url, validate: smartBrowseValidate }
    );

    // Lower tiers are never reached on a Tier 1 success.
    assert.deepEqual(calls, [ENGINES.CRAWL4AI]);

    // Successful payload fields are returned unchanged.
    assert.equal(result.markdown, LONG_MARKDOWN);
    assert.equal(result.title, expected.title);
    assert.equal(result.charCount, expected.charCount);
    assert.equal(result.method, 'crawl4ai');
    assert.equal(result.url, expected.url);
    assert.deepEqual(result.images, []);

    assert.ok(Array.isArray(result.attempts));
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].engine, ENGINES.CRAWL4AI);
    assert.equal(result.attempts[0].status, STATUS.SUCCESS);
    assert.equal(result.attempts[0].error, null);
    assert.equal(typeof result.attempts[0].durationMs, 'number');
    assert.ok(result.attempts[0].durationMs >= 0);
});

// --- Scenario 2: Crawl4AI too short, Playwright succeeds ----------------

test('Scenario 2: Crawl4AI content too short -> degraded to Playwright, which succeeds', async () => {
    const shortMarkdown = 'x'.repeat(MIN_VALID_CONTENT_LENGTH); // exactly 30 chars -> invalid
    const expected = playwrightSuccess();
    const calls = [];

    const result = await runScrapePipeline(
        buildEngines({
            crawl4ai: async () => {
                calls.push(ENGINES.CRAWL4AI);
                return crawl4aiSuccess({ markdown: shortMarkdown, charCount: shortMarkdown.length });
            },
            playwright: async () => { calls.push(ENGINES.PLAYWRIGHT); return expected; },
            jina: async () => { calls.push(ENGINES.JINA); throw new Error('must not be called'); },
        }),
        { url: expected.url, validate: smartBrowseValidate }
    );

    assert.deepEqual(calls, [ENGINES.CRAWL4AI, ENGINES.PLAYWRIGHT]);

    // The successful payload is exactly what Playwright produced.
    assert.equal(result.markdown, expected.markdown);
    assert.equal(result.title, expected.title);
    assert.equal(result.charCount, expected.charCount);
    assert.equal(result.method, 'readability');

    assert.equal(result.attempts.length, 2);

    assert.equal(result.attempts[0].engine, ENGINES.CRAWL4AI);
    assert.equal(result.attempts[0].status, STATUS.FAILED);
    assert.ok(result.attempts[0].error, 'failure reason must be recorded');
    assert.match(result.attempts[0].error, /too short/i);
    assert.match(result.attempts[0].error, /30/);
    assert.equal(typeof result.attempts[0].durationMs, 'number');

    assert.equal(result.attempts[1].engine, ENGINES.PLAYWRIGHT);
    assert.equal(result.attempts[1].status, STATUS.SUCCESS);
    assert.equal(result.attempts[1].error, null);
});

test('Scenario 2b: Crawl4AI throws (not just short content) -> Playwright still succeeds', async () => {
    const result = await runScrapePipeline(
        buildEngines({
            crawl4ai: async () => { throw new Error('Crawl4AI delimiter not found in runner output'); },
            playwright: async () => playwrightSuccess(),
            jina: async () => { throw new Error('must not be called'); },
        }),
        { url: 'https://example.com', validate: smartBrowseValidate }
    );

    assert.equal(result.method, 'readability');
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].engine, ENGINES.CRAWL4AI);
    assert.equal(result.attempts[0].status, STATUS.FAILED);
    assert.match(result.attempts[0].error, /delimiter not found/);
    assert.equal(result.attempts[1].status, STATUS.SUCCESS);
    assert.equal(result.attempts[1].engine, ENGINES.PLAYWRIGHT);
});

test('Boundary: 31 trimmed characters are accepted, whitespace-only padding does not count', () => {
    const payload = crawl4aiSuccess({ markdown: 'y'.repeat(31) });
    assert.doesNotThrow(() => validateCrawl4AIPayload(payload));

    // 31 visible chars surrounded by whitespace still counts as 31.
    const padded = crawl4aiSuccess({ markdown: `   ${'y'.repeat(31)}   ` });
    assert.doesNotThrow(() => validateCrawl4AIPayload(padded));

    // Exactly 30 trimmed chars must be rejected.
    assert.throws(
        () => validateCrawl4AIPayload(crawl4aiSuccess({ markdown: 'z'.repeat(30) })),
        /too short/
    );
    // Missing markdown must be rejected with its own reason.
    assert.throws(
        () => validateCrawl4AIPayload({ markdown: '' }),
        /no markdown/i
    );
});

// --- Scenario 3: all three engines fail ---------------------------------

test('Scenario 3: all three engines fail — full attempts trail and legacy all-failed shape', async () => {
    const url = 'https://blocked.example.com';
    const calls = [];

    const result = await runScrapePipeline(
        buildEngines({
            crawl4ai: async () => { calls.push(ENGINES.CRAWL4AI); throw new Error('Crawl4AI exited with code 1: boom'); },
            playwright: async () => { calls.push(ENGINES.PLAYWRIGHT); throw new Error('page.goto: net::ERR_CONNECTION_REFUSED'); },
            jina: async () => { calls.push(ENGINES.JINA); throw new Error('Request failed with status code 429'); },
        }),
        { url, validate: smartBrowseValidate }
    );

    // Degradation never aborts: every tier runs in order.
    assert.deepEqual(calls, [ENGINES.CRAWL4AI, ENGINES.PLAYWRIGHT, ENGINES.JINA]);

    // Legacy all-failed payload is preserved (wording unchanged).
    assert.equal(result.method, 'all-failed');
    assert.equal(result.title, 'Error');
    assert.equal(
        result.markdown,
        'All extraction methods failed for https://blocked.example.com. Error: Request failed with status code 429'
    );

    assert.equal(result.attempts.length, 3);
    assert.deepEqual(
        result.attempts.map(a => a.engine),
        [ENGINES.CRAWL4AI, ENGINES.PLAYWRIGHT, ENGINES.JINA]
    );
    assert.ok(result.attempts.every(a => a.status === STATUS.FAILED));
    assert.match(result.attempts[0].error, /exited with code 1/);
    assert.match(result.attempts[1].error, /ERR_CONNECTION_REFUSED/);
    assert.match(result.attempts[2].error, /429/);
    assert.ok(result.attempts.every(a => typeof a.durationMs === 'number' && a.durationMs >= 0));

    // Failure reasons must live in attempts, never be smuggled into markdown
    // as if they were page content.
    assert.ok(!result.markdown.includes('ERR_CONNECTION_REFUSED'));
    assert.ok(!result.markdown.includes('exited with code 1'));
});

test('Failure reasons never overwrite successful markdown content', async () => {
    const good = jinaSuccess();
    const result = await runScrapePipeline(
        buildEngines({
            crawl4ai: async () => { throw new Error('tier1 reason secret'); },
            playwright: async () => { throw new Error('tier2 reason secret'); },
            jina: async () => good,
        }),
        { url: good.url, validate: smartBrowseValidate }
    );

    assert.equal(result.method, 'jina-fallback');
    assert.equal(result.markdown, good.markdown);
    assert.ok(!result.markdown.includes('secret'));
    assert.equal(result.attempts.length, 3);
    assert.equal(result.attempts[0].error, 'tier1 reason secret');
    assert.equal(result.attempts[1].error, 'tier2 reason secret');
    assert.equal(result.attempts[2].status, STATUS.SUCCESS);
});

// --- Engine ordering / skip rules mirroring smartScraper ----------------

test('Screenshot requests skip Crawl4AI: attempts begin directly with Playwright then Jina', async () => {
    // Replicates runSmartBrowsePipeline's engine-list construction.
    const action = 'markdown';
    const takeScreenshot = true;
    const engines = [];
    if ((action === 'markdown' || action === 'text') && !takeScreenshot) {
        engines.push({ name: ENGINES.CRAWL4AI, run: async () => crawl4aiSuccess() });
    }
    engines.push({ name: ENGINES.PLAYWRIGHT, run: async () => { throw new Error('pw boom'); } });
    engines.push({ name: ENGINES.JINA, run: async () => jinaSuccess() });

    const result = await runScrapePipeline(engines, {
        url: 'https://example.com',
        validate: smartBrowseValidate,
    });

    assert.deepEqual(result.attempts.map(a => a.engine), [ENGINES.PLAYWRIGHT, ENGINES.JINA]);
    assert.equal(result.method, 'jina-fallback');
});

// --- Deep research: per-source attempts survive the merge ---------------

test('Deep research merger keeps each source attempts; report body format is fixed', async () => {
    const items = [
        {
            searchTitle: 'Source One',
            title: 'Real Title 1',
            url: 'https://a.example.com',
            method: 'crawl4ai',
            charCount: 100,
            markdown: 'Body A',
            attempts: [
                { engine: ENGINES.CRAWL4AI, status: STATUS.SUCCESS, error: null, durationMs: 5 },
            ],
        },
        {
            searchTitle: 'Source Two',
            title: 'Real Title 2',
            url: 'https://b.example.com',
            method: 'readability',
            charCount: 80,
            screenshotPath: '/images/shot.jpg',
            markdown: 'Body B',
            attempts: [
                { engine: ENGINES.CRAWL4AI, status: STATUS.FAILED, error: 'too short', durationMs: 3 },
                { engine: ENGINES.PLAYWRIGHT, status: STATUS.SUCCESS, error: null, durationMs: 9 },
            ],
        },
        {
            searchTitle: 'Source Three',
            title: 'Error',
            url: 'https://c.example.com',
            method: 'all-failed',
            markdown: 'All extraction methods failed for https://c.example.com. Error: 429',
            attempts: [
                { engine: ENGINES.CRAWL4AI, status: STATUS.FAILED, error: 'e1', durationMs: 1 },
                { engine: ENGINES.PLAYWRIGHT, status: STATUS.FAILED, error: 'e2', durationMs: 2 },
                { engine: ENGINES.JINA, status: STATUS.FAILED, error: '429', durationMs: 4 },
            ],
        },
    ];

    const { report, sources, totalChars } = mergeDeepResearchResults('test query', items);

    assert.equal(sources.length, 3);
    assert.deepEqual(sources[0].attempts, items[0].attempts);
    assert.equal(sources[1].attempts.length, 2);
    assert.equal(sources[1].attempts[0].error, 'too short');
    assert.equal(sources[2].attempts.length, 3);

    // Sources without attempts get an empty array rather than undefined.
    const noAttempts = mergeDeepResearchResults('q', [{
        title: 'T', url: 'u', method: 'readability', charCount: 5, markdown: 'm',
    }]);
    assert.deepEqual(noAttempts.sources[0].attempts, []);

    // Report text exactly matches the pre-change format.
    const expectedReport = [
        '# Deep Research: test query',
        '',
        '---',
        '',
        '## Source 1: Source One',
        '> URL: https://a.example.com',
        '> Extraction method: crawl4ai',
        '',
        'Body A',
        '',
        '---',
        '',
        '## Source 2: Source Two',
        '> URL: https://b.example.com',
        '> Extraction method: readability',
        '',
        '![Screenshot of Real Title 2](/images/shot.jpg)',
        '',
        '---',
        '',
        'Body B',
        '',
        '---',
        '',
        '## Source 3: Source Three',
        '> URL: https://c.example.com',
        '> Extraction method: all-failed',
        '',
        'All extraction methods failed for https://c.example.com. Error: 429',
        '',
        '',
    ].join('\n');
    assert.equal(report, expectedReport);
    assert.equal(totalChars, 100 + 80 + items[2].markdown.length);
});

test('buildAllFailedResult preserves the legacy failure payload shape', () => {
    const r = buildAllFailedResult('https://x.example.com', 'boom');
    assert.deepEqual(r, {
        title: 'Error',
        markdown: 'All extraction methods failed for https://x.example.com. Error: boom',
        url: 'https://x.example.com',
        method: 'all-failed',
    });
});
