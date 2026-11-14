// Offline checks for the round-trip helper.
//
// Every test injects its own request function, so nothing here touches HasData, spends credits
// or depends on a key. The fixtures below are synthetic payloads shaped like the documented
// response; they are test data, not evidence of what the live endpoint returned.
//
// Run: node --test test/round-trip.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchRoundTripOptions, FAILURE_CATEGORY, ROUND_TRIP_TOOL } from './support/round-trip.mjs';

const QUERY = {
    apiKey: 'test-key',
    origin: 'JFK',
    destination: 'LHR',
    outboundDate: '2026-09-15',
    returnDate: '2026-09-22',
};

const FLIGHTS_A = [
    {
        departureAirport: { id: 'JFK', name: 'John F. Kennedy International Airport', time: '2026-09-22 18:30' },
        arrivalAirport: { id: 'LHR', name: 'Heathrow Airport', time: '2026-09-23 06:35' },
        duration: 425,
        airline: 'British Airways',
        flightNumber: 'BA 178',
    },
];

function outboundPayload() {
    return {
        json: {
            bestFlights: [
                {
                    price: 612,
                    totalDuration: 415,
                    flights: [
                        {
                            departureAirport: { id: 'JFK', time: '2026-09-15 08:15' },
                            arrivalAirport: { id: 'LHR', time: '2026-09-15 20:10' },
                            duration: 415,
                            airline: 'Virgin Atlantic',
                            flightNumber: 'VS 26',
                        },
                    ],
                    departureToken: 'token-cheap',
                },
                {
                    price: 688,
                    totalDuration: 400,
                    flights: [],
                    departureToken: 'token-fast',
                },
                {
                    price: 705,
                    totalDuration: 430,
                    flights: [],
                    departureToken: 'token-third',
                },
            ],
            otherFlights: [],
            requestMetadata: { id: 'req-1', status: 'ok' },
        },
    };
}

function returnPayload(options = []) {
    return {
        json: {
            bestFlights: options,
            otherFlights: [],
            requestMetadata: { id: 'req-return', status: 'ok' },
        },
    };
}

// The MCP layer answers 200 and puts failures inside result.isError with the reason as text.
function toolMessage(content, { id, isError = false } = {}) {
    return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }], isError },
    };
}

function jsonResponse(body, status = 200) {
    return {
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

// Records every request and replays a scripted list of responses per call. A handler may look
// at the request body to decide what to answer, which is how the return-leg cases are built.
function fakeRequest(handler) {
    const calls = [];
    const request = async (url, init) => {
        const body = JSON.parse(init.body);
        const call = { url, init, body, headers: init.headers };
        calls.push(call);
        return handler(call, calls.length);
    };
    return { request, calls };
}

const isReturnCall = (body) => Boolean(body?.params?.arguments?.departureToken);

// What a live call must look like: JSON-RPC tools/call to the documented tool, on the endpoint,
// with the key on every request. Asserting it keeps the injected path honest, so passing tests
// cannot hide a request that would fail against the real server.
function assertRequestShape(call) {
    assert.equal(call.url, 'https://mcp.hasdata.com/mcp?apis=google_travel_flights');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.headers['x-api-key'], 'test-key');
    assert.equal(call.body.jsonrpc, '2.0');
    assert.equal(call.body.method, 'tools/call');
    assert.equal(call.body.params.name, ROUND_TRIP_TOOL);
    assert.equal(call.body.params.arguments.type, 'roundTrip');
    assert.equal(call.body.params.arguments.returnDate, '2026-09-22');
}

test('success: both calls succeed and each outbound option carries its return summary', async () => {
    const { request, calls } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        const token = call.body.params.arguments.departureToken;
        return jsonResponse(
            toolMessage(
                returnPayload(
                    token === 'token-cheap'
                        ? [
                              {
                                  price: 640,
                                  totalDuration: 425,
                                  flights: FLIGHTS_A,
                                  carbonEmissions: { thisFlight: 367000 },
                              },
                          ]
                        : []
                ),
                { id: call.body.id }
            )
        );
    });

    const result = await fetchRoundTripOptions({ ...QUERY, request });

    assert.equal(result.status, 'ok');
    assert.equal(result.outbound.status, 'ok');
    assert.equal(result.outbound.availableOptions, 3);
    assert.equal(result.options.length, 3, 'all three outbound options should be priced');

    assert.deepEqual(
        result.options.map((o) => o.departureToken),
        ['token-cheap', 'token-fast', 'token-third']
    );

    const [cheap, fast] = result.options;
    assert.equal(cheap.outboundPrice, 612);
    assert.equal(cheap.status, 'ok');
    assert.equal(cheap.returnOptionCount, 1);
    assert.deepEqual(cheap.returnSummary, {
        airline: 'British Airways',
        flightNumber: 'BA 178',
        departureTime: '2026-09-22 18:30',
        arrivalTime: '2026-09-23 06:35',
        totalDuration: 425,
        price: 640,
        currency: null,
        stops: 0,
    });

    // No matching return for this token is an answer, not an error.
    assert.equal(fast.status, 'empty');
    assert.equal(fast.returnOptionCount, 0);
    assert.equal(fast.returnSummary, null);
    assert.equal(fast.failure, null);

    assert.equal(calls.length, 4, 'one outbound call plus one call per selected option');
    for (const call of calls) assertRequestShape(call);
});

test('empty returns: an option with no return flights is empty, never an error', async () => {
    const { request } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        return jsonResponse(toolMessage(returnPayload([]), { id: call.body.id }));
    });

    const result = await fetchRoundTripOptions({ ...QUERY, request, maxOutboundOptions: 1 });

    assert.equal(result.status, 'ok');
    assert.equal(result.options.length, 1);
    assert.equal(result.options[0].status, 'empty');
    assert.equal(result.options[0].returnSummary, null);
    assert.equal(result.options[0].failure, null);
});

test('an empty outbound search is reported as empty, distinct from a failed query', async () => {
    const { request } = fakeRequest((call) =>
        jsonResponse(toolMessage(returnPayload([]), { id: call.body.id }))
    );

    const result = await fetchRoundTripOptions({ ...QUERY, request });

    assert.equal(result.status, 'empty');
    assert.equal(result.outbound.status, 'empty');
    assert.equal(result.outbound.availableOptions, 0);
    assert.equal(result.outbound.failure, null);
    assert.deepEqual(result.options, []);
});

test('401 on the outbound call is recorded as an auth failure, with no retry', async () => {
    const { request, calls } = fakeRequest((call) =>
        jsonResponse(
            toolMessage('HasData API error: 401 Unauthorized', { id: call.body.id, isError: true })
        )
    );

    const result = await fetchRoundTripOptions({ ...QUERY, request });

    assert.equal(result.status, 'failed');
    assert.equal(result.outbound.status, 'failed');
    assert.equal(result.outbound.failure.category, FAILURE_CATEGORY.AUTH);
    assert.equal(result.outbound.failure.attempts, 1);
    assert.match(result.outbound.failure.message, /401 Unauthorized/i);
    assert.equal(calls.length, 1, 'an auth failure must not be retried');
});

test('401 on a transport response is also an auth failure', async () => {
    const { request } = fakeRequest(() => jsonResponse('Unauthorized', 401));

    const result = await fetchRoundTripOptions({ ...QUERY, request });
    assert.equal(result.outbound.failure.category, FAILURE_CATEGORY.AUTH);
    assert.equal(result.outbound.failure.httpStatus, 401);
});

test('a schema rejection on one option is a validation failure and the other options survive', async () => {
    const { request } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        const token = call.body.params.arguments.departureToken;
        if (token === 'token-cheap') {
            return jsonResponse(
                toolMessage('MCP error -32602: Input validation error: departureToken is invalid', {
                    id: call.body.id,
                    isError: true,
                })
            );
        }
        return jsonResponse(
            toolMessage(returnPayload([{ price: 700, totalDuration: 410, flights: FLIGHTS_A }]), { id: call.body.id })
        );
    });

    const result = await fetchRoundTripOptions({ ...QUERY, request });

    assert.equal(result.status, 'partial', 'one failed option makes the run partial, not failed');
    assert.equal(result.options.length, 3);
    const [failed, okOne, okTwo] = result.options;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure.category, FAILURE_CATEGORY.VALIDATION);
    assert.equal(failed.failure.attempts, 1, 'a validation failure must not be retried');
    assert.equal(okOne.status, 'ok');
    assert.equal(okTwo.status, 'ok');
    assert.equal(okOne.returnSummary.airline, 'British Airways');
});

test('consecutive rate limits back off, then succeed', async () => {
    const delays = [];
    let returnAttempts = 0;
    const { request } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        returnAttempts += 1;
        if (returnAttempts <= 2) {
            return jsonResponse('Too Many Requests: concurrency_limit', 429);
        }
        return jsonResponse(
            toolMessage(returnPayload([{ price: 640, totalDuration: 425, flights: FLIGHTS_A }]), { id: call.body.id })
        );
    });

    const result = await fetchRoundTripOptions({
        ...QUERY,
        request,
        maxOutboundOptions: 1,
        sleep: async (ms) => delays.push(ms),
    });

    assert.equal(result.options[0].status, 'ok');
    assert.equal(result.options[0].failure, null);
    assert.equal(returnAttempts, 3);
    assert.deepEqual(delays, [1000, 2000], 'each retry waits longer than the last');
});

test('rate limits that never clear become a rate_limit failure after the attempts run out', async () => {
    const delays = [];
    const { request, calls } = fakeRequest(() => jsonResponse('concurrency_limit', 429));

    const result = await fetchRoundTripOptions({
        ...QUERY,
        request,
        maxAttempts: 3,
        sleep: async (ms) => delays.push(ms),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.outbound.status, 'failed');
    assert.equal(result.outbound.failure.category, FAILURE_CATEGORY.RATE_LIMIT);
    assert.equal(result.outbound.failure.attempts, 3);
    assert.equal(result.outbound.failure.httpStatus, 429);
    assert.deepEqual(delays, [1000, 2000]);
    assert.equal(calls.length, 3, 'a rate-limited query stops after the configured attempts');
});

test('an unexpected transport error on one option keeps the other options', async () => {
    const { request } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        if (call.body.params.arguments.departureToken === 'token-fast') throw new Error('socket hang up');
        return jsonResponse(toolMessage(returnPayload([{ price: 640, flights: FLIGHTS_A }]), { id: call.body.id }));
    });

    const result = await fetchRoundTripOptions({ ...QUERY, request });

    assert.equal(result.status, 'partial');
    assert.equal(result.options.length, 3);
    assert.equal(result.options[0].status, 'ok');
    assert.equal(result.options[1].status, 'failed');
    assert.equal(result.options[1].failure.category, FAILURE_CATEGORY.OTHER);
    assert.equal(result.options[2].status, 'ok');
});

test('only the requested number of outbound options is priced', async () => {
    const { request, calls } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        return jsonResponse(toolMessage(returnPayload([{ price: 640, flights: FLIGHTS_A }]), { id: call.body.id }));
    });

    const result = await fetchRoundTripOptions({ ...QUERY, request, maxOutboundOptions: 2 });

    assert.equal(result.options.length, 2);
    assert.equal(calls.length, 3, 'one outbound call plus two return calls');
    assert.deepEqual(
        calls.slice(1).map((c) => c.body.params.arguments.departureToken),
        ['token-cheap', 'token-fast']
    );
});

test('the positional call form prices the same flow', async () => {
    const { request, calls } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        return jsonResponse(toolMessage(returnPayload([{ price: 640, flights: FLIGHTS_A }]), { id: call.body.id }));
    });

    const result = await fetchRoundTripOptions(
        request,
        QUERY.apiKey,
        QUERY.origin,
        QUERY.destination,
        QUERY.outboundDate,
        QUERY.returnDate,
        1
    );

    assert.equal(result.options.length, 1);
    assert.equal(result.options[0].status, 'ok');
    assert.equal(calls.length, 2);
    for (const call of calls) assertRequestShape(call);
});

// Opt-in live smoke test. Everything else in this file is offline. Set both
// HASDATA_API_KEY and HASDATA_ROUND_TRIP_LIVE=1 to run it; it spends credits (one outbound
// call plus one return call per option) and only asserts the shape, never specific fares.
// Nothing here should be copied into a report as a production result when it was skipped.
const LIVE_KEY = process.env.HASDATA_API_KEY;
const LIVE_OPT_IN = process.env.HASDATA_ROUND_TRIP_LIVE === '1';

test(
    'live: the endpoint answers the two-call flow',
    { skip: LIVE_KEY && LIVE_OPT_IN ? false : 'set HASDATA_API_KEY and HASDATA_ROUND_TRIP_LIVE=1 to run the live check' },
    async () => {
        const outboundDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
        const returnDate = new Date(Date.now() + 37 * 86_400_000).toISOString().slice(0, 10);
        const result = await fetchRoundTripOptions({
            apiKey: LIVE_KEY,
            origin: 'JFK',
            destination: 'LHR',
            outboundDate,
            returnDate,
            maxOutboundOptions: 1,
        });

        assert.ok(['ok', 'empty', 'partial', 'failed'].includes(result.status));
        assert.equal(result.query.type, 'roundTrip');
        if (result.status === 'failed') {
            // Network trouble and plan concurrency are tolerated; a rejected key or a broken
            // schema is the contract moving, which the live check exists to catch.
            const category = result.outbound.failure.category;
            assert.ok(
                category === FAILURE_CATEGORY.RATE_LIMIT || category === FAILURE_CATEGORY.OTHER,
                `live call failed as ${category}: ${result.outbound.failure.message}`
            );
        } else {
            assert.ok(result.options.length <= 1);
            for (const option of result.options) {
                assert.ok(['ok', 'empty', 'failed'].includes(option.status));
                assert.equal(typeof option.departureToken, 'string');
            }
        }
    }
);

test('when every selected option fails the run is failed, with each reason kept', async () => {
    const { request } = fakeRequest((call) => {
        if (!isReturnCall(call.body)) return jsonResponse(toolMessage(outboundPayload(), { id: call.body.id }));
        return jsonResponse(toolMessage('HasData API error: 401 Unauthorized', { id: call.body.id, isError: true }));
    });

    const result = await fetchRoundTripOptions({ ...QUERY, request, maxOutboundOptions: 2 });

    assert.equal(result.status, 'failed');
    assert.equal(result.outbound.status, 'ok', 'the outbound search itself succeeded');
    assert.equal(result.options.length, 2);
    for (const option of result.options) {
        assert.equal(option.status, 'failed');
        assert.equal(option.failure.category, FAILURE_CATEGORY.AUTH);
    }
});

test('server-sent events are unwrapped, not treated as failures', async () => {
    const sse = (message) =>
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n` +
        `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    const { request } = fakeRequest((call) =>
        jsonResponse(
            sse(
                toolMessage(
                    isReturnCall(call.body)
                        ? returnPayload([{ price: 640, totalDuration: 425, flights: FLIGHTS_A }])
                        : outboundPayload(),
                    { id: call.body.id }
                )
            )
        )
    );

    const result = await fetchRoundTripOptions({ ...QUERY, request, maxOutboundOptions: 1 });

    assert.equal(result.status, 'ok');
    assert.equal(result.options[0].status, 'ok');
    assert.equal(result.options[0].returnSummary.flightNumber, 'BA 178');
});

test('a JSON-RPC error object is classified rather than thrown raw', async () => {
    const { request } = fakeRequest((call) =>
        jsonResponse({
            jsonrpc: '2.0',
            id: call.body.id,
            error: { code: -32602, message: 'Input validation error: outboundDate must be in the future' },
        })
    );

    const result = await fetchRoundTripOptions({ ...QUERY, request });

    assert.equal(result.status, 'failed');
    assert.equal(result.outbound.failure.category, FAILURE_CATEGORY.VALIDATION);
});

test('the default path is the documented endpoint and tool, even without a request override', async () => {
    // No injected request: the function would post to HasData. Swapping global fetch for the
    // duration of the call proves the production path is wired exactly as documented without
    // sending anything.
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        seen.push({ url, init, body, headers: init.headers });
        return jsonResponse(
            toolMessage(isReturnCall(body) ? returnPayload([]) : outboundPayload(), { id: body.id })
        );
    };
    try {
        const result = await fetchRoundTripOptions({ ...QUERY, maxOutboundOptions: 1 });
        assert.equal(result.status, 'ok');
    } finally {
        globalThis.fetch = original;
    }

    assert.equal(seen.length, 2);
    for (const call of seen) assertRequestShape(call);
});

test('a malformed query is rejected before any request goes out', async () => {
    const { request, calls } = fakeRequest(() => {
        throw new Error('should not be called');
    });

    await assert.rejects(
        fetchRoundTripOptions({ ...QUERY, request, returnDate: '2026-09-01' }),
        /returnDate must not be before outboundDate/
    );
    await assert.rejects(fetchRoundTripOptions({ ...QUERY, request, apiKey: '' }), /apiKey/);
    await assert.rejects(fetchRoundTripOptions({ ...QUERY, request, outboundDate: '15/09/2026' }), /outboundDate/);
    assert.equal(calls.length, 0);
});
