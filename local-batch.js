"use strict";

const fs = require("fs/promises");
const path = require("path");
const {
  ACCEPTED_MANAGEMENT_STATUSES,
  parseStrictFilename,
  validateBatch
} = require("./publish-policy");

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function loadLocalBatch({ batchConfigPath, imageDirectory, now = new Date(), requireScheduleWindow = true }) {
  const batchConfig = await readJson(batchConfigPath);
  const names = await fs.readdir(imageDirectory);
  const items = names
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .map((name) => parseStrictFilename(path.join(imageDirectory, name)));
  const validation = validateBatch(items, {
    batchId: batchConfig.batch_id,
    startDate: batchConfig.start_date,
    publishedThrough: batchConfig.published_through,
    now,
    requireScheduleWindow
  });

  return {
    config: batchConfig,
    validation,
    items: validation.items.map((item) => ({
      ...item,
      job: {
        batch_id: batchConfig.batch_id,
        image_number: item.image_number,
        publish_number: item.publish_number,
        images: [item.path],
        title: item.title,
        body: "",
        hashtags: item.topics,
        music_keyword: item.bgm,
        artist: item.artist,
        scheduled_at: item.scheduled_at
      }
    }))
  };
}

function ledgerKey(batchId, item) {
  return [batchId, item.publish_number, item.title, item.scheduled_at_text].join("|");
}

async function readLedger(ledgerPath) {
  const ledger = await readJson(ledgerPath, { version: 1, verified: [] });
  if (!Array.isArray(ledger.verified)) ledger.verified = [];
  return ledger;
}

async function readPublishAttempts(attemptsPath) {
  const state = await readJson(attemptsPath, { version: 1, attempts: [] });
  if (!Array.isArray(state.attempts)) state.attempts = [];
  return state;
}

async function writePublishAttempt(attemptsPath, batchId, item, status, details = {}) {
  const state = await readPublishAttempts(attemptsPath);
  const key = ledgerKey(batchId, item);
  const previous = state.attempts.find((entry) => entry.key === key) || {};
  const entry = {
    ...previous,
    key,
    batch_id: batchId,
    image_number: item.image_number,
    publish_number: item.publish_number,
    title: item.title,
    scheduled_at: item.scheduled_at_text,
    status,
    updated_at: new Date().toISOString(),
    screenshot_path: details.screenshot_path || previous.screenshot_path || "",
    message: details.message || previous.message || ""
  };
  if (!entry.created_at) entry.created_at = entry.updated_at;
  state.attempts = state.attempts.filter((current) => current.key !== key);
  state.attempts.push(entry);
  await writeJsonAtomic(attemptsPath, state);
  return entry;
}

function latestRecoverableAttempt(state, batchId) {
  return state.attempts
    .filter((entry) => entry.batch_id === batchId && ["started", "uncertain"].includes(entry.status))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
}

function isLedgerVerified(ledger, batchId, item) {
  const key = ledgerKey(batchId, item);
  return ledger.verified.some(
    (entry) => entry.key === key && ACCEPTED_MANAGEMENT_STATUSES.includes(entry.status)
  );
}

async function writeVerifiedLedgerEntry(ledgerPath, batchId, item, verification) {
  if (!verification || !verification.verified) {
    throw new Error("refusing to write ledger without verified Content Management evidence");
  }
  if (!ACCEPTED_MANAGEMENT_STATUSES.includes(verification.status)) {
    throw new Error(`refusing unaccepted management status: ${verification.status || "(empty)"}`);
  }

  const ledger = await readLedger(ledgerPath);
  const key = ledgerKey(batchId, item);
  const entry = {
    key,
    batch_id: batchId,
    publish_number: item.publish_number,
    title: item.title,
    scheduled_at: item.scheduled_at_text,
    status: verification.status,
    verified_at: new Date().toISOString()
  };
  ledger.verified = ledger.verified.filter((current) => current.key !== key);
  ledger.verified.push(entry);

  await writeJsonAtomic(ledgerPath, ledger);
  return entry;
}

async function reconcilePublishedThroughFromLedger({ batchConfigPath, imageDirectory, ledgerPath }) {
  const batchConfig = await readJson(batchConfigPath);
  const ledger = await readLedger(ledgerPath);
  const names = await fs.readdir(imageDirectory);
  const remainingNumbers = new Set(
    names
      .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
      .map((name) => parseStrictFilename(path.join(imageDirectory, name)).publish_number)
  );
  const verifiedNumbers = new Set(
    ledger.verified
      .filter((entry) => entry.batch_id === batchConfig.batch_id && ACCEPTED_MANAGEMENT_STATUSES.includes(entry.status))
      .map((entry) => Number(entry.publish_number))
      .filter((number) => Number.isInteger(number) && number > 0)
  );

  const before = Number(batchConfig.published_through || 0);
  let after = before;
  while (!remainingNumbers.has(after + 1) && verifiedNumbers.has(after + 1)) after += 1;

  if (after !== before) {
    await writeJsonAtomic(batchConfigPath, { ...batchConfig, published_through: after });
  }
  return { changed: after !== before, before, after };
}

module.exports = {
  isLedgerVerified,
  latestRecoverableAttempt,
  ledgerKey,
  loadLocalBatch,
  readLedger,
  readPublishAttempts,
  reconcilePublishedThroughFromLedger,
  writePublishAttempt,
  writeVerifiedLedgerEntry
};
