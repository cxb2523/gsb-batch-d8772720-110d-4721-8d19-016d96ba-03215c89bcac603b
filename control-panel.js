"use strict";

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");

const config = require("./config");
const {
  isLedgerVerified,
  loadLocalBatch,
  readLedger
} = require("./local-batch");

const PANEL_HOST = "127.0.0.1";
const PANEL_PORT = positiveInteger(process.env.PANEL_PORT, 3400);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_JOB_OUTPUT = 512 * 1024;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const CLEAR_CONFIRMATIONS = Object.freeze({
  source: "CLEAR_SOURCE_IMAGES",
  renamed: "CLEAR_RENAMED_IMAGES"
});

let activeJob = null;
let lastJob = null;
let jobSequence = 0;
let activeMaintenance = false;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

function isAllowedOrigin(origin, port = PANEL_PORT) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const hostAllowed = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    return hostAllowed && parsed.port === String(port);
  } catch {
    return false;
  }
}

function assertLocalRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    const error = new Error("control panel only accepts local requests");
    error.statusCode = 403;
    throw error;
  }
  if (req.method !== "GET" && !isAllowedOrigin(req.headers.origin)) {
    const error = new Error("request origin is not allowed");
    error.statusCode = 403;
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(res, fileName) {
  const allowed = new Set(["control-panel.html", "control-panel.css", "control-panel-client.js"]);
  if (!allowed.has(fileName)) return sendJson(res, 404, { ok: false, error: "not found" });
  const filePath = path.join(PUBLIC_DIR, fileName);
  const body = await fsPromises.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(body);
}

function readJsonBody(req) {
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
      if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (error) {
        const wrapped = new Error(`invalid json body: ${error.message}`);
        wrapped.statusCode = 400;
        reject(wrapped);
      }
    });
    req.on("error", reject);
  });
}

async function countImages(directory) {
  try {
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function managedFolderSpec(key) {
  const targets = {
    source: {
      key: "source",
      label: "待发布-素材",
      target: path.resolve(config.workspaceDir, "待发布-素材"),
      confirmation: CLEAR_CONFIRMATIONS.source
    },
    renamed: {
      key: "renamed",
      label: "已重命名-素材",
      target: path.resolve(config.localImageDirectory),
      confirmation: CLEAR_CONFIRMATIONS.renamed
    }
  };
  return targets[key] || null;
}

function validateClearFolderRequest({ folder, confirmation }) {
  const spec = managedFolderSpec(String(folder || ""));
  if (!spec) {
    const error = new Error("只允许清空待发布-素材或已重命名-素材");
    error.statusCode = 400;
    throw error;
  }
  if (confirmation !== spec.confirmation) {
    const error = new Error(`缺少清空“${spec.label}”的明确确认`);
    error.statusCode = 400;
    throw error;
  }

  const workspace = path.resolve(config.workspaceDir);
  if (spec.target === workspace || path.dirname(spec.target) !== workspace) {
    const error = new Error(`拒绝清空非工作区直属目录：${spec.target}`);
    error.statusCode = 400;
    throw error;
  }
  return spec;
}

async function deleteDirectoryContents({ sourceDirectory, folderKey }) {
  const source = path.resolve(sourceDirectory);
  await fsPromises.mkdir(source, { recursive: true });
  const sourceStat = await fsPromises.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`拒绝清空非真实目录：${source}`);
  }

  const entries = await fsPromises.readdir(source, { withFileTypes: true });
  if (!entries.length) {
    return {
      folder: folderKey,
      deleted_entries: 0,
      permanent: true
    };
  }

  let deletedEntries = 0;
  for (const entry of entries) {
    const entryPath = path.resolve(source, entry.name);
    if (path.dirname(entryPath) !== source) {
      throw new Error(`拒绝删除目标目录之外的内容：${entryPath}`);
    }
    await fsPromises.rm(entryPath, { recursive: true, force: false });
    deletedEntries += 1;
  }

  return {
    folder: folderKey,
    deleted_entries: deletedEntries,
    permanent: true
  };
}

async function clearManagedFolder(body) {
  if (activeJob && activeJob.status === "running") {
    const error = new Error("发布器任务运行中，不能清空素材目录");
    error.statusCode = 409;
    throw error;
  }
  if (activeMaintenance) {
    const error = new Error("已有文件夹维护操作正在运行");
    error.statusCode = 409;
    throw error;
  }

  const spec = validateClearFolderRequest(body);
  activeMaintenance = true;
  try {
    return await deleteDirectoryContents({
      sourceDirectory: spec.target,
      folderKey: spec.key
    });
  } finally {
    activeMaintenance = false;
  }
}

function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    action: job.action,
    account: job.account,
    scope: job.scope,
    status: job.status,
    started_at: job.startedAt,
    finished_at: job.finishedAt || null,
    exit_code: job.exitCode,
    output: job.output.slice(-120000)
  };
}

async function buildPanelStatus() {
  let batch = null;
  let batchError = "";
  let ledger = { version: 1, verified: [] };
  let batchConfig = null;

  try {
    batchConfig = JSON.parse(await fsPromises.readFile(config.batchConfigPath, "utf8"));
  } catch (error) {
    batchError = `发布配置不可用：${error.message}`;
  }

  try {
    batch = await loadLocalBatch({
      batchConfigPath: config.batchConfigPath,
      imageDirectory: config.localImageDirectory,
      requireScheduleWindow: true
    });
    ledger = await readLedger(config.ledgerPath);
  } catch (error) {
    batchError = batchError || error.message;
  }

  let alreadyVerified = 0;
  let pending = 0;
  let validation = { status: "FAIL", error: batchError || "batch is unavailable" };

  if (batch) {
    const { items, ...summary } = batch.validation;
    validation = summary;
    alreadyVerified = batch.items.filter((item) => isLedgerVerified(ledger, batch.config.batch_id, item)).length;
    pending = batch.items.length - alreadyVerified;
    batchConfig = batch.config;
  }

  return {
    ok: true,
    panel: {
      host: PANEL_HOST,
      port: PANEL_PORT,
      local_only: true,
      persistent_dry_run: config.dryRun,
      persistent_authorization_present: Boolean(config.authorizedBatchId),
      publish_authorization_mode: "ephemeral-child-process"
    },
    accounts: Object.keys(config.anchors),
    paths: {
      project_root: __dirname,
      workspace: config.workspaceDir,
      source_images: path.join(config.workspaceDir, "待发布-素材"),
      renamed_images: config.localImageDirectory,
      batch_config: config.batchConfigPath,
      ledger: config.ledgerPath,
      screenshots: config.screenshotsDir
    },
    counts: {
      source_images: await countImages(path.join(config.workspaceDir, "待发布-素材")),
      renamed_images: await countImages(config.localImageDirectory),
      already_verified: alreadyVerified,
      pending
    },
    batch: batchConfig,
    validation,
    maintenance_running: activeMaintenance,
    active_job: serializeJob(activeJob),
    last_job: serializeJob(lastJob),
    checked_at: new Date().toISOString()
  };
}

function validatePublishRequest({ requestedBatchId, currentBatchId, confirmed }) {
  if (!currentBatchId) throw new Error("current batch_id is unavailable");
  if (String(requestedBatchId || "").trim() !== currentBatchId) {
    throw new Error("输入的批次 ID 与当前发布配置不一致");
  }
  if (confirmed !== true) {
    throw new Error("必须勾选正式发布确认");
  }
  return currentBatchId;
}

function normalizeScope(value, fallback = "one") {
  if (value === "all" || value === "one") return value;
  return fallback;
}

function buildJobSpec(action, options = {}) {
  const account = String(options.account || "account1");
  if (!Object.prototype.hasOwnProperty.call(config.anchors, account)) {
    throw new Error(`unknown account: ${account}`);
  }

  const env = { ...process.env };
  const script = (name) => path.join(__dirname, "scripts", name);
  let args;
  let scope = "one";

  if (action === "login") {
    env.DOUYIN_LOGIN_WAIT_MS = "900000";
    env.DOUYIN_MAX_LOGIN_WAIT_MS = "1800000";
    env.DOUYIN_LOGIN_UI_WAIT_MS = "120000";
    env.DOUYIN_LOGIN_QR_SETTLE_MS = "10000";
    args = [script("login-check.js"), account];
  } else if (action === "validate") {
    args = [script("local-batch.js"), "validate"];
  } else if (action === "dry-run") {
    scope = normalizeScope(options.scope);
    args = [script("local-batch.js"), "dry-run", "--account", account, scope === "all" ? "--all" : "--limit", scope === "all" ? undefined : "1"].filter(Boolean);
  } else if (action === "reconcile") {
    args = [script("reconcile-local.js"), "--account", account];
  } else if (action === "publish") {
    scope = normalizeScope(options.scope, "all");
    env.DOUYIN_DRY_RUN = "false";
    env.DOUYIN_AUTHORIZED_BATCH_ID = String(options.batchId || "");
    args = [script("local-batch.js"), "publish", "--account", account, scope === "all" ? "--all" : "--limit", scope === "all" ? undefined : "1"].filter(Boolean);
  } else {
    throw new Error(`unsupported action: ${action}`);
  }

  return {
    command: process.execPath,
    args,
    cwd: __dirname,
    env,
    account,
    scope
  };
}

function appendJobOutput(job, chunk) {
  job.output += String(chunk);
  if (job.output.length > MAX_JOB_OUTPUT) {
    job.output = `[前部日志已截断]\n${job.output.slice(-MAX_JOB_OUTPUT)}`;
  }
}

async function startJob(body) {
  if (activeMaintenance) {
    const error = new Error("文件夹维护操作正在运行，请稍后再启动任务");
    error.statusCode = 409;
    throw error;
  }
  if (activeJob && activeJob.status === "running") {
    const error = new Error("已有任务正在运行，请等待当前任务完成");
    error.statusCode = 409;
    throw error;
  }

  const action = String(body.action || "");
  const account = String(body.account || "account1");
  let batchId = "";

  if (action === "publish") {
    const batch = await loadLocalBatch({
      batchConfigPath: config.batchConfigPath,
      imageDirectory: config.localImageDirectory,
      requireScheduleWindow: true
    });
    const ledger = await readLedger(config.ledgerPath);
    const pending = batch.items.filter((item) => !isLedgerVerified(ledger, batch.config.batch_id, item));
    if (!pending.length) throw new Error("当前批次没有待发布条目");
    try {
      batchId = validatePublishRequest({
        requestedBatchId: body.batch_id,
        currentBatchId: batch.config.batch_id,
        confirmed: body.confirmed
      });
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
  }

  const spec = buildJobSpec(action, {
    account,
    scope: body.scope,
    batchId
  });
  const job = {
    id: `${Date.now()}-${++jobSequence}`,
    action,
    account,
    scope: spec.scope,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: `任务已启动：${action} / ${account} / ${spec.scope}\n`
  };

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  job.pid = child.pid;
  activeJob = job;

  child.stdout.on("data", (chunk) => appendJobOutput(job, chunk));
  child.stderr.on("data", (chunk) => appendJobOutput(job, chunk));
  child.on("error", (error) => appendJobOutput(job, `\n启动失败：${error.message}\n`));
  child.on("close", (code) => {
    job.exitCode = code;
    job.status = code === 0 ? "succeeded" : "failed";
    job.finishedAt = new Date().toISOString();
    appendJobOutput(job, `\n任务结束，退出码：${code}\n`);
    lastJob = job;
    activeJob = null;
  });

  return serializeJob(job);
}

function openAllowedFolder(key) {
  const targets = {
    source: path.join(config.workspaceDir, "待发布-素材"),
    renamed: config.localImageDirectory,
    screenshots: config.screenshotsDir
  };
  const target = targets[key];
  if (!target) throw new Error("unknown folder key");
  if (!fs.existsSync(target)) throw new Error(`folder not found: ${target}`);
  const child = spawn("explorer.exe", [target], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return target;
}

async function route(req, res) {
  assertLocalRequest(req);
  const url = new URL(req.url, `http://${req.headers.host || `${PANEL_HOST}:${PANEL_PORT}`}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return serveStatic(res, "control-panel.html");
  }
  if (req.method === "GET" && url.pathname === "/control-panel.css") {
    return serveStatic(res, "control-panel.css");
  }
  if (req.method === "GET" && url.pathname === "/control-panel-client.js") {
    return serveStatic(res, "control-panel-client.js");
  }
  if (req.method === "GET" && url.pathname === "/api/panel/status") {
    return sendJson(res, 200, await buildPanelStatus());
  }
  if (req.method === "POST" && url.pathname === "/api/panel/jobs") {
    const body = await readJsonBody(req);
    return sendJson(res, 202, { ok: true, job: await startJob(body) });
  }
  if (req.method === "POST" && url.pathname === "/api/panel/open-folder") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, path: openAllowedFolder(String(body.folder || "")) });
  }
  if (req.method === "POST" && url.pathname === "/api/panel/clear-folder") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, result: await clearManagedFolder(body) });
  }
  return sendJson(res, 404, { ok: false, error: "not found" });
}

function createControlPanelServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    });
  });
}

function openPanelInBrowser() {
  if (process.platform !== "win32") return;
  const child = spawn("explorer.exe", [`http://${PANEL_HOST}:${PANEL_PORT}/`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
}

if (require.main === module) {
  const server = createControlPanelServer();
  server.listen(PANEL_PORT, PANEL_HOST, () => {
    console.log(`抖音发布控制台：http://${PANEL_HOST}:${PANEL_PORT}/`);
    console.log("该服务仅监听本机地址；关闭此窗口即可停止控制台。");
    if (boolEnv(process.env.PANEL_AUTO_OPEN, true)) openPanelInBrowser();
  });
}

module.exports = {
  buildJobSpec,
  buildPanelStatus,
  clearManagedFolder,
  createControlPanelServer,
  deleteDirectoryContents,
  isAllowedOrigin,
  isLoopbackAddress,
  validateClearFolderRequest,
  validatePublishRequest
};
