// foura_batch contract - one call, many URLs, independent per-URL outcomes.
//
// The whole suite runs against a LOCAL mock of the FourA API (FOURA_API_BASE points
// at a 127.0.0.1 http server) and a dummy key, so it never touches the real network
// or a real secret. SSRF-blocked entries need no upstream request at all: the check
// runs inside the MCP server before any fetch.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnLocalServer } from "../helpers/stdio-client.mjs";
import { getTextContent } from "../helpers/assertions.mjs";

let mockServer;
let client;
let routes;
let inFlight = 0;
let maxInFlight = 0;
const requests = [];

before(async () => {
  // Map of target URL -> {status, body} the mock /auto route should answer with.
  routes = new Map();
  mockServer = createServer(async (req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on("close", () => { inFlight -= 1; });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(raw);
    requests.push({ method: req.method, url: req.url, body });

    if (req.url !== "/auto") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected mock route ${req.url}` }));
      return;
    }

    const route = routes.get(body.url);
    if (!route) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no mock configured for ${body.url}` }));
      return;
    }
    // A delay lets the concurrency test observe several requests in flight at once.
    if (route.delayMs) await new Promise((resolve) => setTimeout(resolve, route.delayMs));
    res.writeHead(route.status, {
      "content-type": "application/json",
      ...(route.headers ?? {}),
    });
    res.end(JSON.stringify(route.body));
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  client = await spawnLocalServer({
    FOURA_API_KEY: "pk_live_batch_test_dummy",
    FOURA_API_BASE: `http://127.0.0.1:${mockServer.address().port}`,
  });
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => mockServer?.close(resolve));
});

const OK_A = "https://1.1.1.1/a";
const OK_B = "https://1.1.1.2/b";
const OK_C = "https://1.1.1.3/c";
const RATE_LIMITED = "https://2.2.2.1/rate-limited";
const UPSTREAM_500 = "https://2.2.2.2/upstream-500";
const SSRF_TARGET = "http://127.0.0.1:8080/admin";

function okRoute(id) {
  return {
    status: 200,
    body: {
      status: 200,
      data: `body-${id}`,
      meta: { rung: "probe", solved: false, attempts: 1, credits: 1 },
    },
    headers: { "x-foura-credits": "1", "x-foura-request-id": `req-${id}` },
  };
}

function setRoutes(entries) {
  routes.clear();
  for (const [url, route] of entries) routes.set(url, route);
}

describe("foura_batch - tools/list registration", () => {
  test("the batch tool is advertised with batch-shaped input and output schemas", async () => {
    const tools = await client.listTools();
    const tool = tools.find((t) => t.name === "foura_batch");
    assert.ok(tool, "foura_batch must be registered");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.inputSchema.properties.urls, "urls field is published");
    assert.equal(tool.inputSchema.properties.timeout_ms.description?.includes("Per-URL"), true);
    // Ranges are enforced in the handler (so violations return the bad_request envelope);
    // the published descriptions still state the bounds.
    assert.match(tool.inputSchema.properties.concurrency.description ?? "", /1-8/);
    assert.match(tool.inputSchema.properties.timeout_ms.description ?? "", /5000-180000/);
    assert.ok(tool.outputSchema.properties.summary);
    assert.ok(tool.outputSchema.properties.results);
    assert.ok(tool.outputSchema.properties.retry);
  });
});

describe("foura_batch - all entries succeed", () => {
  test("returns ok entries in input order, zero failures and an empty retry list", async () => {
    setRoutes([
      [OK_A, okRoute("a")],
      [OK_B, okRoute("b")],
      [OK_C, okRoute("c")],
    ]);
    const before = requests.length;
    const result = await client.callTool("foura_batch", {
      urls: [OK_A, OK_B, OK_C],
      timeout_ms: 5000,
      concurrency: 3,
    });

    assert.equal(result.isError, undefined, "a successful batch must not be an error");
    assert.equal(requests.length - before, 3, "one /auto request per URL");
    assert.deepEqual(
      requests.slice(before).map((r) => r.body.url),
      [OK_A, OK_B, OK_C],
      "each entry forwards its own URL to the foura_auto route",
    );
    for (const req of requests.slice(before)) {
      assert.equal(req.body.timeout_ms, 5000, "the per-URL budget is forwarded to foura_auto");
    }

    const sc = result.structuredContent;
    assert.deepEqual(sc.summary, { total: 3, succeeded: 3, failed: 0 });
    assert.equal(sc.results.length, 3);
    assert.deepEqual(
      sc.results.map((r) => r.url),
      [OK_A, OK_B, OK_C],
      "result order matches input order",
    );
    for (const entry of sc.results) {
      assert.equal(entry.ok, true);
      assert.equal(entry.status, 200);
      assert.equal(entry.code, null);
      assert.equal(entry.error, null);
      assert.equal(typeof entry.duration_ms, "number");
      assert.ok(entry.duration_ms >= 0);
      assert.equal(typeof entry.request_id, "string");
      assert.equal(entry.credits, 1);
    }
    assert.deepEqual(sc.retry, [], "retry must be an empty array on full success");
    assert.match(getTextContent(result), /3\/3 succeeded/);
  });

  test("defaults apply when timeout_ms and concurrency are omitted", async () => {
    setRoutes([[OK_A, okRoute("a-default")]]);
    const before = requests.length;
    const result = await client.callTool("foura_batch", { urls: [OK_A] });

    assert.notEqual(result.isError, true);
    const req = requests.at(-1);
    assert.equal(requests.length - before, 1);
    assert.equal(req.body.timeout_ms, 30000, "default per-URL budget is 30000ms");
    assert.equal(result.structuredContent.summary.total, 1);
  });
});

describe("foura_batch - partial failure with distinct stable codes", () => {
  test("one ssrf_blocked, one rate_limited, one upstream_error, one success; the batch still succeeds", async () => {
    setRoutes([
      [OK_A, okRoute("a")],
      [
        RATE_LIMITED,
        {
          status: 429,
          body: { error: "Rate limit exceeded", retryAfter: 12 },
          headers: { "x-foura-request-id": "req-rate" },
        },
      ],
      [
        UPSTREAM_500,
        {
          status: 500,
          body: { error: "upstream exploded" },
          headers: { "x-foura-credits": "7", "x-foura-request-id": "req-500" },
        },
      ],
    ]);
    // Deliberately shuffle the input so order assertions mean something.
    const urls = [RATE_LIMITED, SSRF_TARGET, OK_A, UPSTREAM_500];
    const result = await client.callTool("foura_batch", {
      urls,
      timeout_ms: 5000,
      concurrency: 2,
    });

    assert.equal(result.isError, undefined, "per-URL failures must not mark the batch as isError");
    const sc = result.structuredContent;
    assert.deepEqual(sc.summary, { total: 4, succeeded: 1, failed: 3 });

    assert.deepEqual(
      sc.results.map((r) => r.url),
      urls,
      "results stay in input order regardless of concurrency finish order",
    );

    const byUrl = new Map(sc.results.map((r) => [r.url, r]));

    const rateEntry = byUrl.get(RATE_LIMITED);
    assert.equal(rateEntry.ok, false);
    assert.equal(rateEntry.code, "rate_limited");
    assert.equal(rateEntry.status, 429);
    assert.match(rateEntry.error, /Rate limit exceeded/);
    assert.equal(typeof rateEntry.duration_ms, "number");

    const ssrfEntry = byUrl.get(SSRF_TARGET);
    assert.equal(ssrfEntry.ok, false);
    assert.equal(ssrfEntry.code, "ssrf_blocked");
    assert.equal(ssrfEntry.status, null, "an SSRF block happens before any HTTP response");
    assert.match(ssrfEntry.error, /private or reserved/i);
    assert.equal(typeof ssrfEntry.duration_ms, "number");

    const upstreamEntry = byUrl.get(UPSTREAM_500);
    assert.equal(upstreamEntry.ok, false);
    assert.equal(upstreamEntry.code, "upstream_error");
    assert.equal(upstreamEntry.status, 500);
    assert.equal(upstreamEntry.credits, 7, "credits are surfaced even when the entry failed");
    assert.match(upstreamEntry.error, /upstream exploded/);

    const okEntry = byUrl.get(OK_A);
    assert.equal(okEntry.ok, true);
    assert.equal(okEntry.status, 200);
    assert.equal(okEntry.code, null);

    // retry lists only failures, in input order, resubmittable verbatim.
    assert.deepEqual(sc.retry, [
      { url: RATE_LIMITED, code: "rate_limited" },
      { url: SSRF_TARGET, code: "ssrf_blocked" },
      { url: UPSTREAM_500, code: "upstream_error" },
    ]);

    // The SSRF entry never reached the mock upstream; the other three did.
    const targetUrls = requests.slice(-3).map((r) => r.body.url);
    assert.ok(!targetUrls.includes(SSRF_TARGET), "ssrf_blocked entries must not call the upstream");
    assert.ok(targetUrls.includes(OK_A));
    assert.ok(targetUrls.includes(RATE_LIMITED));
    assert.ok(targetUrls.includes(UPSTREAM_500));
  });

  test("a 200 response carrying an error body is still a failed entry with a stable code", async () => {
    setRoutes([
      [
        UPSTREAM_500,
        {
          status: 200,
          body: { status: 0, error: "Connection refused by target", data: "" },
        },
      ],
      [OK_B, okRoute("b")],
    ]);
    const result = await client.callTool("foura_batch", {
      urls: [UPSTREAM_500, OK_B],
      timeout_ms: 5000,
    });
    const sc = result.structuredContent;
    assert.equal(sc.summary.failed, 1);
    assert.equal(sc.results[0].ok, false);
    assert.equal(sc.results[0].code, "upstream_error");
    assert.equal(sc.results[0].status, 0, "target-side failure with no HTTP response reports status 0");
    assert.equal(sc.results[1].ok, true);
    assert.deepEqual(sc.retry, [{ url: UPSTREAM_500, code: "upstream_error" }]);
  });
});

describe("foura_batch - invalid batch input returns bad_request", () => {
  test("empty urls list", async () => {
    const result = await client.callTool("foura_batch", { urls: [] });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.service, "batch");
    assert.equal(result.structuredContent.code, "bad_request");
    assert.match(result.structuredContent.error, /urls must contain/);
  });

  test("urls missing or not an array", async () => {
    const before = requests.length;
    for (const args of [{}, { urls: "https://1.1.1.1/" }, { urls: null }, { urls: [42] }]) {
      const result = await client.callTool("foura_batch", args);
      assert.equal(result.isError, true, `args ${JSON.stringify(args)} must be refused`);
      // All invalid-input paths land in the handler's bad_request envelope.
      assert.equal(result.structuredContent?.service, "batch", `args ${JSON.stringify(args)}`);
      assert.equal(result.structuredContent?.code, "bad_request", `args ${JSON.stringify(args)}`);
    }
    assert.equal(requests.length, before, "malformed batches perform no upstream work");
  });

  test("more than 50 urls", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `https://1.1.1.${(i % 250) + 1}/${i}`);
    const before = requests.length;
    const result = await client.callTool("foura_batch", { urls: tooMany });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "bad_request");
    assert.match(result.structuredContent.error, /50/);
    assert.equal(requests.length, before, "an over-limit batch performs no upstream work");
  });

  test("a non-http(s) entry and a malformed entry are refused before any fetch", async () => {
    const before = requests.length;
    const ftp = await client.callTool("foura_batch", {
      urls: ["ftp://1.1.1.9/file", OK_A],
    });
    assert.equal(ftp.isError, true);
    assert.equal(ftp.structuredContent.code, "bad_request");
    assert.match(ftp.structuredContent.error, /http or https/);

    const malformed = await client.callTool("foura_batch", {
      urls: ["not-a-url"],
    });
    assert.equal(malformed.isError, true);
    assert.equal(malformed.structuredContent.code, "bad_request");
    assert.match(malformed.structuredContent.error, /valid http or https/);

    assert.equal(requests.length, before, "no /auto request may fire for an invalid batch");
  });

  test("out-of-range timeout_ms and concurrency are refused", async () => {
    const badTimeout = await client.callTool("foura_batch", {
      urls: [OK_A],
      timeout_ms: 1000,
    });
    assert.equal(badTimeout.isError, true);
    assert.equal(badTimeout.structuredContent.code, "bad_request");

    const badConcurrency = await client.callTool("foura_batch", {
      urls: [OK_A],
      concurrency: 9,
    });
    assert.equal(badConcurrency.isError, true);
    assert.equal(badConcurrency.structuredContent.code, "bad_request");
    assert.match(badConcurrency.structuredContent.error, /concurrency/);
  });
});

describe("foura_batch - concurrency cap and ordering under parallel execution", () => {
  test("concurrency bounds in-flight requests while order stays identical to input", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://8.8.8.${i + 1}/parallel`);
    setRoutes(
      urls.map((url, i) => [
        url,
        {
          status: 200,
          delayMs: 40,
          // Odd entries fail, giving a mixed batch under real concurrency.
          body: i % 2 === 1
            ? { status: 404, error: "not found" }
            : { status: 200, data: `ok-${i}`, meta: { credits: 1 } },
        },
      ]),
    );

    maxInFlight = 0;
    const result = await client.callTool("foura_batch", {
      urls,
      timeout_ms: 5000,
      concurrency: 3,
    });
    const sc = result.structuredContent;
    assert.deepEqual(sc.results.map((r) => r.url), urls);
    assert.equal(sc.summary.succeeded, 4);
    assert.equal(sc.summary.failed, 4);
    assert.ok(maxInFlight <= 3, `never more than 3 in flight, saw ${maxInFlight}`);
    assert.equal(maxInFlight, 3, "the cap of 3 should actually be reached");
    assert.deepEqual(
      sc.retry.map((r) => r.url),
      urls.filter((_, i) => i % 2 === 1),
    );
    assert.ok(sc.retry.every((r) => r.code === "not_found"));
  });
});
