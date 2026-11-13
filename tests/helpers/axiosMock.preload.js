/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — tests/helpers/axiosMock.preload.js
 *
 * @description
 *   Registers a process-wide axios mock before any test module loads. The
 *   Node test runner only allows a module to be mocked once per process, so
 *   the stub is a mutable singleton: tests set `globalThis.__axiosHandler`
 *   per scenario, and every axios.get call made by the code under test is
 *   routed through it. No real network call ever happens.
 *
 *   proxy.helper.js reads SCRAPER_API_KEY/FLARESOLVERR_URL at module-eval
 *   time and ESM imports are hoisted ahead of test bodies, so per-scenario
 *   env is published on `globalThis.__proxyEnv` before the helper's first
 *   dynamic import and mirrored into process.env by this preload.
 *
 *   Loaded automatically by the `npm run test:outcome` script through
 *   --import; test files never import this module directly.
 *
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import { mock } from "node:test";

// Per-scenario handler: (url, config) => axios-like response | throws
globalThis.__axiosHandler = () => {
  throw new Error("No axios handler installed for this test scenario");
};

// Per-scenario proxy configuration consumed by proxy.helper at module load
globalThis.__proxyEnv = {};

// Call log, reset by tests through globalThis.__resetAxiosCalls
globalThis.__axiosCalls = [];
globalThis.__resetAxiosCalls = () => {
  globalThis.__axiosCalls.length = 0;
};

const PROXY_ENV_KEYS = ["SCRAPER_API_KEY", "FLARESOLVERR_URL"];
const applyProxyEnv = () => {
  for (const key of PROXY_ENV_KEYS) {
    const value = globalThis.__proxyEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
globalThis.__applyProxyEnv = applyProxyEnv;

mock.module("axios", {
  namedExports: {
    default: {
      get: async (url, config) => {
        globalThis.__axiosCalls.push({ method: "get", url, config });
        return globalThis.__axiosHandler(url, config);
      },
      // FlareSolverr is the only POST caller in the proxy chain
      post: async (url, body, config) => {
        globalThis.__axiosCalls.push({ method: "post", url, body, config });
        return globalThis.__axiosHandler(url, { ...config, method: "post", body });
      },
    },
  },
  // NOTE: cache:true keeps the axios mock itself registered, while the code
  // under test is imported with unique query strings so each scenario gets a
  // fresh module evaluation (and thus fresh process.env-driven config).
  cache: true,
});
