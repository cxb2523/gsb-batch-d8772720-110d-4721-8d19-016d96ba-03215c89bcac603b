"use strict";

const config = require("../config");
const { dryRunImageText } = require("../douyin");
const {
  isLedgerVerified,
  loadLocalBatch,
  readLedger,
  reconcilePublishedThroughFromLedger,
  writePublishAttempt,
  writeVerifiedLedgerEntry
} = require("../local-batch");

function argumentValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

async function main() {
  const mode = String(process.argv[2] || "validate").toLowerCase();
  if (!["validate", "dry-run", "publish"].includes(mode)) {
    throw new Error("usage: node scripts/local-batch.js <validate|dry-run|publish> [--account account1] [--limit N|--all]");
  }

  const stateSync = await reconcilePublishedThroughFromLedger({
    batchConfigPath: config.batchConfigPath,
    imageDirectory: config.localImageDirectory,
    ledgerPath: config.ledgerPath
  });
  const batch = await loadLocalBatch({
    batchConfigPath: config.batchConfigPath,
    imageDirectory: config.localImageDirectory,
    requireScheduleWindow: true
  });
  const ledger = await readLedger(config.ledgerPath);
  const pending = batch.items.filter(
    (item) => !isLedgerVerified(ledger, batch.config.batch_id, item)
  );

  const { items: validatedItems, ...validationSummary } = batch.validation;
  const summary = {
    ok: true,
    mode,
    validation: validationSummary,
    already_verified: batch.items.length - pending.length,
    pending: pending.length,
    dry_run: config.dryRun,
    published_through_sync: stateSync
  };
  if (mode === "validate") {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (mode === "publish" && config.dryRun) {
    throw new Error("real publish blocked: set DOUYIN_DRY_RUN=false only after a successful dry-run");
  }
  if (mode === "publish" && config.authorizedBatchId !== batch.config.batch_id) {
    throw new Error("real publish blocked: DOUYIN_AUTHORIZED_BATCH_ID must exactly match the current batch_id");
  }

  const defaultLimit = mode === "dry-run" ? 1 : pending.length;
  const limit = process.argv.includes("--all")
    ? pending.length
    : positiveInteger(argumentValue("--limit"), defaultLimit);
  const account = argumentValue("--account", "account1");
  const results = [];

  for (const item of pending.slice(0, limit)) {
    if (mode === "publish") {
      await writePublishAttempt(config.attemptsPath, batch.config.batch_id, item, "started");
    }
    let result;
    try {
      result = await dryRunImageText({
        anchor: account,
        job: item.job,
        jobDir: config.localImageDirectory,
        publish: mode === "publish",
        authorization: config.authorizedBatchId
      });
    } catch (error) {
      if (mode === "publish") {
        await writePublishAttempt(config.attemptsPath, batch.config.batch_id, item, "uncertain", {
          message: error.message
        });
      }
      throw error;
    }
    results.push({ publish_number: item.publish_number, title: item.title, result });

    if (!result.ok) {
      if (mode === "publish") {
        await writePublishAttempt(
          config.attemptsPath,
          batch.config.batch_id,
          item,
          result.status === "publish_result_uncertain" ? "uncertain" : "failed",
          result
        );
      }
      const screenshot = result.screenshot_path ? `; screenshot=${result.screenshot_path}` : "";
      throw new Error(`post ${item.publish_number} failed: ${result.message || result.status}${screenshot}`);
    }
    if (mode === "publish") {
      const verification = result.management_verification;
      await writeVerifiedLedgerEntry(
        config.ledgerPath,
        batch.config.batch_id,
        item,
        verification
      );
      await writePublishAttempt(config.attemptsPath, batch.config.batch_id, item, "verified", result);
    }
  }

  console.log(JSON.stringify({ ...summary, processed: results.length, results }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
