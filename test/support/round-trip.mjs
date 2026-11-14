// Round-trip helper: the two-call flow Google Flights requires, in one async function.
//
// A round trip is not one search. The first call returns outbound itineraries, each carrying a
// `departureToken`; the matching return flights only come back from a second call that passes
// one of those tokens. This module performs both calls, one selected outbound at a time, and
// returns a record per option instead of throwing on the first failure, so a caller can tell a
// failed query from a route that simply has no flights.
//
// There is deliberately no CLI here. Tests call the exported function with an injected
// `request` (any fetch-compatible function) and never touch the network. Production callers
// omit `request` and the module posts JSON-RPC to the real endpoint below with `x-api-key` on
// both requests. Fake responses in the tests must not be presented as production results.
//
// Run the offline checks with:
//   node --test test/round-trip.test.mjs

export const ROUND_TRIP_ENDPOINT = 'https://mcp.hasdata.com/mcp?apis=google_travel_flights';
export const ROUND_TRIP_TOOL = 'hasdata_google_travel_flights_getGoogleFlights';

// Failure categories are stable values, so callers can branch on them without matching prose.
export const FAILURE_CATEGORY = Object.freeze({
    AUTH: 'auth', // 401/403 or an "Unauthorized" tool result
    VALIDATION: 'validation', // schema/argument rejection: -32602, 422, or an "Input validation error" text
    RATE_LIMIT: 'rate_limit', // 429 / concurrency_limit, retried until maxAttempts
    OTHER: 'other', // anything else: transport, unparseable body, upstream status error
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_LIMIT_RE = /concurrency_limit|rate[_ -]?limit|too many requests|\b429\b/i;
const AUTH_RE = /\b401\b|\b403\b|unauthori[sz]ed|forbidden/i;
const VALIDATION_RE =
    /-32602|input validation|validation error|requiredWhen|mutuallyExclusive|unprocessable|\b422\b|bad request|invalid (airport|parameter|argument|field|value)|hasdata api error: 40[04]/i;

const isObject = (value) => value !== null && typeof value === 'object';

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function failure(category, message, { attempts = 1, httpStatus = null } = {}) {
    const error = new Error(message);
    error.category = category;
    error.attempts = attempts;
    error.httpStatus = httpStatus;
    return error;
}

function failureRecord(error) {
    return {
        category: error.category ?? FAILURE_CATEGORY.OTHER,
        message: error.message,
        attempts: error.attempts ?? 1,
        httpStatus: error.httpStatus ?? null,
    };
}

// Classify an error response from everything we have: the HTTP status, JSON-RPC code and body.
// Status wins over prose, because a 401 body can mention anything. A bare 400 is not treated as
// a schema rejection: the README documents that a bad airport code comes back as 400 with
// requestMetadata.status error, which is an upstream answer rather than a broken argument.
function classify({ httpStatus = 0, text = '', rpcCode = null } = {}) {
    if (httpStatus === 401 || httpStatus === 403) return FAILURE_CATEGORY.AUTH;
    if (httpStatus === 429) return FAILURE_CATEGORY.RATE_LIMIT;
    if (rpcCode === -32602 || rpcCode === -32600) return FAILURE_CATEGORY.VALIDATION;
    if (httpStatus === 422) return FAILURE_CATEGORY.VALIDATION;
    const body = String(text ?? '');
    if (AUTH_RE.test(body)) return FAILURE_CATEGORY.AUTH;
    if (RATE_LIMIT_RE.test(body)) return FAILURE_CATEGORY.RATE_LIMIT;
    if (VALIDATION_RE.test(body)) return FAILURE_CATEGORY.VALIDATION;
    return FAILURE_CATEGORY.OTHER;
}

// A streamable-HTTP body is plain JSON or server-sent events. One SSE event can span several
// data: lines and a response can carry progress notifications, so collect every message and
// pick the one with our request id rather than trusting the first data: line.
function parseRpc(raw, id) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new Error('empty response body');

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return parsed;
        const match = parsed.find((message) => message && message.id === id);
        if (!match) throw new Error(`no JSON-RPC message with id ${id}`);
        return match;
    }

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
            // Keep-alives and partial events are not our response.
        }
    }
    const match = messages.find((message) => message && message.id === id);
    if (!match) throw new Error(`no JSON-RPC message with id ${id} in ${trimmed.slice(0, 200)}`);
    return match;
}

function contentText(result) {
    if (typeof result?.content === 'string') return result.content;
    if (!Array.isArray(result?.content)) return '';
    return result.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}

// A tools/call result carries one text block, and that text is itself JSON shaped like
// { url, status, text, json }, with the scraped data under `json`. Accept a direct payload too,
// since a future server revision may drop the envelope.
function extractPayload(status, raw, id) {
    let message;
    try {
        message = parseRpc(raw, id);
    } catch (error) {
        throw failure(classify({ httpStatus: status, text: raw }), `unreadable JSON-RPC response: ${error.message}`, {
            httpStatus: status,
        });
    }

    if (isObject(message) && message.error) {
        const detail = JSON.stringify(message.error);
        throw failure(
            classify({ httpStatus: status, text: detail, rpcCode: message.error.code }),
            message.error.message || detail,
            { httpStatus: status }
        );
    }
    if (!isObject(message) || !isObject(message.result)) {
        throw failure(FAILURE_CATEGORY.OTHER, 'JSON-RPC response carried no result', { httpStatus: status });
    }

    const result = message.result;
    const text = contentText(result).trim();
    if (result.isError) {
        throw failure(classify({ httpStatus: status, text }), text || 'the tool call reported isError', {
            httpStatus: status,
        });
    }

    let envelope = null;
    if (text) {
        try {
            envelope = JSON.parse(text);
        } catch {
            // An error can arrive as plain text even with isError unset.
            throw failure(
                classify({ httpStatus: status, text }),
                /hasdata api error|mcp error/i.test(text) ? text : `tool output was not JSON: ${text.slice(0, 200)}`,
                { httpStatus: status }
            );
        }
    }

    if (isObject(envelope) && envelope.status === 'error') {
        const detail = `${envelope.text ?? ''} ${JSON.stringify(envelope)}`;
        throw failure(classify({ httpStatus: status, text: detail }), envelope.text || 'the tool reported an error', {
            httpStatus: status,
        });
    }

    const payload = isObject(envelope) && 'json' in envelope ? envelope.json : (envelope ?? result.structuredContent ?? null);
    if (isObject(payload)) {
        const meta = payload.requestMetadata;
        if (meta?.status === 'error' || payload.status === 'error') {
            const detail = [meta?.message, meta?.error, payload.message, payload.text]
                .filter(Boolean)
                .join(' ');
            throw failure(
                classify({ httpStatus: status, text: `${detail} ${JSON.stringify(meta ?? {})}` }),
                detail || 'the upstream search reported an error',
                { httpStatus: status }
            );
        }
    }
    return payload;
}

// Results arrive as bestFlights / otherFlights. Some shapes put the return leg under its own
// key, so accept those too and keep the server's order (best first). If none of the known
// keys carries anything, look one level down for the same names, because a return search may
// nest them under a wrapper the payload does not spell out.
function itinerariesFrom(payload) {
    if (Array.isArray(payload)) return payload.filter(isObject);
    if (!isObject(payload)) return [];

    const names = ['bestFlights', 'otherFlights', 'returnFlights', 'returningFlights', 'returningOptions', 'flights'];
    const found = [];
    const seen = new Set();
    const collect = (source, keys) => {
        for (const key of keys) {
            if (!Array.isArray(source[key])) continue;
            for (const itinerary of source[key]) {
                if (!isObject(itinerary) || seen.has(itinerary)) continue;
                seen.add(itinerary);
                found.push(itinerary);
            }
        }
    };

    collect(payload, names);
    if (!found.length) {
        // Only the return-specific names, never bestFlights/otherFlights one level down: an
        // echoed outbound search must not be mistaken for a set of return flights.
        const nested = ['returnFlights', 'returningFlights', 'returningOptions'];
        for (const value of Object.values(payload)) {
            if (isObject(value)) collect(value, nested);
        }
    }
    return found;
}

function sumLegDurations(legs) {
    let total = null;
    for (const leg of legs) {
        const duration = numberOrNull(leg.duration);
        if (duration === null) continue;
        total = (total ?? 0) + duration;
    }
    return total;
}

// Compact return-leg summary. Airline and flight number cover every leg, so a connection does
// not look like a nonstop operated by whichever airline flew the first segment.
function summarizeItinerary(itinerary, payload) {
    const legs = Array.isArray(itinerary.flights) ? itinerary.flights.filter(isObject) : [];
    const airlines = [...new Set(legs.map((leg) => leg.airline).filter(Boolean))];
    const flightNumbers = legs.map((leg) => leg.flightNumber).filter(Boolean);
    const first = legs[0];
    const last = legs[legs.length - 1];

    return {
        airline: airlines.length ? airlines.join(' + ') : (itinerary.airline ?? null),
        flightNumber: flightNumbers.length ? flightNumbers.join(' / ') : (itinerary.flightNumber ?? null),
        departureTime: first?.departureAirport?.time ?? first?.departureTime ?? itinerary.departureTime ?? null,
        arrivalTime: last?.arrivalAirport?.time ?? last?.arrivalTime ?? itinerary.arrivalTime ?? null,
        totalDuration: numberOrNull(itinerary.totalDuration) ?? sumLegDurations(legs),
        price: numberOrNull(itinerary.price),
        currency: itinerary.currency ?? payload?.currency ?? null,
        stops: legs.length ? Math.max(0, legs.length - 1) : null,
    };
}

// Positional form: (request, apiKey, origin, destination, outboundDate, returnDate,
// maxOutboundOptions, overrides?). A seventh plain number is the option count; a seventh
// object carries the tuning knobs instead.
function normalizePositional(request, rest) {
    const [apiKey, origin, destination, outboundDate, returnDate, seventh, eighth] = rest;
    const options = { request, apiKey, origin, destination, outboundDate, returnDate };
    if (typeof seventh === 'number') options.maxOutboundOptions = seventh;
    else if (isObject(seventh)) Object.assign(options, seventh);
    if (isObject(eighth)) Object.assign(options, eighth);
    return options;
}

/**
 * Price a round trip end to end: one outbound search, then one return search per chosen option.
 *
 * Call it with a single options object, or positionally as
 * `(request, apiKey, origin, destination, outboundDate, returnDate, maxOutboundOptions)`.
 * A positional caller may pass a final object to tune the knobs below.
 *
 * @param {Function|object} [optionsOrRequest=fetch] Options object, or a fetch-compatible
 *   request function `(url, init) => Response`. Inject one in tests; omit it to talk to
 *   HasData.
 * @param {string} [apiKey] HasData key, sent as x-api-key on both requests.
 * @param {string} [origin] IATA code or kgmid.
 * @param {string} [destination] IATA code or kgmid.
 * @param {string} [outboundDate] YYYY-MM-DD.
 * @param {string} [returnDate] YYYY-MM-DD.
 * @param {number} [maxOutboundOptions=3] How many outbound options to price returns for.
 *   Positional callers pass this seventh; object callers may also set it.
 * @param {object} [overrides] Ignored for object callers. Positional callers only:
 *   `{ endpoint, timeoutMs, maxAttempts, baseDelayMs, sleep }`.
 * @returns {Promise<object>} A record with `status` of `ok`, `empty`, `partial` or `failed`,
 *   an `outbound` section summarising the first search, and one `options` entry per priced
 *   outbound: `{ departureToken, outboundPrice, outboundTotalDuration, status, returnOptionCount,
 *   returnSummary, failure }`. `failure` is `{ category, message, attempts, httpStatus }`, so a
 *   failed call is never confused with a route that simply has no matching return.
 */
export async function fetchRoundTripOptions(optionsOrRequest = globalThis.fetch, ...rest) {
    const options =
        typeof optionsOrRequest === 'function'
            ? normalizePositional(optionsOrRequest, rest)
            : (optionsOrRequest ?? {});

    const {
        request = globalThis.fetch,
        apiKey,
        origin,
        destination,
        outboundDate,
        returnDate,
        maxOutboundOptions = 3,
        endpoint = ROUND_TRIP_ENDPOINT,
        timeoutMs = 30_000,
        maxAttempts = 4,
        baseDelayMs = 1_000,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    } = options;
    if (typeof request !== 'function') throw new TypeError('request must be a fetch-compatible function');
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('apiKey must be a non-empty string');
    if (typeof origin !== 'string' || !origin.trim()) throw new TypeError('origin must be a non-empty string');
    if (typeof destination !== 'string' || !destination.trim()) throw new TypeError('destination must be a non-empty string');
    if (!DATE_RE.test(outboundDate ?? '')) throw new TypeError('outboundDate must be YYYY-MM-DD');
    if (!DATE_RE.test(returnDate ?? '')) throw new TypeError('returnDate must be YYYY-MM-DD');
    if (returnDate < outboundDate) throw new TypeError('returnDate must not be before outboundDate');
    if (!Number.isInteger(maxOutboundOptions) || maxOutboundOptions < 1) {
        throw new TypeError('maxOutboundOptions must be an integer of at least 1');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be at least 1');

    const baseArguments = {
        departureId: origin,
        arrivalId: destination,
        outboundDate,
        returnDate,
        type: 'roundTrip',
    };

    let nextId = 1;

    async function callTool(args) {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const id = nextId++;
            const init = {
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
                    params: { name: ROUND_TRIP_TOOL, arguments: args },
                }),
            };
            if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);

            let status = 0;
            let raw = '';
            try {
                const response = await request(endpoint, init);
                status = Number(response?.status ?? 0);
                raw = typeof response?.text === 'function' ? await response.text() : String(response?.body ?? '');
            } catch (error) {
                throw failure(FAILURE_CATEGORY.OTHER, `request failed: ${error.message}`, { httpStatus: status });
            }

            try {
                return extractPayload(status, raw, id);
            } catch (error) {
                error.attempts = attempt;
                error.httpStatus = error.httpStatus ?? (status || null);
                lastError = error;
                // Low concurrency plans answer 429 straight away rather than queueing. Wait
                // longer each time, then record the rate limit instead of hammering the key.
                if (error.category === FAILURE_CATEGORY.RATE_LIMIT && attempt < maxAttempts) {
                    await sleep(baseDelayMs * 2 ** (attempt - 1));
                    continue;
                }
                throw error;
            }
        }
        throw lastError;
    }

    const result = {
        endpoint,
        query: {
            origin,
            destination,
            outboundDate,
            returnDate,
            type: 'roundTrip',
            maxOutboundOptions,
        },
        status: 'ok',
        outbound: {
            status: 'ok',
            availableOptions: 0,
            failure: null,
        },
        options: [],
    };

    let outboundPayload;
    try {
        outboundPayload = await callTool(baseArguments);
    } catch (error) {
        result.status = 'failed';
        result.outbound.status = 'failed';
        result.outbound.failure = failureRecord(error);
        return result;
    }

    const itineraries = itinerariesFrom(outboundPayload);
    result.outbound.availableOptions = itineraries.length;

    const selected = [];
    const seenTokens = new Set();
    for (const itinerary of itineraries) {
        const token = itinerary.departureToken;
        if (typeof token !== 'string' || !token || seenTokens.has(token)) continue;
        seenTokens.add(token);
        selected.push({
            departureToken: token,
            outboundPrice: numberOrNull(itinerary.price),
            outboundTotalDuration: numberOrNull(itinerary.totalDuration) ?? sumLegDurations(
                Array.isArray(itinerary.flights) ? itinerary.flights.filter(isObject) : []
            ),
        });
        if (selected.length >= maxOutboundOptions) break;
    }

    if (!itineraries.length) {
        // A successful search with empty arrays is a real answer, not a failure.
        result.status = 'empty';
        result.outbound.status = 'empty';
        return result;
    }
    if (!selected.length) {
        result.status = 'failed';
        result.outbound.status = 'failed';
        result.outbound.failure = failureRecord(
            failure(FAILURE_CATEGORY.OTHER, 'the outbound results carried no departureToken, so no return can be fetched')
        );
        return result;
    }

    // Sequential by design: the free plan allows few concurrent requests, and a retried
    // rate-limited call should not fight the other lookups for a slot.
    for (const option of selected) {
        const record = {
            departureToken: option.departureToken,
            outboundPrice: option.outboundPrice,
            outboundTotalDuration: option.outboundTotalDuration,
            status: 'empty',
            returnOptionCount: 0,
            returnSummary: null,
            failure: null,
        };
        try {
            const payload = await callTool({ ...baseArguments, departureToken: option.departureToken });
            const returns = itinerariesFrom(payload);
            record.returnOptionCount = returns.length;
            if (returns.length) {
                record.status = 'ok';
                record.returnSummary = summarizeItinerary(returns[0], payload);
            }
        } catch (error) {
            // One broken option must not discard the others.
            record.status = 'failed';
            record.failure = failureRecord(error);
        }
        result.options.push(record);
    }

    const failed = result.options.filter((option) => option.status === 'failed').length;
    if (failed === result.options.length) result.status = 'failed';
    else if (failed > 0) result.status = 'partial';
    return result;
}
