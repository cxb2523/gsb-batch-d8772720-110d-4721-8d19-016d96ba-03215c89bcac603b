/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — tests/proxyAttempts.test.js
 *
 * @description
 *   Unit tests for the proxy fallback chain in proxy.helper.js. The only
 *   external boundary in that helper is `axios.get`/`axios.post`, intercepted
 *   process-wide by tests/helpers/axiosMock.preload.js (registered through
 *   --import in the npm script) — no network at all, no DNS, no sockets to
 *   real ScraperAPI/FlareSolverr hosts. The helper reads its ScraperAPI/
 *   FlareSolverr configuration from process.env at module load, so each
 *   scenario imports a fresh module copy under a private env and installs a
 *   scripted axios handler.
 *
 *   Verifies that `attempts` records the real channel order — direct,
 *   scraperapi, flaresolverr and direct-retry — which mirror.helper forwards
 *   into collectionOutcome.proxyAttempts.
 *
 *   Run: npm run test:outcome
 *
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_HELPER = path.join(__dirname, "..", "src", "helper", "proxy.helper.js");

// NOTE: Scenarios share the process-wide axios stub (globalThis.__axiosHandler),
// so this suite runs sequentially — concurrent tests would swap each other's
// handlers.
describe("proxy fallback chain", { concurrency: false }, () => {
  let scenarioSeq = 0;

  /**
   * Loads a fresh proxy.helper copy with a private env and installs an axios
   * handler that answers every stubbed call for this scenario.
   *
   * @param {object} opts
   * @param {object} opts.env - process.env overrides for the module load
   * @param {Function} opts.handler - (url, config) => axios response, or throws
   * @returns {Promise<{helper: object, calls: Array}>}
   */
  const loadHelper = async ({ env, handler }) => {
    scenarioSeq += 1;
    globalThis.__axiosHandler = handler;
    globalThis.__resetAxiosCalls();

    // Publish before the dynamic import: the helper reads proxy config at
    // module-eval time, which is earlier than any test-body statement runs.
    globalThis.__proxyEnv = env;
    globalThis.__applyProxyEnv();

    const href = `${pathToFileURL(PROXY_HELPER).href}?scenario=${scenarioSeq}`;
    const helper = await import(href);
    return { helper, calls: globalThis.__axiosCalls };
  };

  const TARGET_URL = "http://upstream.example.test/filter?keyword=naruto";
  const networkError = () => {
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    return err;
  };

  test("direct success reports proxy=direct with one direct attempt", async () => {
    const { helper, calls } = await loadHelper({
      env: {},
      handler: () => ({ status: 200, data: "<html>ok</html>" }),
    });

    const result = await helper.fetchWithProxy(TARGET_URL, { timeout: 1000 });

    assert.equal(result.proxy, "direct");
    assert.deepEqual(result.attempts, ["direct"]);
    assert.equal(result.data, "<html>ok</html>");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TARGET_URL);
  });

  test("direct failure is rescued by ScraperAPI and both channels are recorded", async () => {
    const { helper, calls } = await loadHelper({
      env: { SCRAPER_API_KEY: "test-key" },
      handler: (url, config) => {
        if (url.includes("api.scraperapi.com")) {
          // axios takes ScraperAPI's key/url as params, not a prebuilt query string
          assert.equal(config.params.api_key, "test-key");
          assert.equal(config.params.url, TARGET_URL);
          return { status: 200, data: "served-by-scraperapi" };
        }
        throw networkError();
      },
    });

    const result = await helper.fetchWithProxy(TARGET_URL, { timeout: 1000 });

    assert.equal(result.proxy, "scraperapi");
    assert.deepEqual(result.attempts, ["direct", "scraperapi"]);
    assert.equal(result.data, "served-by-scraperapi");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, TARGET_URL);
    assert.ok(calls[1].url.includes("api.scraperapi.com"));
  });

  test("ScraperAPI failure falls through to FlareSolverr", async () => {
    const { helper, calls } = await loadHelper({
      env: {
        SCRAPER_API_KEY: "test-key",
        FLARESOLVERR_URL: "http://flaresolverr.example.test",
      },
      handler: (url, config) => {
        if (url.includes("api.scraperapi.com")) {
          throw new Error("scraperapi 500");
        }
        if (url.includes("flaresolverr.example.test")) {
          assert.equal(config.method, "post");
          return {
            status: 200,
            data: { status: "ok", solution: { response: "served-by-flaresolverr" } },
          };
        }
        throw networkError();
      },
    });

    const result = await helper.fetchWithProxy(TARGET_URL, { timeout: 1000 });

    assert.equal(result.proxy, "flaresolverr");
    assert.deepEqual(result.attempts, ["direct", "scraperapi", "flaresolverr"]);
    assert.equal(result.data, "served-by-flaresolverr");
    assert.equal(calls.length, 3);
  });

  test("every proxy exhausted ends on the direct-retry channel", async () => {
    let directCalls = 0;
    const { helper } = await loadHelper({
      env: {
        SCRAPER_API_KEY: "test-key",
        FLARESOLVERR_URL: "http://flaresolverr.example.test",
      },
      handler: (url) => {
        if (url.includes("api.scraperapi.com")) throw new Error("scraperapi down");
        if (url.includes("flaresolverr.example.test")) {
          return { status: 200, data: { status: "error", message: "blocked" } };
        }
        // First direct leg fails; the final direct-retry leg succeeds
        directCalls += 1;
        if (directCalls === 1) throw networkError();
        return { status: 200, data: "served-by-direct-retry" };
      },
    });

    const result = await helper.fetchWithProxy(TARGET_URL, { timeout: 1000 });

    assert.equal(result.proxy, "direct-retry");
    assert.deepEqual(result.attempts, ["direct", "scraperapi", "flaresolverr", "direct-retry"]);
    assert.equal(result.data, "served-by-direct-retry");
  });

  test("with no proxy configured a direct failure rejects", async () => {
    const { helper } = await loadHelper({
      env: {},
      handler: () => {
        throw networkError();
      },
    });

    await assert.rejects(
      () => helper.fetchWithProxy(TARGET_URL, { timeout: 1000 }),
      /ECONNREFUSED/
    );
  });
});
