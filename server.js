"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { timingSafeEqual } = require("crypto");
const { URL } = require("url");
const config = require("./config");
const { ensureDirs, loginCheck, dryRunImageText } = require("./douyin");
const { loadLocalBatch } = require("./local-batch");
const { extractBaseToken, extractTableId, extractRecordId, extractRequestId, recordToDouyinJob } = require("./feishu");

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      const error = new Error("content-type must be application/json");
      error.statusCode = 415;
      reject(error);
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        const wrapped = new Error(`invalid json body: ${error.message}`);
        wrapped.statusCode = 400;
        reject(wrapped);
      }
    });
    req.on("error", reject);
  });
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isUsableBridgeSecret(secret) {
  const normalized = String(secret || "").trim();
  return normalized.length >= 16 && !/^change[-_ ]?me/i.test(normalized);
}

function validateServerSecurity({ host, bridgeSecret }) {
  if (!isLoopbackHost(host) && !isUsableBridgeSecret(bridgeSecret)) {
    throw new Error("BRIDGE_SECRET must be at least 16 non-placeholder characters when HOST is not loopback");
  }
}

function secretsEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireSecret(req) {
  if (!config.bridgeSecret && isLoopbackHost(config.host)) return;
  if (!secretsEqual(req.headers["x-bridge-secret"], config.bridgeSecret)) {
    const error = new Error("invalid bridge secret");
    error.statusCode = 401;
    throw error;
  }
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function serveScreenshot(url, res) {
  const filename = decodeURIComponent(url.pathname.replace(/^\/screenshots\//, ""));
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return sendJson(res, 400, { ok: false, error: "invalid screenshot filename" });
  }
  const filePath = path.join(config.screenshotsDir, filename);
  if (!fs.existsSync(filePath)) {
    return sendJson(res, 404, { ok: false, error: "screenshot not found" });
  }
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "douyin-rpa-publisher",
      dry_run: config.dryRun,
      headless: config.headless,
      browser_channel: config.browserChannel,
      login_wait_ms: config.defaultLoginWaitMs,
      login_ui_wait_ms: config.loginUiWaitMs,
      login_qr_settle_ms: config.loginQrSettleMs,
      upload_wait_ms: config.uploadWaitMs,
      content_check_wait_ms: config.contentCheckWaitMs,
      policy: "strict-seven-field-single-image",
      real_publish_armed: !config.dryRun && Boolean(config.authorizedBatchId)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/local-batch/validate") {
    requireSecret(req);
    const batch = await loadLocalBatch({
      batchConfigPath: config.batchConfigPath,
      imageDirectory: config.localImageDirectory,
      requireScheduleWindow: true
    });
    const { items, ...validation } = batch.validation;
    return sendJson(res, 200, { ok: true, validation });
  }

  if (req.method === "GET" && url.pathname.startsWith("/screenshots/")) {
    requireSecret(req);
    return serveScreenshot(url, res);
  }

  if (req.method === "POST" && url.pathname === "/api/douyin/login-check") {
    requireSecret(req);
    const body = await readBody(req);
    const result = await loginCheck({
      anchor: body.anchor_key || body.profile || body.anchor,
      waitForLoginMs: body.wait_for_login_ms
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/douyin/dry-run") {
    requireSecret(req);
    const body = await readBody(req);
    const result = await dryRunImageText({
      anchor: body.anchor_key || body.profile || body.anchor,
      job: body.job || body,
      jobDir: __dirname,
      publish: Boolean(body.publish),
      authorization: body.authorization || req.headers["x-batch-authorization"] || ""
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/feishu/douyin-dry-run") {
    requireSecret(req);
    const body = await readBody(req);
    const baseToken = extractBaseToken(body);
    const tableId = extractTableId(body);
    const recordId = extractRecordId(body);
    const requestId = extractRequestId(body);
    if (!baseToken || !tableId || (!recordId && !requestId)) {
      return sendJson(res, 400, {
        ok: false,
        error: "missing base_token, table_id, and record_id/request_id"
      });
    }

    const built = await recordToDouyinJob({ baseToken, tableId, recordId, requestId });
    const result = await dryRunImageText({
      anchor: body.anchor_key || body.profile || body.anchor || built.job.anchor_key,
      job: built.job,
      jobDir: built.local_image_dir,
      publish: Boolean(body.publish),
      authorization: body.authorization || req.headers["x-batch-authorization"] || ""
    });

    return sendJson(res, 200, {
      ...result,
      source_record: {
        base_token: baseToken,
        table_id: tableId,
        record_ref: recordId || requestId,
        record_id: built.record_id,
        request_id: built.request_id,
        local_image_dir: built.local_image_dir,
        source_image_count: built.source_image_count
      }
    });
  }

  return sendJson(res, 404, { ok: false, error: "not found" });
}

function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    });
  });
}

async function startServer() {
  validateServerSecurity(config);
  await ensureDirs();
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`douyin-rpa-publisher listening on http://${config.host}:${config.port}`);
    console.log(`dry_run=${config.dryRun} headless=${config.headless}`);
  });
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  isLoopbackHost,
  isUsableBridgeSecret,
  readBody,
  requireSecret,
  route,
  secretsEqual,
  startServer,
  validateServerSecurity
};
