/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — tests/helpers/testServer.js
 *
 * @description
 *   Spawns the real Express server (server.js) as an isolated child process
 *   pointed at the local fake upstream. A fresh process per scenario gives
 *   every test a clean mirror-state and a clean LRU cache, so scenarios can
 *   never bleed into one another.
 *
 *   The child is configured entirely through env vars already understood by
 *   the application — no production code contains test-only branches:
 *     MIRROR_DOMAINS        — rewrites the mirror list to the fake upstream
 *     PORT                  — ephemeral API port
 *     RATE_LIMIT            — raised so the suite is never throttled
 *     SCRAPER_API_KEY       — deliberately unset (direct-only chain)
 *
 * @exports
 *   spawnApiServer, waitForHealth, getFreePort
 *
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server.js");

// ---- FEATURE: Reserve an ephemeral port for the spawned API ----
const getFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// ---- FEATURE: Poll /api/health until the child server is accepting requests ----
const waitForHealth = async (baseUrl, { timeoutMs = 15000, intervalMs = 150 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`API server did not become healthy: ${lastError?.message || "timeout"}`);
};

/**
 * Spawns server.js with the given mirror domains.
 *
 * @param {object} opts
 * @param {string[]} opts.mirrorDomains - Full mirror list for the child
 * @param {object} [opts.extraEnv] - Additional env overrides
 * @returns {Promise<{baseUrl: string, stop: Function, logs: string}>}
 */
const spawnApiServer = async ({ mirrorDomains, extraEnv = {} }) => {
  const port = await getFreePort();
  const env = {
    ...process.env,
    // Ensure no real proxy credentials leak into the test chain
    SCRAPER_API_KEY: "",
    FLARESOLVERR_URL: "",
    PORT: String(port),
    RATE_LIMIT: "10000",
    NODE_ENV: "test",
    MIRROR_DOMAINS: mirrorDomains.join(","),
    ...extraEnv,
  };

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      // Hard kill if graceful shutdown hangs
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 5000).unref?.();
    });

  return { baseUrl, stop, logs, child };
};

export { spawnApiServer, waitForHealth, getFreePort };
