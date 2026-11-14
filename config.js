"use strict";

require("dotenv/config");

const fs = require("fs");
const path = require("path");

function boolEnv(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(value);
}

function numberEnv(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function readLocalConfig(rootDir) {
  const configPath = process.env.PUBLISHER_CONFIG || path.join(rootDir, "config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function normalizeAnchors(rootDir, rawAnchors) {
  const entries = Object.entries(rawAnchors || {});
  const fallback = entries.length
    ? rawAnchors
    : {
        account1: { profileDir: "profiles/account1" },
        account2: { profileDir: "profiles/account2" },
        account3: { profileDir: "profiles/account3" }
      };

  return Object.fromEntries(
    Object.entries(fallback).map(([key, value]) => {
      const configuredDir = String(value.profileDir || "").trim();
      return [
        key,
        {
          key,
          profileDir: configuredDir
            ? (path.isAbsolute(configuredDir) ? configuredDir : path.join(rootDir, configuredDir))
            : path.join(rootDir, "profiles", key)
        }
      ];
    })
  );
}

const rootDir = __dirname;
const localConfig = readLocalConfig(rootDir);
const workspaceDir = path.resolve(process.env.DOUYIN_WORKSPACE_DIR || path.join(rootDir, "workspace"));

module.exports = {
  host: process.env.HOST || "127.0.0.1",
  port: numberEnv("PORT", 3300),
  bridgeSecret: process.env.BRIDGE_SECRET || "",
  headless: boolEnv("DOUYIN_HEADLESS", false),
  dryRun: boolEnv("DOUYIN_DRY_RUN", true),
  defaultLoginWaitMs: numberEnv("DOUYIN_LOGIN_WAIT_MS", 15 * 60 * 1000),
  maxLoginWaitMs: numberEnv("DOUYIN_MAX_LOGIN_WAIT_MS", 30 * 60 * 1000),
  loginUiWaitMs: numberEnv("DOUYIN_LOGIN_UI_WAIT_MS", 2 * 60 * 1000),
  loginQrSettleMs: numberEnv("DOUYIN_LOGIN_QR_SETTLE_MS", 10_000),
  uploadWaitMs: numberEnv("DOUYIN_UPLOAD_WAIT_MS", 90_000),
  contentCheckWaitMs: numberEnv("DOUYIN_CONTENT_CHECK_WAIT_MS", 2 * 60 * 1000),
  managementCheckWaitMs: numberEnv("DOUYIN_MANAGEMENT_CHECK_WAIT_MS", 2 * 60 * 1000),
  actionTimeoutMs: numberEnv("DOUYIN_ACTION_TIMEOUT_MS", 45_000),
  creatorUrl: process.env.DOUYIN_CREATOR_URL || "https://creator.douyin.com/creator-micro/content/upload?default-tab=3&enter_from=publish",
  contentManageUrl: process.env.DOUYIN_CONTENT_MANAGE_URL || "https://creator.douyin.com/creator-micro/content/manage",
  browserChannel: process.env.DOUYIN_BROWSER_CHANNEL || "chrome",
  authorizedBatchId: process.env.DOUYIN_AUTHORIZED_BATCH_ID || "",
  larkApiBase: process.env.LARK_API_BASE || "https://open.feishu.cn",
  defaultBaseToken: process.env.FEISHU_BASE_TOKEN || "",
  screenshotBaseUrl: process.env.SCREENSHOT_BASE_URL || "",
  rootDir,
  workspaceDir,
  localImageDirectory: path.resolve(process.env.DOUYIN_LOCAL_IMAGE_DIR || path.join(workspaceDir, "已重命名-素材")),
  batchConfigPath: path.resolve(process.env.DOUYIN_BATCH_CONFIG || path.join(workspaceDir, "发布配置.json")),
  ledgerPath: path.resolve(process.env.DOUYIN_LEDGER_PATH || path.join(rootDir, ".local-state", "publish-ledger.json")),
  attemptsPath: path.resolve(process.env.DOUYIN_ATTEMPTS_PATH || path.join(rootDir, ".local-state", "publish-attempts.json")),
  anchors: normalizeAnchors(rootDir, localConfig.anchors),
  tableAnchors: localConfig.tableAnchors || {},
  anchorAliases: localConfig.anchorAliases || {},
  screenshotsDir: path.join(rootDir, "screenshots"),
  downloadsDir: path.join(rootDir, "downloads")
};
