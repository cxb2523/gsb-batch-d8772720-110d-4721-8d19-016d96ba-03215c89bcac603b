"use strict";

const fs = require("node:fs/promises");

const config = require("../config");
const {
  inspectContentManagement,
  openAnchorContext,
  resolveAnchor
} = require("../douyin");
const {
  latestRecoverableAttempt,
  readPublishAttempts,
  reconcilePublishedThroughFromLedger,
  writePublishAttempt,
  writeVerifiedLedgerEntry
} = require("../local-batch");

function argumentValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function buildExplicitAttempt(batchId) {
  const publishNumber = Number(argumentValue("--publish-number"));
  const title = argumentValue("--title").trim();
  const scheduledAt = argumentValue("--scheduled-at").trim();
  if (!publishNumber && !title && !scheduledAt) return null;
  if (!Number.isInteger(publishNumber) || publishNumber <= 0) {
    throw new Error("--publish-number must be a positive integer");
  }
  if (!title) throw new Error("--title is required for explicit reconciliation");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(scheduledAt)) {
    throw new Error("--scheduled-at must use YYYY-MM-DD HH:mm");
  }
  return {
    batch_id: batchId,
    image_number: publishNumber,
    publish_number: publishNumber,
    title,
    scheduled_at: scheduledAt,
    status: "uncertain"
  };
}

async function main() {
  const account = argumentValue("--account", "account1");
  const batchConfig = JSON.parse(await fs.readFile(config.batchConfigPath, "utf8"));
  const attemptsState = await readPublishAttempts(config.attemptsPath);
  const attempt = buildExplicitAttempt(batchConfig.batch_id)
    || latestRecoverableAttempt(attemptsState, batchConfig.batch_id);
  if (!attempt) {
    throw new Error("no uncertain publish attempt is available for reconciliation");
  }
  if (attempt.batch_id !== batchConfig.batch_id) {
    throw new Error("uncertain attempt does not belong to the current batch");
  }

  const item = {
    image_number: Number(attempt.image_number || attempt.publish_number),
    publish_number: Number(attempt.publish_number),
    title: attempt.title,
    scheduled_at_text: attempt.scheduled_at
  };
  await writePublishAttempt(
    config.attemptsPath,
    batchConfig.batch_id,
    item,
    "uncertain",
    { message: "read-only Content Management reconciliation requested" }
  );

  const anchorConfig = resolveAnchor(account);
  const context = await openAnchorContext(anchorConfig);
  try {
    const page = context.pages()[0] || await context.newPage();
    const verification = await inspectContentManagement(page, {
      title: item.title,
      scheduled_at: item.scheduled_at_text
    }, config.managementCheckWaitMs);

    if (!verification.verified) {
      console.log(JSON.stringify({
        ok: false,
        status: "still_uncertain",
        publish_number: item.publish_number,
        title: item.title,
        verification,
        message: "No matching title, scheduled time, and accepted status were jointly verified. Nothing was republished."
      }, null, 2));
      process.exitCode = 2;
      return;
    }

    const ledgerEntry = await writeVerifiedLedgerEntry(
      config.ledgerPath,
      batchConfig.batch_id,
      item,
      verification
    );
    await writePublishAttempt(config.attemptsPath, batchConfig.batch_id, item, "verified", {
      message: "verified by read-only Content Management reconciliation"
    });
    const stateSync = await reconcilePublishedThroughFromLedger({
      batchConfigPath: config.batchConfigPath,
      imageDirectory: config.localImageDirectory,
      ledgerPath: config.ledgerPath
    });

    console.log(JSON.stringify({
      ok: true,
      status: "reconciled_verified",
      publish_number: item.publish_number,
      title: item.title,
      verification,
      ledger_entry: ledgerEntry,
      published_through_sync: stateSync,
      republished: false
    }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
