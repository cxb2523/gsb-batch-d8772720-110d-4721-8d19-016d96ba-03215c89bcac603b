/**
 * Offline integration tests for backend/smartScraper.js.
 *
 * smartScraper pulls in browser/scraping packages at module load
 * (playwright-extra, turndown, linkedom, ...). Those packages are not
 * required to validate the tiered-pipeline wiring, so before requiring the
 * module we install a Module._load hook that stubs every external package
 * with minimal in-memory fakes. The scraping engines themselves are
 * injected through runSmartBrowsePipeline's `overrides` parameter, meaning
 * no Python process, browser, network, or API key is ever touched.
 *
 * Run from the backend directory:
 *     node --test
 * or:
 *     node --test test/smartScraper.integration.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// --- Stub external modules before smartScraper is loaded -----------------

const canvasCalls = [];

const stubs = {
    'playwright-extra': { chromium: { use() {}, async launch() { throw new Error('real browser must not launch in tests'); } } },
    'puppeteer-extra-plugin-stealth': Object.assign(() => ({}), { default: () => ({}) }),
    '@mozilla/readability': { Readability: class Readability { parse() { return null; } } },
    linkedom: { parseHTML: () => ({ document: {} }) },
    turndown: class TurndownService {
        remove() {}
        turndown(html) { return html; }
    },
    axios: {
        default: {},
        async get() { throw new Error('real HTTP must not happen in tests'); },
        async post() { throw new Error('real HTTP must not happen in tests'); },
    },
    'fs-extra': {
        async ensureDir() {}, async pathExists() { return false; },
        async readJson() { return []; }, async writeJson() {},
    },
    './canvasBridge': { pushToCanvas(payload) { canvasCalls.push(payload); } },
    './configHelper': {
        getBackendApiKey() { return ''; },
        getBackendModel() { return 'stub-model'; },
    },
    // The real canvasBridge starts a setInterval heartbeat that would keep
    // this test process alive; staying on the stub also means no network or
    // browser process is ever touched. The hook therefore stays installed
    // for the lifetime of the test process.
    ollama: { Ollama: class Ollama {} },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
};

const smartScraper = require('../smartScraper');
const { ENGINES, STATUS } = require('../scrapeOrchestrator');

// --- Fake engine factories ------------------------------------------------

const LONG_MARKDOWN = '# Crawl4AI Article\n\nBody with well over thirty characters of real page content.';

function fakeCrawl4AI(markdown = LONG_MARKDOWN) {
    return async () => ({
        success: true,
        title: 'Crawl4AI Title',
        markdown,
        images: [],
        url: 'https://example.com',
        charCount: markdown.length,
        method: 'crawl4ai',
    });
}

function failingCrawl4AI(message) {
    return async () => { throw new Error(message); };
}

function fakePlaywright(markdown = 'Playwright markdown body that is also longer than thirty characters.') {
    return async () => ({
        title: 'Playwright Title',
        markdown,
        url: 'https://example.com',
        charCount: markdown.length,
        method: 'readability',
    });
}

function failingPlaywright(message) {
    return async () => { throw new Error(message); };
}

function fakeJina(markdown = 'Jina reader markdown body that is also longer than thirty characters.') {
    return async () => ({
        title: 'Jina Reader Result',
        markdown,
        url: 'https://example.com',
        charCount: markdown.length,
        method: 'jina-fallback',
    });
}

function failingJina(message) {
    return async () => { throw new Error(message); };
}

// --- Scenario 1 through the real smartScraper wiring ----------------------

test('Integration: Crawl4AI success returns unchanged content plus one success attempt', async () => {
    const result = await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'markdown', maxChars: 15000 },
        {
            crawl4ai: fakeCrawl4AI(),
            playwright: failingPlaywright('playwright must not run'),
            jina: failingJina('jina must not run'),
        }
    );

    assert.equal(result.markdown, LONG_MARKDOWN);
    assert.equal(result.title, 'Crawl4AI Title');
    assert.equal(result.charCount, LONG_MARKDOWN.length);
    assert.equal(result.method, 'crawl4ai');
    assert.deepEqual(result.images, []);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].engine, ENGINES.CRAWL4AI);
    assert.equal(result.attempts[0].status, STATUS.SUCCESS);
    assert.equal(result.attempts[0].error, null);
    assert.equal(typeof result.attempts[0].durationMs, 'number');
});

test('Integration: text action on Crawl4AI success mirrors markdown into text without altering markdown', async () => {
    const result = await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'text' },
        { crawl4ai: fakeCrawl4AI(), playwright: failingPlaywright('no'), jina: failingJina('no') }
    );

    assert.equal(result.method, 'crawl4ai');
    assert.equal(result.text, result.markdown);
    assert.equal(result.markdown, LONG_MARKDOWN);
});

test('Integration: Crawl4AI too short -> Playwright success, attempts record reason then success', async () => {
    const pwMarkdown = 'Playwright recovered the page with a sufficiently long body.';
    const result = await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'markdown' },
        {
            crawl4ai: fakeCrawl4AI('x'.repeat(30)),
            playwright: fakePlaywright(pwMarkdown),
            jina: failingJina('jina must not run'),
        }
    );

    assert.equal(result.method, 'readability');
    assert.equal(result.markdown, pwMarkdown);
    assert.deepEqual(result.attempts.map(a => a.engine), [ENGINES.CRAWL4AI, ENGINES.PLAYWRIGHT]);
    assert.equal(result.attempts[0].status, STATUS.FAILED);
    assert.match(result.attempts[0].error, /too short/i);
    assert.equal(result.attempts[1].status, STATUS.SUCCESS);
    assert.equal(result.attempts[1].error, null);
});

test('Integration: Crawl4AI throws -> Playwright throws -> Jina succeeds', async () => {
    const jinaMarkdown = 'Jina rescued the page with enough content to pass any threshold.';
    const result = await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'markdown' },
        {
            crawl4ai: failingCrawl4AI('runner delimiter missing'),
            playwright: failingPlaywright('net::ERR_NAME_NOT_RESOLVED'),
            jina: fakeJina(jinaMarkdown),
        }
    );

    assert.equal(result.method, 'jina-fallback');
    assert.equal(result.markdown, jinaMarkdown);
    assert.deepEqual(result.attempts.map(a => a.status), [STATUS.FAILED, STATUS.FAILED, STATUS.SUCCESS]);
    assert.match(result.attempts[0].error, /delimiter missing/);
    assert.match(result.attempts[1].error, /ERR_NAME_NOT_RESOLVED/);
    assert.equal(result.attempts[2].error, null);
    // Failure text never leaks into the successful markdown body.
    assert.ok(!result.markdown.includes('ERR_NAME_NOT_RESOLVED'));
});

test('Integration: all three fail preserves every failure reason in attempts and legacy all-failed body', async () => {
    const url = 'https://down.example.com';
    const result = await smartScraper.runSmartBrowsePipeline(
        url,
        { action: 'markdown' },
        {
            crawl4ai: failingCrawl4AI('Crawl4AI exited with code 1'),
            playwright: failingPlaywright('browser crashed'),
            jina: failingJina('status code 500'),
        }
    );

    assert.equal(result.method, 'all-failed');
    assert.equal(result.title, 'Error');
    assert.equal(
        result.markdown,
        'All extraction methods failed for https://down.example.com. Error: status code 500'
    );
    assert.equal(result.attempts.length, 3);
    assert.deepEqual(result.attempts.map(a => a.engine), [ENGINES.CRAWL4AI, ENGINES.PLAYWRIGHT, ENGINES.JINA]);
    assert.ok(result.attempts.every(a => a.status === STATUS.FAILED));
    assert.match(result.attempts[0].error, /exited with code 1/);
    assert.match(result.attempts[1].error, /browser crashed/);
    assert.match(result.attempts[2].error, /status code 500/);
    // Earlier failure reasons must not be embedded into markdown content.
    assert.ok(!result.markdown.includes('browser crashed'));
    assert.ok(!result.markdown.includes('exited with code 1'));
});

test('Integration: screenshot requests skip Crawl4AI entirely', async () => {
    const invoked = [];
    const result = await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'markdown', takeScreenshot: true },
        {
            crawl4ai: async () => { invoked.push(ENGINES.CRAWL4AI); throw new Error('must be skipped'); },
            playwright: async () => { invoked.push(ENGINES.PLAYWRIGHT); throw new Error('pw failed'); },
            jina: async () => { invoked.push(ENGINES.JINA); return fakeJina()(); },
        }
    );

    assert.deepEqual(invoked, [ENGINES.PLAYWRIGHT, ENGINES.JINA]);
    assert.deepEqual(result.attempts.map(a => a.engine), [ENGINES.PLAYWRIGHT, ENGINES.JINA]);
    assert.equal(result.method, 'jina-fallback');
});

test('Integration: canvas push uses non-fallback labeling for Crawl4AI and fallback labeling for Jina', async () => {
    canvasCalls.length = 0;
    await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'markdown', pushToCanvas: true },
        { crawl4ai: fakeCrawl4AI(), playwright: failingPlaywright('no'), jina: failingJina('no') }
    );
    assert.ok(canvasCalls.length >= 1);
    assert.ok(canvasCalls.some(c => c.label === 'SMART BROWSER'));

    canvasCalls.length = 0;
    await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'markdown', pushToCanvas: true },
        {
            crawl4ai: failingCrawl4AI('boom'),
            playwright: failingPlaywright('boom'),
            jina: fakeJina(),
        }
    );
    assert.ok(canvasCalls.some(c => String(c.label).includes('FALLBACK')));
});

test('Integration: smartBrowse result preserves legacy fields and carries the attempts trail', async () => {
    // The public smartBrowse() delegates to the injectable pipeline; assert
    // the returned end-to-end contract (legacy fields + attempts) on the
    // same pipeline call shape smartBrowse makes internally.
    const result = await smartScraper.runSmartBrowsePipeline(
        'https://example.com',
        { action: 'markdown' },
        {
            crawl4ai: failingCrawl4AI('tier one down'),
            playwright: failingPlaywright('tier two down'),
            jina: fakeJina(),
        }
    );
    for (const key of ['markdown', 'title', 'charCount', 'method', 'attempts']) {
        assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing legacy field ${key}`);
    }
    assert.equal(result.method, 'jina-fallback');
    assert.equal(result.attempts.length, 3);
    assert.deepEqual(result.attempts.map(a => a.engine), [ENGINES.CRAWL4AI, ENGINES.PLAYWRIGHT, ENGINES.JINA]);
    assert.equal(result.attempts[2].status, STATUS.SUCCESS);
});

test('Integration: standalone jinaFallback keeps its never-throwing legacy contract', async () => {
    // jinaFallback is the wrapper used by the /api/web/jina endpoint.
    // Swap the stubbed axios methods it calls through; the wrapper must
    // resolve to the legacy all-failed shape instead of rejecting.
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async () => ({
        data: 'Standalone jina body with enough content to exceed thirty characters.',
    });
    const ok = await smartScraper.jinaFallback('https://example.com', 15000);
    assert.equal(ok.method, 'jina-fallback');
    assert.equal(ok.title, 'Jina Reader Result');
    assert.equal(ok.charCount, ok.markdown.length);

    axios.get = async () => { throw new Error('network down'); };
    try {
        const failed = await smartScraper.jinaFallback('https://example.com', 15000);
        assert.equal(failed.method, 'all-failed');
        assert.equal(failed.title, 'Error');
        assert.match(failed.markdown, /All extraction methods failed/);
        assert.match(failed.markdown, /network down/);
    } finally {
        axios.get = originalGet;
    }
});
