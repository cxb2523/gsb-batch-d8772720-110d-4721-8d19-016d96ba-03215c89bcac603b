// Offline tests for the reusable sourcing pipeline in lib/image-sourcing.mjs.
//
// Every external dependency is injected: a fake searcher stands in for the HasData MCP call and
// a fake fetchImage stands in for downloading originals. No API key, no timers on the network,
// no public internet. The live contract suite in tools.test.mjs is untouched and stays the only
// place that talks to HasData.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildTbs,
    collectImages,
    createHttpSearcher,
    defaultFetchImage,
    SIZE_FLOORS,
} from '../lib/image-sourcing.mjs';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeEntry(position, overrides = {}) {
    return {
        position,
        title: `image ${position}`,
        source: `example ${position}`,
        link: `https://example.com/page/${position}`,
        original: `https://cdn.example.com/img/${position}.png`,
        thumbnail: `https://encrypted-tbn0.gstatic.com/thumb/${position}`,
        originalWidth: 2000,
        originalHeight: 1500,
        ...overrides,
    };
}

function makeSearcher(entries) {
    const calls = [];
    const searcher = async (request) => {
        calls.push(request);
        return { imagesResults: entries };
    };
    return { searcher, calls };
}

// A fetcher whose policy is driven per URL. urls map original -> result object; missing urls
// succeed with a PNG payload.
function makeFetchImage(policy = {}) {
    const fetched = [];
    const fetchImage = async (url, opts) => {
        fetched.push({ url, opts });
        const rule = policy[url];
        if (rule) return rule;
        return { ok: true, status: 200, contentType: 'image/png', byteLength: PNG_HEADER.length, bytes: PNG_HEADER };
    };
    return { fetchImage, fetched };
}

// ---------------------------------------------------------------------------
// Scenario 1: every original loads
// ---------------------------------------------------------------------------

test('all originals succeed: ten candidates are kept with the five manifest fields', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => makeEntry(i + 1));
    const { searcher, calls } = makeSearcher(entries);
    const { fetchImage, fetched } = makeFetchImage();

    const result = await collectImages({
        q: 'austin skyline',
        minWidth: 1000,
        minHeight: 800,
        color: 'gray',
        type: 'photo',
        searcher,
        fetchImage,
    });

    // The tbs string uses documented tokens only; floor picks the largest code that fits.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
        q: 'austin skyline',
        tbs: 'isz:lt,islt:svga,ic:gray,itp:photo',
        ijn: undefined,
    });
    assert.deepEqual(result.filtersAssembled, ['isz:lt', 'islt:svga', 'ic:gray', 'itp:photo']);

    assert.equal(result.keptCount, 10);
    assert.equal(result.droppedCount, 0);
    assert.equal(result.totalAvailable, 12);
    assert.equal(result.filterMaybeIgnored, false);
    assert.equal(fetched.length, 10); // stopped at the target, no paging

    for (const candidate of result.candidates) {
        assert.ok(candidate.title, 'candidate keeps title');
        assert.ok(candidate.source, 'candidate keeps source');
        assert.equal(typeof candidate.originalWidth, 'number');
        assert.equal(typeof candidate.originalHeight, 'number');
        assert.ok(candidate.link.startsWith('https://example.com/page/'), 'candidate keeps page link');
        assert.ok(candidate.original.endsWith('.png'), 'candidate keeps original URL');
        assert.equal(candidate.fetch.ok, true);
        assert.equal(candidate.image.byteLength, PNG_HEADER.byteLength);
        assert.equal(candidate.sizeBelowMinimum, false);
    }
});

// ---------------------------------------------------------------------------
// Scenario 2: some originals are dead / hotlink-blocked / not an image
// ---------------------------------------------------------------------------

test('partial original failures: dead entries are dropped and counted, the same batch fills the gap', async () => {
    const entries = Array.from({ length: 13 }, (_, i) => makeEntry(i + 1));
    const { searcher, calls } = makeSearcher(entries);

    const dead = {
        'https://cdn.example.com/img/2.png': { ok: false, reason: 'http-status', status: 404 },
        'https://cdn.example.com/img/4.png': { ok: false, reason: 'timeout' },
        'https://cdn.example.com/img/9.png': {
            ok: false,
            reason: 'not-image-content',
            status: 200,
            contentType: 'text/html',
        },
    };
    const { fetchImage, fetched } = makeFetchImage(dead);

    const result = await collectImages({ q: 'austin skyline', searcher, fetchImage });

    assert.equal(calls.length, 1, 'no automatic paging after failures');
    assert.equal(result.keptCount, 10, 'vacancies are filled from later entries in the same batch');
    assert.equal(result.droppedCount, 3);
    assert.equal(result.totalAvailable, 13);
    // Entries 11, 12 and 13 are all needed: three dead leaves exactly ten alive out of 13.
    assert.deepEqual(
        fetched.map((f) => f.url),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => `https://cdn.example.com/img/${n}.png`),
    );

    const keptUrls = new Set(result.candidates.map((c) => c.original));
    for (const url of Object.keys(dead)) assert.equal(keptUrls.has(url), false, 'dead original was kept anyway');

    const reasons = result.dropped.map((d) => d.fetch.reason).sort();
    assert.deepEqual(reasons, ['http-status', 'not-image-content', 'timeout']);
    // Dropped items remain inspectable manifest rows rather than vanishing.
    for (const item of result.dropped) {
        assert.ok(item.title && item.source && item.link && item.original);
    }
});

test('a missing original URL and a fetcher that throws are both counted as drops, not crashes', async () => {
    const entries = [
        makeEntry(1, { original: undefined }),
        makeEntry(2),
        makeEntry(3),
    ];
    const { searcher } = makeSearcher(entries);
    const fetchImage = async (url) => {
        if (url.includes('img/2')) throw new Error('socket hang up');
        return { ok: true, status: 200, contentType: 'image/png', byteLength: PNG_HEADER.length, bytes: PNG_HEADER };
    };

    const result = await collectImages({ q: 'x', target: 3, searcher, fetchImage });
    assert.equal(result.keptCount, 1);
    assert.equal(result.droppedCount, 2);
    assert.equal(result.dropped[0].fetch.reason, 'missing-original-url');
    assert.equal(result.dropped[1].fetch.reason, 'network-error');
});

// ---------------------------------------------------------------------------
// Scenario 3: returned dimensions are below the requested floor
// ---------------------------------------------------------------------------

test('retained entries under the size floor flag the tbs filter as possibly ignored', async () => {
    const entries = [
        makeEntry(1, { originalWidth: 1600, originalHeight: 1200 }),
        makeEntry(2, { originalWidth: 800, originalHeight: 600 }),
        makeEntry(3, { originalWidth: 800, originalHeight: 600 }),
        makeEntry(4, { originalWidth: 1920, originalHeight: 900 }),
    ];
    const { searcher, calls } = makeSearcher(entries);
    const { fetchImage } = makeFetchImage();

    // 1500x1000 maps to the xga floor because 2mp over-filters; Google can still ignore it.
    const result = await collectImages({ q: 'logo', minWidth: 1500, minHeight: 1000, searcher, fetchImage });

    assert.equal(calls[0].tbs, 'isz:lt,islt:xga');
    assert.equal(result.keptCount, 4, 'small entries are flagged, not silently removed');
    assert.equal(result.filterMaybeIgnored, true);
    assert.deepEqual(result.sizeMinimum, { width: 1500, height: 1000 });

    assert.equal(result.candidates[0].sizeBelowMinimum, false);
    assert.equal(result.candidates[1].sizeBelowMinimum, true);
    assert.match(result.candidates[1].warnings[0], /filter may have been ignored/);
    assert.match(result.candidates[1].warnings[0], /800x600/);
    assert.equal(result.candidates[3].sizeBelowMinimum, true, '1080 is below the 1000-height floor');
});

test('entries without dimensions cannot prove the floor held and are flagged too', async () => {
    const entries = [makeEntry(1, { originalWidth: undefined, originalHeight: undefined })];
    const { searcher } = makeSearcher(entries);
    const { fetchImage } = makeFetchImage();

    const result = await collectImages({ q: 'logo', minWidth: 1000, searcher, fetchImage });
    assert.equal(result.filterMaybeIgnored, true);
    assert.equal(result.candidates[0].sizeBelowMinimum, true);
    assert.match(result.candidates[0].warnings[0], /cannot be verified/);
});

test('no size floor means no ignored-filter verdict', async () => {
    const entries = [makeEntry(1, { originalWidth: 10, originalHeight: 10 })];
    const { searcher } = makeSearcher(entries);
    const { fetchImage } = makeFetchImage();

    const result = await collectImages({ q: 'tiny', searcher, fetchImage });
    assert.equal(result.filterMaybeIgnored, false);
    assert.equal(result.candidates[0].sizeBelowMinimum, false);
});

// ---------------------------------------------------------------------------
// Scenario 4: no filters, tbs is the empty string
// ---------------------------------------------------------------------------

test('empty filter request passes an empty tbs and never pages', async () => {
    const entries = Array.from({ length: 3 }, (_, i) => makeEntry(i + 1));
    const { searcher, calls } = makeSearcher(entries);
    const { fetchImage } = makeFetchImage();

    const result = await collectImages({ q: 'anything', searcher, fetchImage });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tbs, '');
    assert.equal(calls[0].ijn, undefined);
    assert.deepEqual(result.filtersAssembled, []);
    assert.equal(result.keptCount, 3, 'a short batch is delivered as-is without paging');
    assert.equal(result.droppedCount, 0);
});

test('ijn is forwarded only when the caller asks, and 0 means the first page', async () => {
    const { searcher, calls } = makeSearcher([makeEntry(1)]);
    const { fetchImage } = makeFetchImage();

    const first = await collectImages({ q: 'paged', ijn: 0, searcher, fetchImage });
    assert.equal(calls[0].ijn, 0);
    assert.equal(first.page, 0);

    await collectImages({ q: 'paged', ijn: 2, searcher, fetchImage });
    assert.equal(calls[1].ijn, 2);

    await assert.rejects(
        collectImages({ q: 'paged', ijn: -1, searcher, fetchImage }),
        /ijn must be a non-negative integer/,
    );
});

// ---------------------------------------------------------------------------
// buildTbs: only README-documented tokens may be emitted
// ---------------------------------------------------------------------------

test('buildTbs returns an empty string when nothing was requested', () => {
    assert.equal(buildTbs(), '');
    assert.equal(buildTbs({}), '');
});

test('buildTbs maps the size vocabulary', () => {
    assert.equal(buildTbs({ size: 'large' }), 'isz:l');
    assert.equal(buildTbs({ size: 'medium' }), 'isz:m');
    assert.equal(buildTbs({ size: 'icon' }), 'isz:i');
    assert.throws(() => buildTbs({ size: 'huge' }), /unknown size/);
});

test('buildTbs maps a dimension floor to the largest documented code that still fits', () => {
    assert.equal(buildTbs({ minWidth: 400, minHeight: 300 }), 'isz:lt,islt:qsvga');
    assert.equal(buildTbs({ minWidth: 1600, minHeight: 1200 }), 'isz:lt,islt:2mp');
    assert.equal(buildTbs({ minWidth: 2272, minHeight: 1704 }), 'isz:lt,islt:4mp');
    // 1500 wide: 2mp (1600) would over-filter, so xga is the honest largest fit.
    assert.equal(buildTbs({ minWidth: 1500, minHeight: 1000 }), 'isz:lt,islt:xga');
    // Below the smallest documented floor there is no valid token.
    assert.equal(buildTbs({ minWidth: 100 }), '');
    assert.throws(() => buildTbs({ minWidth: 0 }), /minWidth/);
    assert.equal(SIZE_FLOORS.length, 6);
});

test('buildTbs maps exact sizes and refuses conflicting size inputs', () => {
    assert.equal(buildTbs({ exactWidth: 1000, exactHeight: 1000 }), 'isz:ex,iszw:1000,iszh:1000');
    assert.throws(() => buildTbs({ exactWidth: 1000, exactHeight: 1000, size: 'large' }), /cannot be combined/);
    assert.throws(() => buildTbs({ exactWidth: 1000, minWidth: 100 }), /cannot be combined/);
    assert.throws(() => buildTbs({ exactWidth: 1000 }), /exactHeight/);
});

test('buildTbs maps colour and type vocabulary and rejects unknown values loudly', () => {
    assert.equal(buildTbs({ color: 'color' }), 'ic:color');
    assert.equal(buildTbs({ color: 'gray' }), 'ic:gray');
    assert.equal(buildTbs({ color: 'specific', colorName: 'red' }), 'ic:specific,isc:red');
    assert.equal(buildTbs({ color: 'teal' }), 'ic:specific,isc:teal', 'bare colour name is sugar');
    assert.throws(() => buildTbs({ color: 'specific' }), /requires a colorName/);
    assert.throws(() => buildTbs({ colorName: 'red' }), /requires color/);
    assert.throws(() => buildTbs({ color: 'infrared' }), /unknown color/);
    assert.throws(() => buildTbs({ color: 'specific', colorName: 'mauve' }), /unknown colorName/);

    assert.equal(buildTbs({ type: 'photo' }), 'itp:photo');
    assert.throws(() => buildTbs({ type: 'drawing' }), /unknown type/);
});

test('buildTbs joins documented filters with commas in a stable order', () => {
    assert.equal(
        buildTbs({ size: 'large', color: 'gray', type: 'photo' }),
        'isz:l,ic:gray,itp:photo',
    );
    assert.equal(
        buildTbs({ minWidth: 640, minHeight: 480, color: 'specific', colorName: 'blue', type: 'clipart' }),
        'isz:lt,islt:vga,ic:specific,isc:blue,itp:clipart',
    );
});

// ---------------------------------------------------------------------------
// defaultFetchImage: injected fetch, no real network
// ---------------------------------------------------------------------------

function fakeResponse({ status = 200, contentType = 'image/png', body = PNG_HEADER, ok } = {}) {
    return {
        ok: ok ?? (status >= 200 && status < 300),
        status,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
        arrayBuffer: async () => body.buffer,
    };
}

test('defaultFetchImage accepts a 2xx response whose bytes carry an image signature', async () => {
    const fetchImpl = async () => fakeResponse();
    const result = await defaultFetchImage('https://x/a.png', { fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.detectedMimeType, 'image/png');
    assert.equal(result.byteLength, PNG_HEADER.byteLength);
});

test('defaultFetchImage fails on non-2xx, timeout and generic network errors', async () => {
    const status = await defaultFetchImage('https://x/a.png', {
        fetchImpl: async () => fakeResponse({ status: 404, contentType: 'text/html', body: new Uint8Array([1, 2, 3]) }),
    });
    assert.deepEqual([status.ok, status.reason, status.status], [false, 'http-status', 404]);

    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timeout = await defaultFetchImage('https://x/a.png', { fetchImpl: async () => { throw aborted; } });
    assert.deepEqual([timeout.ok, timeout.reason], [false, 'timeout']);

    const network = await defaultFetchImage('https://x/a.png', {
        fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    });
    assert.deepEqual([network.ok, network.reason], [false, 'network-error']);
});

test('defaultFetchImage rejects a 2xx payload that is not an image', async () => {
    const html = new TextEncoder().encode('<html><body>hotlink blocked</body></html>');

    const wrongHeader = await defaultFetchImage('https://x/a', {
        fetchImpl: async () => fakeResponse({ contentType: 'text/html; charset=utf-8', body: html }),
    });
    assert.equal(wrongHeader.ok, false);
    assert.equal(wrongHeader.reason, 'not-image-content-type');

    // A lying image/* header cannot save non-image bytes.
    const wrongBytes = await defaultFetchImage('https://x/b', {
        fetchImpl: async () => fakeResponse({ contentType: 'image/jpeg', body: html }),
    });
    assert.equal(wrongBytes.ok, false);
    assert.equal(wrongBytes.reason, 'not-image-content');
});

test('defaultFetchImage recognises jpeg, gif and webp signatures', async () => {
    const cases = [
        { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]) },
        { mime: 'image/gif', bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) },
        {
            mime: 'image/webp',
            bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
        },
    ];
    for (const { mime, bytes } of cases) {
        const result = await defaultFetchImage('https://x/a', {
            fetchImpl: async () => fakeResponse({ contentType: mime, body: bytes }),
        });
        assert.equal(result.ok, true, `${mime} should pass`);
        assert.equal(result.detectedMimeType, mime);
    }

    // RIFF without the WEBP brand (e.g. WAV) is not an image despite the shared prefix.
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const rejected = await defaultFetchImage('https://x/a', {
        fetchImpl: async () => fakeResponse({ contentType: 'audio/wav', body: wav }),
    });
    assert.equal(rejected.ok, false);
});

// ---------------------------------------------------------------------------
// createHttpSearcher: JSON-RPC framing with an injected fetch, still no network
// ---------------------------------------------------------------------------

function rpcEnvelope(id, payload) {
    return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify({ json: payload }) }] },
    };
}

function makeRpcFetch({ body, sse = false, status = 200 }) {
    const requests = [];
    const fetchImpl = async (endpoint, init) => {
        requests.push({ endpoint, init });
        // A real server echoes the request id; mirror that so SSE id matching works.
        const echoed = { ...body, id: JSON.parse(init.body).id };
        const text = sse ? `event: message\ndata: ${JSON.stringify(echoed)}\n\n` : JSON.stringify(echoed);
        return { ok: status === 200, status, text: async () => text };
    };
    return { fetchImpl, requests };
}

test('createHttpSearcher sends the documented tool call and parses a plain JSON body', async () => {
    const payload = { imagesResults: [makeEntry(1)] };
    const { fetchImpl, requests } = makeRpcFetch({ body: rpcEnvelope(1, payload) });
    const searcher = createHttpSearcher({ apiKey: 'test-key', fetchImpl });

    const result = await searcher({ q: 'skyline', tbs: 'ic:gray', ijn: 0 });
    assert.deepEqual(result, payload);

    const { endpoint, init } = requests[0];
    assert.match(endpoint, /mcp\.hasdata\.com/);
    assert.equal(init.headers['x-api-key'], 'test-key');
    const rpc = JSON.parse(init.body);
    assert.equal(rpc.method, 'tools/call');
    assert.equal(rpc.params.name, 'hasdata_google_images_images_getImageSearchResults');
    assert.deepEqual(rpc.params.arguments, { q: 'skyline', tbs: 'ic:gray', ijn: 0 });
});

test('createHttpSearcher parses an SSE body and omits empty tbs and absent ijn', async () => {
    const payload = { imagesResults: [] };
    const { fetchImpl, requests } = makeRpcFetch({ body: rpcEnvelope(1, payload), sse: true });
    const searcher = createHttpSearcher({ apiKey: 'test-key', fetchImpl });

    const result = await searcher({ q: 'skyline', tbs: '' });
    assert.deepEqual(result, payload);
    assert.deepEqual(JSON.parse(requests[0].init.body).params.arguments, { q: 'skyline' });
});

test('createHttpSearcher fails loudly on missing keys, HTTP errors and JSON-RPC errors', async () => {
    const noKey = createHttpSearcher({ apiKey: undefined, fetchImpl: async () => { throw new Error('should not be called'); } });
    await assert.rejects(noKey({ q: 'x' }), /HASDATA_API_KEY/);

    const httpError = makeRpcFetch({ body: {}, status: 500 });
    await assert.rejects(createHttpSearcher({ apiKey: 'k', fetchImpl: httpError.fetchImpl })({ q: 'x' }), /HTTP 500/);

    const rpcError = makeRpcFetch({ body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } } });
    await assert.rejects(createHttpSearcher({ apiKey: 'k', fetchImpl: rpcError.fetchImpl })({ q: 'x' }), /boom/);
});

test('collectImages rejects bad input before any side effect', async () => {
    const { searcher } = makeSearcher([]);
    const { fetchImage } = makeFetchImage();
    await assert.rejects(collectImages({ searcher, fetchImage }), /q .* required/);
    await assert.rejects(collectImages({ q: 'x', target: 0, searcher, fetchImage }), /target/);
});
