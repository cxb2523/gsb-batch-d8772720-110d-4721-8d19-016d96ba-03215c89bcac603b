"use strict";

const config = require("../config");
const { dryRunImageText } = require("../douyin");
const {
  listDuePublishRecords,
  recordToDouyinJob,
  updateRecord
} = require("../feishu");

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS || 60_000);
const processing = new Set();

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function tableIds() {
  const configured = String(process.env.FEISHU_TABLE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : Object.keys(config.tableAnchors);
}

function shortError(error) {
  return String(error?.message || error || "unknown error").slice(0, 500);
}

async function updatePublishFailure(baseToken, tableId, recordId, error) {
  if (config.dryRun) return;
  await updateRecord(baseToken, tableId, recordId, {
    "发布状态": "发布失败",
    "发布失败原因": shortError(error)
  });
}

async function updatePublishProcessing(baseToken, tableId, recordId) {
  if (config.dryRun) return;
  await updateRecord(baseToken, tableId, recordId, {
    "发布状态": "发布中",
    "发布失败原因": ""
  });
}

async function updatePublishSuccess(baseToken, tableId, recordId, result) {
  if (config.dryRun) return;
  await updateRecord(baseToken, tableId, recordId, {
    "发布状态": "已发布",
    "发布失败原因": "",
    "抖音作品链接": result.publish_result?.url_after_click || result.url || ""
  });
}

async function processRecord(baseToken, item) {
  const key = `${item.table_id}:${item.record_id}`;
  if (processing.has(key)) return { skipped: true, reason: "already processing", ...item };
  processing.add(key);

  try {
    console.log(`[${nowText()}] publish candidate ${item.request_id || item.record_id} ${item.anchor} ${item.title}`);
    await updatePublishProcessing(baseToken, item.table_id, item.record_id);

    const built = await recordToDouyinJob({
      baseToken,
      tableId: item.table_id,
      recordId: item.record_id
    });

    const result = await dryRunImageText({
      anchor: built.job.anchor_key,
      job: built.job,
      jobDir: built.local_image_dir,
      publish: true,
      authorization: config.authorizedBatchId
    });

    if (!result.ok) {
      throw new Error(`${result.status || "failed"}: ${result.message || "unknown RPA error"}`);
    }

    await updatePublishSuccess(baseToken, item.table_id, built.record_id, result);
    console.log(
      `[${nowText()}] ${config.dryRun ? "dry-run ok" : "published"} ${built.request_id || built.record_id}`
    );

    return {
      ok: true,
      dry_run: config.dryRun,
      table_id: item.table_id,
      record_id: built.record_id,
      request_id: built.request_id,
      status: result.status,
      screenshot_path: result.screenshot_path
    };
  } catch (error) {
    console.error(`[${nowText()}] publish failed ${item.request_id || item.record_id}: ${shortError(error)}`);
    await updatePublishFailure(baseToken, item.table_id, item.record_id, error).catch((updateError) => {
      console.error(`[${nowText()}] failed to write publish failure: ${shortError(updateError)}`);
    });
    return {
      ok: false,
      table_id: item.table_id,
      record_id: item.record_id,
      request_id: item.request_id,
      error: shortError(error)
    };
  } finally {
    processing.delete(key);
  }
}

async function scanOnce() {
  const baseToken = config.defaultBaseToken;
  if (!baseToken) throw new Error("missing FEISHU_BASE_TOKEN");

  const due = [];
  for (const tableId of tableIds()) {
    const items = await listDuePublishRecords(baseToken, tableId);
    due.push(...items);
  }

  console.log(`[${nowText()}] due records: ${due.length}, dry_run=${config.dryRun}`);
  const results = [];
  for (const item of due) {
    results.push(await processRecord(baseToken, item));
  }
  return results;
}

async function loop() {
  try {
    const results = await scanOnce();
    if (once) {
      console.log(JSON.stringify({ ok: true, results }, null, 2));
      return;
    }
  } catch (error) {
    console.error(`[${nowText()}] scheduler error: ${shortError(error)}`);
    if (once) {
      process.exitCode = 1;
      return;
    }
  }

  setTimeout(loop, Math.max(10_000, intervalMs));
}

loop();
