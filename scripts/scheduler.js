"use strict";

const config = require("../config");
const { dryRunImageText } = require("../douyin");
const {
  listDuePublishRecords,
  recordToDouyinJob,
  updateRecord
} = require("../feishu");

const OUTCOMES = Object.freeze({
  PUBLISHED: "已发布",
  DRY_RUN_COMPLETED: "干跑完成",
  SKIPPED: "跳过",
  FAILED: "失败"
});

const SKIPPED_STATUS = "跳过";

function nowText(date = new Date()) {
  return date.toLocaleString("zh-CN", { hour12: false });
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

function batchIdText(recordBatchId, authorizedBatchId) {
  const record = String(recordBatchId ?? "").trim();
  const authorized = String(authorizedBatchId ?? "").trim();
  return `记录批次号=${record || "(空)"}，授权批次号=${authorized || "(空)"}`;
}

function skipReasonFor(code, recordBatchId, authorizedBatchId) {
  const ids = batchIdText(recordBatchId, authorizedBatchId);
  if (code === "dry_run_enabled") {
    return `跳过：持久干跑未关闭（DOUYIN_DRY_RUN=true），未执行浏览器自动化；${ids}`;
  }
  if (code === "batch_id_missing") {
    return `跳过：批次号不匹配，记录批次号为空，无法确认发布授权；${ids}`;
  }
  return `跳过：批次号不匹配，DOUYIN_AUTHORIZED_BATCH_ID 必须与记录批次号完全一致，未执行浏览器自动化；${ids}`;
}

/**
 * Decide whether a due record may be published. This gate runs before any
 * browser automation so a blocked record can never touch Playwright.
 */
function evaluatePublishGate({ dryRun, recordBatchId, authorizedBatchId }) {
  if (dryRun) {
    return { allowed: false, code: "dry_run_enabled", reason: skipReasonFor("dry_run_enabled", recordBatchId, authorizedBatchId) };
  }
  const recordBatch = String(recordBatchId ?? "").trim();
  const authorized = String(authorizedBatchId ?? "").trim();
  if (!recordBatch) {
    return { allowed: false, code: "batch_id_missing", reason: skipReasonFor("batch_id_missing", recordBatchId, authorizedBatchId) };
  }
  if (recordBatch !== authorized) {
    return { allowed: false, code: "batch_id_mismatch", reason: skipReasonFor("batch_id_mismatch", recordBatchId, authorizedBatchId) };
  }
  return { allowed: true, code: "authorized", reason: "" };
}

function createDependencies(overrides = {}) {
  return {
    dryRun: overrides.dryRun === undefined ? config.dryRun : Boolean(overrides.dryRun),
    authorizedBatchId:
      overrides.authorizedBatchId === undefined ? config.authorizedBatchId : overrides.authorizedBatchId,
    baseToken: overrides.baseToken === undefined ? config.defaultBaseToken : overrides.baseToken,
    tableIds: overrides.tableIds || tableIds(),
    listDueRecords: overrides.listDueRecords || listDuePublishRecords,
    buildJob: overrides.buildJob || recordToDouyinJob,
    publish: overrides.publish || dryRunImageText,
    writeRecord: overrides.writeRecord || updateRecord,
    inFlight: overrides.inFlight || new Set(),
    now: overrides.now || (() => new Date()),
    log: overrides.log || ((message) => console.log(message)),
    logError: overrides.logError || ((message) => console.error(message))
  };
}

function baseOutcome(item, outcome, reason, extra = {}) {
  return {
    table_id: item.table_id,
    record_id: item.record_id,
    request_id: item.request_id,
    outcome,
    reason: reason || "",
    ...extra
  };
}

async function writeRecordSafe(deps, item, fields, label) {
  if (deps.dryRun) return "";
  try {
    await deps.writeRecord(deps.baseToken, item.table_id, item.record_id, fields);
    return "";
  } catch (error) {
    const message = shortError(error);
    deps.logError(`[${nowText(deps.now())}] failed to write ${label} for ${item.request_id || item.record_id}: ${message}`);
    return message;
  }
}

async function markPublishing(deps, item) {
  try {
    await deps.writeRecord(deps.baseToken, item.table_id, item.record_id, {
      "发布状态": "发布中",
      "发布失败原因": ""
    });
  } catch (error) {
    throw new Error(`发布前置状态写入失败，未执行浏览器自动化: ${shortError(error)}`);
  }
}

async function skipRecord(deps, item, gate, reason = gate.reason) {
  const writeError = await writeRecordSafe(
    deps,
    item,
    {
      "发布状态": SKIPPED_STATUS,
      "发布失败原因": reason
    },
    "skip"
  );
  deps.log(
    `[${nowText(deps.now())}] skipped ${item.request_id || item.record_id} (${item.table_id}): ${reason}`
  );
  return baseOutcome(item, OUTCOMES.SKIPPED, reason, {
    skip_code: gate.code,
    write_back: writeError ? "failed" : deps.dryRun ? "suppressed_dry_run" : "ok",
    write_error: writeError || undefined
  });
}

async function processRecord(deps, item) {
  const key = `${item.table_id}:${item.record_id}`;
  if (deps.inFlight.has(key)) {
    return baseOutcome(item, OUTCOMES.SKIPPED, "同一轮内该记录正在处理，未重复执行", {
      skip_code: "duplicate_in_round",
      write_back: "none"
    });
  }
  deps.inFlight.add(key);

  try {
    const gate = evaluatePublishGate({
      dryRun: deps.dryRun,
      recordBatchId: item.batch_id,
      authorizedBatchId: deps.authorizedBatchId
    });
    if (!gate.allowed) return await skipRecord(deps, item, gate);

    deps.log(
      `[${nowText(deps.now())}] publish candidate ${item.request_id || item.record_id} ${item.anchor} ${item.title}`
    );

    const built = await deps.buildJob({
      baseToken: deps.baseToken,
      tableId: item.table_id,
      recordId: item.record_id
    });
    const recordId = built.record_id || item.record_id;

    // The record may have changed between listing and reading it back. Re-run
    // the gate against the freshly read batch ID before any browser work.
    const freshGate = evaluatePublishGate({
      dryRun: deps.dryRun,
      recordBatchId: built.job?.batch_id,
      authorizedBatchId: deps.authorizedBatchId
    });
    if (!freshGate.allowed) {
      return await skipRecord(
        deps,
        { ...item, record_id: recordId, request_id: built.request_id || item.request_id },
        freshGate
      );
    }

    // If the "发布中" marker cannot be persisted, abort before any browser
    // work: otherwise the row stays "待发布" and the next round would publish a
    // possibly already-submitted record again.
    await markPublishing(deps, item);

    const result = await deps.publish({
      anchor: built.job.anchor_key,
      job: built.job,
      jobDir: built.local_image_dir,
      publish: true,
      authorization: deps.authorizedBatchId
    });

    if (!result || result.ok !== true) {
      throw new Error(`${result?.status || "failed"}: ${result?.message || "unknown RPA error"}`);
    }

    const completedDryRun = result.dry_run === true || result.status === "dry_run_completed";
    const outcome = completedDryRun ? OUTCOMES.DRY_RUN_COMPLETED : OUTCOMES.PUBLISHED;
    // A dry-run result must never write Feishu state. If a dry-run result shows
    // up after the "发布中" marker, restore the row so a later round can retry;
    // nothing was submitted in that case.
    const writeError = completedDryRun
      ? await writeRecordSafe(
        deps,
        { ...item, record_id: recordId },
        { "发布状态": "待发布", "发布失败原因": "" },
        "dry-run restore"
      )
      : await writeRecordSafe(
        deps,
        { ...item, record_id: recordId },
        {
          "发布状态": OUTCOMES.PUBLISHED,
          "发布失败原因": "",
          "抖音作品链接": result.publish_result?.url_after_click || result.url || ""
        },
        "publish success"
      );

    deps.log(
      `[${nowText(deps.now())}] ${completedDryRun ? "dry-run completed" : "published"} ${built.request_id || recordId}`
    );

    return baseOutcome(
      { ...item, record_id: recordId, request_id: built.request_id || item.request_id },
      outcome,
      completedDryRun ? result.message || "dry-run completed" : "",
      {
        dry_run: completedDryRun,
        status: result.status,
        screenshot_path: result.screenshot_path,
        write_back: completedDryRun ? "suppressed_dry_run" : writeError ? "failed" : "ok",
        write_error: writeError || undefined
      }
    );
  } catch (error) {
    const reason = shortError(error);
    deps.logError(`[${nowText(deps.now())}] publish failed ${item.request_id || item.record_id}: ${reason}`);
    const writeError = await writeRecordSafe(
      deps,
      item,
      { "发布状态": "发布失败", "发布失败原因": reason },
      "publish failure"
    );
    return baseOutcome(item, OUTCOMES.FAILED, reason, {
      error: reason,
      write_back: writeError ? "failed" : deps.dryRun ? "suppressed_dry_run" : "ok",
      write_error: writeError || undefined
    });
  } finally {
    deps.inFlight.delete(key);
  }
}

function countOutcomes(results) {
  const counts = {
    [OUTCOMES.PUBLISHED]: 0,
    [OUTCOMES.DRY_RUN_COMPLETED]: 0,
    [OUTCOMES.SKIPPED]: 0,
    [OUTCOMES.FAILED]: 0
  };
  for (const result of results) {
    if (counts[result.outcome] === undefined) counts[result.outcome] = 0;
    counts[result.outcome] += 1;
  }
  return counts;
}

function logRoundSummary(deps, results) {
  const counts = countOutcomes(results);
  deps.log(
    `[${nowText(deps.now())}] round complete: ${results.length} record(s) — ` +
      `${OUTCOMES.PUBLISHED}=${counts[OUTCOMES.PUBLISHED]}, ` +
      `${OUTCOMES.DRY_RUN_COMPLETED}=${counts[OUTCOMES.DRY_RUN_COMPLETED]}, ` +
      `${OUTCOMES.SKIPPED}=${counts[OUTCOMES.SKIPPED]}, ` +
      `${OUTCOMES.FAILED}=${counts[OUTCOMES.FAILED]}`
  );
  for (const result of results) {
    deps.log(
      `[${nowText(deps.now())}] table=${result.table_id} record=${result.record_id}` +
        `${result.request_id ? ` request_id=${result.request_id}` : ""} ` +
        `outcome=${result.outcome} reason=${result.reason || "-"}`
    );
  }
}

function dedupeDue(due) {
  const seen = new Set();
  const unique = [];
  for (const item of due) {
    const key = `${item.table_id}:${item.record_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function scanOnce(overrides = {}) {
  const deps = createDependencies(overrides);
  if (!deps.baseToken) throw new Error("missing FEISHU_BASE_TOKEN");

  const due = [];
  for (const tableId of deps.tableIds) {
    const items = await deps.listDueRecords(deps.baseToken, tableId);
    for (const item of items) due.push({ ...item, table_id: item.table_id || tableId });
  }
  const uniqueDue = dedupeDue(due);

  deps.log(`[${nowText(deps.now())}] due records: ${uniqueDue.length}, dry_run=${deps.dryRun}`);

  const results = [];
  for (const item of uniqueDue) {
    results.push(await processRecord(deps, item));
  }

  logRoundSummary(deps, results);
  return {
    due: uniqueDue.length,
    dry_run: deps.dryRun,
    counts: countOutcomes(results),
    results
  };
}

async function loop() {
  const once = process.argv.includes("--once");
  const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS || 60_000);

  while (true) {
    try {
      const summary = await scanOnce();
      if (once) {
        console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
        return;
      }
    } catch (error) {
      console.error(`[${nowText()}] scheduler error: ${shortError(error)}`);
      if (once) {
        process.exitCode = 1;
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(10_000, intervalMs)));
  }
}

if (require.main === module) {
  loop();
}

module.exports = {
  OUTCOMES,
  SKIPPED_STATUS,
  batchIdText,
  countOutcomes,
  createDependencies,
  dedupeDue,
  evaluatePublishGate,
  processRecord,
  scanOnce,
  shortError,
  skipReasonFor
};
