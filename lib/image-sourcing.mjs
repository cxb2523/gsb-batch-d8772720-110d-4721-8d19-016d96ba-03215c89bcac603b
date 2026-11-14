// Reusable Google Images sourcing pipeline, implementing commands/image-sourcing.md as code
// rather than as instructions for a human.
//
// Two failure modes shape everything here:
//
//   1. tbs (Google's filter string) fails quietly. An unrecognised value is ignored rather than
//      rejected, so a filter that did nothing is indistinguishable from one that matched
//      everything. buildTbs() therefore only emits tokens documented in the README and throws on
//      vocabulary it does not know, and collectImages() verifies originalWidth/originalHeight
//      against the requested floor and flags the filter as possibly ignored instead of
//      pretending it held.
//   2. `original` is a third-party URL and can be dead, hotlink-blocked, slow, or answered with
//      an HTML error page. Every original is fetched defensively; anything that is not a 2xx
//      image response is dropped and counted, then the same batch fills the vacancy. There is no
//      automatic paging: ijn is only ever forwarded when the caller asked for it.
//
// Every side effect is injectable. Pass `searcher` and `fetchImage` to run with no network, no
// API key and no timers; the defaults talk to the hosted HasData MCP server and fetch originals
// over HTTP(S).

export const TOOL_NAME = 'hasdata_google_images_images_getImageSearchResults';
export const DEFAULT_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=google_images';
export const DEFAULT_TARGET = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;

// --- tbs vocabulary, kept identical to the README table. Do not invent tokens: Google silently
// ignores an unrecognised one.

// isz:l / isz:m / isz:i.
export const SIZE_FILTERS = Object.freeze({
    large: 'isz:l',
    medium: 'isz:m',
    icon: 'isz:i',
});

// "Larger than" floors (isz:lt,islt:<code>), smallest first, with the dimensions Google
// documents for each code. A code only qualifies for a requested floor when BOTH of its
// documented dimensions stay at or below the request: picking a bigger floor would over-filter.
export const SIZE_FLOORS = Object.freeze([
    Object.freeze({ code: 'qsvga', width: 400, height: 300 }),
    Object.freeze({ code: 'vga', width: 640, height: 480 }),
    Object.freeze({ code: 'svga', width: 800, height: 600 }),
    Object.freeze({ code: 'xga', width: 1024, height: 768 }),
    Object.freeze({ code: '2mp', width: 1600, height: 1200 }),
    Object.freeze({ code: '4mp', width: 2272, height: 1704 }),
]);

export const COLOR_FILTERS = Object.freeze({
    color: 'ic:color',
    gray: 'ic:gray',
});

// The colour names Google accepts behind ic:specific,isc:<name>.
export const SPECIFIC_COLORS = Object.freeze(
    new Set(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'white', 'gray', 'black', 'brown']),
);

export const TYPE_FILTERS = Object.freeze({
    photo: 'itp:photo',
    face: 'itp:face',
    clipart: 'itp:clipart',
    lineart: 'itp:lineart',
    animated: 'itp:animated',
});

function positiveInt(name, value) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
    }
    return value;
}

// Largest documented floor that does not exceed the requested minimum on either axis.
function pickFloor(minWidth, minHeight) {
    let chosen = null;
    for (const floor of SIZE_FLOORS) {
        const widthOk = minWidth == null || floor.width <= minWidth;
        const heightOk = minHeight == null || floor.height <= minHeight;
        if (widthOk && heightOk) chosen = floor; // ascending order: the last qualifying is largest
    }
    return chosen;
}

/**
 * Assemble Google's tbs filter string from structured inputs using only the README-documented
 * syntax. Returns '' when no filter was requested, so callers can tell "no filter" apart from
 * "filter assembled". Throws RangeError on unknown vocabulary instead of emitting a token Google
 * would silently ignore.
 *
 * @param {object} [opts]
 * @param {'large'|'medium'|'icon'} [opts.size] isz:l / isz:m / isz:i
 * @param {number} [opts.minWidth] minimum original width in pixels; mapped to the largest
 *   documented isz:lt floor that fits
 * @param {number} [opts.minHeight] minimum original height in pixels
 * @param {number} [opts.exactWidth] exact width, paired with exactHeight (isz:ex)
 * @param {number} [opts.exactHeight] exact height, paired with exactWidth
 * @param {'color'|'gray'|'specific'|string} [opts.color] 'color'/'gray' map straight to ic:*,
 *   'specific' requires colorName, and a bare colour name (e.g. 'red') is sugar for
 *   ic:specific,isc:red
 * @param {string} [opts.colorName] colour name for ic:specific
 * @param {'photo'|'face'|'clipart'|'lineart'|'animated'} [opts.type] itp:*
 * @returns {string} the comma-joined tbs string, or '' when nothing was requested
 */
export function buildTbs(opts = {}) {
    const { size, minWidth, minHeight, exactWidth, exactHeight, color, colorName, type } = opts;
    const tokens = [];

    const hasExact = exactWidth != null || exactHeight != null;
    const hasFloor = minWidth != null || minHeight != null;
    if (hasExact && (size || hasFloor)) {
        throw new RangeError('exact size cannot be combined with size or minWidth/minHeight');
    }

    if (hasExact) {
        const w = positiveInt('exactWidth', exactWidth);
        const h = positiveInt('exactHeight', exactHeight);
        tokens.push(`isz:ex,iszw:${w},iszh:${h}`);
    } else if (size) {
        if (!Object.prototype.hasOwnProperty.call(SIZE_FILTERS, size)) {
            throw new RangeError(`unknown size '${size}', expected one of: ${Object.keys(SIZE_FILTERS).join(', ')}`);
        }
        tokens.push(SIZE_FILTERS[size]);
    } else if (hasFloor) {
        if (minWidth != null) positiveInt('minWidth', minWidth);
        if (minHeight != null) positiveInt('minHeight', minHeight);
        const floor = pickFloor(minWidth, minHeight);
        // Below the smallest documented floor there is no valid token. Emitting a bigger floor
        // would narrow results beyond the request, so emit nothing; collectImages still verifies
        // the returned dimensions directly.
        if (floor) tokens.push(`isz:lt,islt:${floor.code}`);
    }

    if (color) {
        let specificName = null;
        if (color === 'specific') {
            if (!colorName) throw new RangeError("color 'specific' requires a colorName");
            specificName = colorName;
        } else if (Object.prototype.hasOwnProperty.call(COLOR_FILTERS, color)) {
            if (colorName) throw new RangeError('colorName only applies to color "specific"');
            tokens.push(COLOR_FILTERS[color]);
        } else if (SPECIFIC_COLORS.has(color)) {
            specificName = color; // sugar: buildTbs({ color: 'red' })
        } else {
            throw new RangeError(
                `unknown color '${color}', expected 'color', 'gray', 'specific' + colorName, `
                    + `or one of: ${[...SPECIFIC_COLORS].join(', ')}`,
            );
        }
        if (specificName) {
            if (!SPECIFIC_COLORS.has(specificName)) {
                throw new RangeError(`unknown colorName '${specificName}', expected one of: ${[...SPECIFIC_COLORS].join(', ')}`);
            }
            tokens.push(`ic:specific,isc:${specificName}`);
        }
    } else if (colorName) {
        throw new RangeError('colorName requires color "specific"');
    }

    if (type) {
        if (!Object.prototype.hasOwnProperty.call(TYPE_FILTERS, type)) {
            throw new RangeError(`unknown type '${type}', expected one of: ${Object.keys(TYPE_FILTERS).join(', ')}`);
        }
        tokens.push(TYPE_FILTERS[type]);
    }

    return tokens.join(',');
}

// Magic bytes for the image formats Google Images typically returns. A Content-Type header is
// trustable only as a negative signal; a hotlink-blocked 200 page often claims image/* anyway.
const IMAGE_SIGNATURES = Object.freeze([
    Object.freeze({ mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] }),
    Object.freeze({ mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }),
    Object.freeze({ mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }),
    Object.freeze({ mime: 'image/bmp', bytes: [0x42, 0x4d] }),
    Object.freeze({
        mime: 'image/tiff',
        bytes: [
            [0x49, 0x49, 0x2a, 0x00],
            [0x4d, 0x4d, 0x00, 0x2a],
        ],
    }),
    Object.freeze({ mime: 'image/x-icon', bytes: [0x00, 0x00, 0x01, 0x00] }),
    Object.freeze({ mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }), // RIFF; WEBP confirmed at offset 8
]);

function sniffImage(bytes) {
    const startsWith = (sig) => sig.every((b, i) => bytes[i] === b);
    for (const sig of IMAGE_SIGNATURES) {
        const variants = Array.isArray(sig.bytes[0]) ? sig.bytes : [sig.bytes];
        if (!variants.some(startsWith)) continue;
        if (sig.mime === 'image/webp') {
            // RIFF alone also covers WAV/AVI; require the WEBP brand at bytes 8..11.
            const webp =
                bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
            if (webp) return sig.mime;
            continue;
        }
        return sig.mime;
    }
    return null;
}

// AbortSignal.any only landed in Node 18.17; keep the engines contract honest with a fallback.
function combineSignals(external, timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!external) return timeoutSignal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, timeoutSignal]);
    const controller = new AbortController();
    const abort = () => controller.abort(external.aborted ? external.reason : timeoutSignal.reason);
    if (external.aborted || timeoutSignal.aborted) abort();
    else {
        external.addEventListener('abort', abort, { once: true });
        timeoutSignal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}

/**
 * Default original-image fetcher. A fetch counts as failed on a non-2xx status, a timeout, any
 * network error, a non-image Content-Type, or bytes that do not start with an image signature.
 * Never throws: every failure comes back as { ok: false, reason, ... }.
 *
 * @param {string} url the `original` URL to fetch
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {AbortSignal} [opts.signal] external cancellation, combined with the timeout
 * @param {typeof fetch} [opts.fetchImpl] fetch implementation to use (injection point)
 * @returns {Promise<object>} { ok, status?, contentType?, byteLength?, bytes?, detectedMimeType?, reason?, error? }
 */
export async function defaultFetchImage(url, opts = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, fetchImpl = fetch } = opts;
    let res;
    try {
        res = await fetchImpl(url, {
            signal: combineSignals(signal, timeoutMs),
            redirect: 'follow',
        });
    } catch (err) {
        return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network-error', error: err };
    }
    const contentType = res.headers?.get?.('content-type') ?? null;
    if (!res.ok) {
        return { ok: false, reason: 'http-status', status: res.status, contentType };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        return { ok: false, reason: 'not-image-content-type', status: res.status, contentType, byteLength: bytes.byteLength };
    }
    const detectedMimeType = sniffImage(bytes);
    if (!detectedMimeType) {
        return {
            ok: false,
            reason: 'not-image-content',
            status: res.status,
            contentType,
            byteLength: bytes.byteLength,
        };
    }
    return {
        ok: true,
        status: res.status,
        contentType: contentType ?? detectedMimeType,
        detectedMimeType,
        byteLength: bytes.byteLength,
        bytes,
    };
}

let rpcId = 0;
function nextRpcId() {
    rpcId += 1;
    return rpcId;
}

// A streamable HTTP body is either plain JSON or server-sent events, where one event can span
// several data: lines and progress notifications may precede the answer. Pick the message
// carrying our request id rather than trusting the first data: line. Mirrors the contract test.
function parseRpcMessage(raw, id) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    const messages = [];
    for (const event of trimmed.split(/\r?\n\r?\n+/)) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
            messages.push(JSON.parse(data));
        } catch {
            // A keep-alive or partial event is not our response.
        }
    }
    const match = messages.find((message) => message.id === id);
    if (!match) throw new Error(`no JSON-RPC message with id ${id} in the response: ${raw.slice(0, 300)}`);
    return match;
}

/**
 * Build the default searcher: one JSON-RPC tools/call against the hosted HasData MCP endpoint.
 * The returned function matches the searcher contract collectImages() injects:
 *   async ({ q, tbs, ijn }) => payload   // payload carries imagesResults
 * An empty tbs is omitted from the RPC arguments, and ijn is only sent when provided.
 */
export function createHttpSearcher(options = {}) {
    const {
        endpoint = DEFAULT_ENDPOINT,
        apiKey = process.env.HASDATA_API_KEY,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        fetchImpl = fetch,
    } = options;

    return async function search({ q, tbs, ijn }) {
        if (!apiKey) {
            throw new Error(
                'HASDATA_API_KEY is not set. Create a free key at https://app.hasdata.com and set HASDATA_API_KEY.',
            );
        }
        const args = { q };
        if (tbs) args.tbs = tbs;
        if (ijn != null) args.ijn = ijn;
        const id = nextRpcId();
        const res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: { name: TOOL_NAME, arguments: args },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HasData MCP call failed with HTTP ${res.status}`);
        const message = parseRpcMessage(await res.text(), id);
        if (message.error) throw new Error(`HasData MCP error: ${JSON.stringify(message.error)}`);
        const text = message.result?.content?.[0]?.text;
        if (!text) throw new Error('the tool response carried no result.content[0].text');
        const envelope = JSON.parse(text);
        return envelope.json ?? envelope;
    };
}

function toCandidate(entry, { minWidth, minHeight, hasSizeMinimum }) {
    const width = entry.originalWidth ?? null;
    const height = entry.originalHeight ?? null;
    const warnings = [];
    let sizeBelowMinimum = false;

    if (hasSizeMinimum) {
        if (width == null || height == null) {
            // No dimensions means the floor cannot be proven to hold; flag conservatively rather
            // than silently treating the filter as effective.
            sizeBelowMinimum = true;
            warnings.push(
                'originalWidth/originalHeight missing: the size floor cannot be verified, so the tbs size filter may have been ignored',
            );
        } else if ((minWidth != null && width < minWidth) || (minHeight != null && height < minHeight)) {
            sizeBelowMinimum = true;
            warnings.push(
                `dimensions ${width}x${height} are below the requested minimum `
                    + `${minWidth ?? '*'}x${minHeight ?? '*'}: the tbs size filter may have been ignored`,
            );
        }
    }

    return {
        position: entry.position ?? null,
        title: entry.title ?? null,
        source: entry.source ?? null,
        link: entry.link ?? null,
        original: entry.original ?? null,
        originalWidth: width,
        originalHeight: height,
        sizeBelowMinimum,
        warnings,
        fetch: null,
        image: null,
    };
}

/**
 * Run the full sourcing pipeline from commands/image-sourcing.md.
 *
 * One search call, no automatic paging: candidates below `target` after failures are filled from
 * the remaining entries of the same batch, and ijn is forwarded only when the caller passes it
 * (0 is the first page). Each retained candidate keeps title, source, originalWidth/Height, the
 * page link and the original URL, plus the fetched bytes. Originals that fail to load are
 * removed and counted; retained entries under the requested size floor set filterMaybeIgnored.
 *
 * @param {object} options
 * @param {string} options.q search term (required)
 * @param {number} [options.minWidth] minimum original width; drives both the tbs floor and the
 *   ignored-filter check
 * @param {number} [options.minHeight] minimum original height
 * @param {'large'|'medium'|'icon'} [options.size]
 * @param {string} [options.color]
 * @param {string} [options.colorName]
 * @param {string} [options.type]
 * @param {number} [options.exactWidth]
 * @param {number} [options.exactHeight]
 * @param {string} [options.tbs] pre-built tbs; skips buildTbs when supplied
 * @param {number} [options.ijn] page number, never sent unless provided; 0 is the first page
 * @param {number} [options.target=10] how many successfully loaded images to deliver
 * @param {(req: {q: string, tbs: string, ijn?: number}) => Promise<object>} [options.searcher]
 *   injected search call; defaults to the HasData HTTP JSON-RPC searcher
 * @param {(url: string, opts?: object) => Promise<object>} [options.fetchImage] injected image
 *   fetch; defaults to defaultFetchImage
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} see the shape assembled below
 */
export async function collectImages(options = {}) {
    const {
        q,
        minWidth,
        minHeight,
        size,
        color,
        colorName,
        type,
        exactWidth,
        exactHeight,
        tbs: tbsOverride,
        ijn,
        target = DEFAULT_TARGET,
        searcher,
        fetchImage = defaultFetchImage,
        signal,
    } = options;

    if (!q || typeof q !== 'string') throw new RangeError('q (search term) is required');
    if (!Number.isInteger(target) || target <= 0) {
        throw new RangeError(`target must be a positive integer, got ${String(target)}`);
    }
    if (ijn != null && (!Number.isInteger(ijn) || ijn < 0)) {
        throw new RangeError(`ijn must be a non-negative integer where 0 is the first page, got ${String(ijn)}`);
    }
    const resolvedSearcher = searcher ?? createHttpSearcher();
    if (typeof resolvedSearcher !== 'function') throw new RangeError('searcher must be an async function');
    if (typeof fetchImage !== 'function') throw new RangeError('fetchImage must be an async function');

    const tbs = tbsOverride
        ?? buildTbs({ size, minWidth, minHeight, exactWidth, exactHeight, color, colorName, type });
    const hasSizeMinimum = minWidth != null || minHeight != null;

    // Exactly one search call. The pipeline never pages on its own, regardless of how many
    // originals fail below.
    const payload = await resolvedSearcher({ q, tbs, ijn });
    const entries = payload?.imagesResults ?? [];

    const candidates = [];
    const dropped = [];
    const floor = { minWidth, minHeight, hasSizeMinimum };

    for (const entry of entries) {
        if (candidates.length >= target) break;
        const candidate = toCandidate(entry, floor);

        if (!candidate.original) {
            dropped.push({ ...candidate, fetch: { ok: false, reason: 'missing-original-url' } });
            continue;
        }

        let fetched;
        try {
            fetched = await fetchImage(candidate.original, { signal });
        } catch (err) {
            // A throwing fetcher is treated like any other network failure rather than aborting
            // the whole batch.
            fetched = { ok: false, reason: 'network-error', error: err };
        }
        if (!fetched || fetched.ok !== true) {
            dropped.push({ ...candidate, fetch: fetched ?? { ok: false, reason: 'network-error' } });
            continue;
        }

        candidate.fetch = {
            ok: true,
            status: fetched.status ?? null,
            contentType: fetched.contentType ?? null,
            byteLength: fetched.byteLength ?? null,
        };
        candidate.image = fetched.bytes ?? null;
        candidates.push(candidate);
    }

    return {
        query: q,
        tbs,
        filtersAssembled: tbs ? tbs.split(',') : [],
        page: ijn ?? 0,
        target,
        sizeMinimum: hasSizeMinimum ? { width: minWidth ?? null, height: minHeight ?? null } : null,
        // Set only when a retained entry actually came back under the requested floor: that is
        // the observable evidence that Google ignored the size token.
        filterMaybeIgnored: hasSizeMinimum && candidates.some((candidate) => candidate.sizeBelowMinimum),
        totalAvailable: entries.length,
        keptCount: candidates.length,
        droppedCount: dropped.length,
        candidates,
        dropped,
    };
}
