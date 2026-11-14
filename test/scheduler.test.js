"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OUTCOMES,
  SKIPPED_STATUS,
  countOutcomes,
  dedupeDue,
  evaluatePublishGate,
  scanOnce
} = require("../scripts/scheduler");

function dueItem(overrides = {}) {
  return {
    table_id: "tbl_1",
    record_id: "rec_normal",
    request_id: "req_normal",
    batch_id: "batch-authorized",
    anchor: "account1",
    title: "窗前静听风",
    scheduled_at: "2026-09-02 09:40",
    ...overrides
  };
}

function builtJob(item, overrides = {}) {
  return {
    record_id: item.record_id,
    request_id: item.request_id,
    job: {
      anchor_key: "account1",
      batch_id: item.batch_id,
      title: item.title,
      hashtags: ["#窗边时光", "#通透光影", "#舒适穿搭"],
      music_keyword: "晚风吹雪",
      scheduled_at: new Date(2026, 8, 2, 9, 40)
    },
    local_image_dir: "downloads",
    source_image_count: 1,
    ...overrides
  };
}

async function harness({ items, publish, dryRun = false, authorizedBatchId = "batch-authorized" }) {
  const writes = [];
  const publishes = [];
  const logs = [];
  const errors = [];

  const summary = await scanOnce({
    baseToken: "base-token",
    tableIds: ["tbl_1"],
    dryRun,
    authorizedBatchId,
    listDueRecords: async (_baseToken, tableId) =>
      items.map((item) => ({ ...item, table_id: tableId })),
    buildJob: async ({ recordId, tableId }) => {
      const item = items.find((candidate) => candidate.record_id === recordId);
      return builtJob(item);
    },
    publish: async (args) => {
      publishes.push(args);
      return publish(args, itemFor(args));
    },
    writeRecord: async (baseToken, tableId, recordId, fields) => {
      writes.push({ baseToken, tableId, recordId, fields });
      return { record_id: recordId, fields };
    },
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    now: () => new Date(2026, 7, 26, 10, 0, 0)
  });

  function itemFor(args) {
    return items.find((item) => item.title === args.job.title);
  }

  return { summary, writes, publishes, logs, errors };
}

function writesFor(writes, recordId) {
  return writes.filter((write) => write.recordId === recordId);
}

test("scheduler skips a batch-id mismatch, publishes a normal record, and survives one RPA error", async () => {
  const items = [
    dueItem({
      record_id: "rec_mismatch",
      request_id: "req_mismatch",
      batch_id: "batch-other",
      title: "批次不匹配"
    }),
    dueItem({ record_id: "rec_normal", request_id: "req_normal", title: "正常发布" }),
    dueItem({
      record_id: "rec_rpa_error",
      request_id: "req_rpa_error",
      batch_id: "batch-authorized",
      title: "RPA 报错"
    })
  ];

  const result = await harness({
    items,
    publish: async (args) => {
      if (args.job.title === "RPA 报错") throw new Error("publish clicked then verification timed out");
      return { ok: true, status: "published_verified", publish_result: { url_after_click: "https://douyin.example/item/1" } };
    }
  });
  const { summary, writes, publishes } = result;

  assert.equal(summary.due, 3);
  assert.deepEqual(summary.counts, {
    [OUTCOMES.PUBLISHED]: 1,
    [OUTCOMES.DRY_RUN_COMPLETED]: 0,
    [OUTCOMES.SKIPPED]: 1,
    [OUTCOMES.FAILED]: 1
  });

  const outcomes = summary.results.map((entry) => [entry.record_id, entry.outcome]);
  assert.deepEqual(outcomes, [
    ["rec_mismatch", OUTCOMES.SKIPPED],
    ["rec_normal", OUTCOMES.PUBLISHED],
    ["rec_rpa_error", OUTCOMES.FAILED]
  ]);

  // The batch-id mismatch never reaches browser automation.
  assert.deepEqual(publishes.map((args) => args.job.title), ["正常发布", "RPA 报错"]);
  assert.equal(publishes.length, 2);

  // Mismatch: 发布状态=跳过 with a distinguishable reason carrying both batch IDs.
  const mismatchWrites = writesFor(writes, "rec_mismatch");
  assert.equal(mismatchWrites.length, 1);
  assert.equal(mismatchWrites[0].fields["发布状态"], SKIPPED_STATUS);
  assert.match(mismatchWrites[0].fields["发布失败原因"], /批次号不匹配/);
  assert.match(mismatchWrites[0].fields["发布失败原因"], /记录批次号=batch-other/);
  assert.match(mismatchWrites[0].fields["发布失败原因"], /授权批次号=batch-authorized/);

  // Normal: 发布中 then 已发布, failure reason cleared, link written.
  const normalWrites = writesFor(writes, "rec_normal");
  assert.deepEqual(normalWrites.map((write) => write.fields["发布状态"]), ["发布中", OUTCOMES.PUBLISHED]);
  assert.equal(normalWrites.at(-1).fields["发布失败原因"], "");
  assert.equal(normalWrites.at(-1).fields["抖音作品链接"], "https://douyin.example/item/1");

  // RPA error: 发布中 then 发布失败, no retry.
  const failedWrites = writesFor(writes, "rec_rpa_error");
  assert.deepEqual(failedWrites.map((write) => write.fields["发布状态"]), ["发布中", "发布失败"]);
  assert.match(failedWrites.at(-1).fields["发布失败原因"], /verification timed out/);
  assert.equal(summary.results.find((entry) => entry.record_id === "rec_rpa_error").reason, "publish clicked then verification timed out");

  // Round summary lists every record's table, record id, outcome and reason.
  const summaryLines = result.logs.filter((message) => message.includes("outcome="));
  assert.equal(summaryLines.length, 3);
  assert.match(summaryLines[0], /table=tbl_1 record=rec_mismatch .*outcome=跳过 reason=.*批次号不匹配/);
  assert.match(summaryLines[1], /record=rec_normal .*outcome=已发布/);
  assert.match(summaryLines[2], /record=rec_rpa_error .*outcome=失败 reason=.*verification timed out/);
});

test("persistent dry run skips before automation and never writes back to Feishu", async () => {
  const result = await harness({
    items: [dueItem({ record_id: "rec_dry" })],
    dryRun: true,
    authorizedBatchId: "batch-authorized",
    publish: async () => {
      throw new Error("browser automation must not run under persistent dry run");
    }
  });

  assert.equal(result.publishes.length, 0);
  assert.deepEqual(result.writes, []);
  assert.equal(result.summary.results[0].outcome, OUTCOMES.SKIPPED);
  assert.equal(result.summary.results[0].skip_code, "dry_run_enabled");
  assert.equal(result.summary.results[0].write_back, "suppressed_dry_run");
  assert.match(result.summary.results[0].reason, /持久干跑未关闭/);
  assert.match(result.summary.results[0].reason, /DOUYIN_DRY_RUN=true/);
  assert.match(result.summary.results[0].reason, /记录批次号=batch-authorized/);
  assert.match(result.summary.results[0].reason, /授权批次号=batch-authorized/);
});

test("dry run and batch mismatch produce distinct skip reasons", () => {
  const dryRunGate = evaluatePublishGate({
    dryRun: true,
    recordBatchId: "batch-1",
    authorizedBatchId: "batch-1"
  });
  const mismatchGate = evaluatePublishGate({
    dryRun: false,
    recordBatchId: "batch-1",
    authorizedBatchId: "batch-2"
  });
  assert.equal(dryRunGate.code, "dry_run_enabled");
  assert.equal(mismatchGate.code, "batch_id_mismatch");
  assert.match(dryRunGate.reason, /持久干跑未关闭/);
  assert.match(mismatchGate.reason, /批次号不匹配/);
  assert.notEqual(dryRunGate.reason, mismatchGate.reason);

  const missingGate = evaluatePublishGate({
    dryRun: false,
    recordBatchId: "",
    authorizedBatchId: "batch-2"
  });
  assert.equal(missingGate.code, "batch_id_missing");
  assert.match(missingGate.reason, /批次号不匹配/);

  assert.deepEqual(
    evaluatePublishGate({ dryRun: false, recordBatchId: "batch-1", authorizedBatchId: "batch-1" }),
    { allowed: true, code: "authorized", reason: "" }
  );
});

test("a record is never processed twice within one round", async () => {
  const duplicated = dueItem({ record_id: "rec_dup", request_id: "req_dup", title: "重复记录" });
  const result = await harness({
    items: [duplicated, { ...duplicated }],
    publish: async () => ({ ok: true, status: "published_verified" })
  });

  assert.equal(result.summary.due, 1);
  assert.equal(result.summary.results.length, 1);
  assert.equal(result.publishes.length, 1);
  assert.equal(dedupeDue([duplicated, { ...duplicated }]).length, 1);
});

test("a fresh batch-id mismatch discovered while building the job is still skipped without automation", async () => {
  const item = dueItem({ record_id: "rec_changed", batch_id: "batch-other", title: "读取后变化" });
  const writes = [];
  const publishes = [];
  const summary = await scanOnce({
    baseToken: "base-token",
    tableIds: ["tbl_1"],
    dryRun: false,
    authorizedBatchId: "batch-authorized",
    // Listing already exposes the mismatch; the test forces the second gate to
    // be the one that fires by making the listed value look authorized.
    listDueRecords: async () => [{ ...item, table_id: "tbl_1", batch_id: "batch-authorized" }],
    buildJob: async () => builtJob(item),
    publish: async (args) => {
      publishes.push(args);
      return { ok: true, status: "published_verified" };
    },
    writeRecord: async (_baseToken, tableId, recordId, fields) => {
      writes.push({ tableId, recordId, fields });
    },
    log: () => {},
    logError: () => {}
  });

  assert.equal(publishes.length, 0);
  assert.equal(summary.results[0].outcome, OUTCOMES.SKIPPED);
  assert.match(summary.results[0].reason, /记录批次号=batch-other/);
  assert.equal(writes[0].fields["发布状态"], SKIPPED_STATUS);
});

test("an unwritable 发布中 marker blocks automation so a row cannot be published twice", async () => {
  const publishes = [];
  const writes = [];
  const summary = await scanOnce({
    baseToken: "base-token",
    tableIds: ["tbl_1"],
    dryRun: false,
    authorizedBatchId: "batch-authorized",
    listDueRecords: async (_baseToken, tableId) => [{ ...dueItem(), table_id: tableId }],
    buildJob: async ({ recordId }) => builtJob(dueItem({ record_id: recordId })),
    publish: async (args) => {
      publishes.push(args);
      return { ok: true, status: "published_verified" };
    },
    writeRecord: async (_baseToken, tableId, recordId, fields) => {
      writes.push({ tableId, recordId, fields });
      if (fields["发布状态"] === "发布中") throw new Error("feishu write timeout");
    },
    log: () => {},
    logError: () => {}
  });

  assert.equal(publishes.length, 0);
  assert.equal(summary.results[0].outcome, OUTCOMES.FAILED);
  assert.match(summary.results[0].reason, /发布前置状态写入失败/);
  assert.deepEqual(writes.map((write) => write.fields["发布状态"]), ["发布中", "发布失败"]);
});

test("countOutcomes counts every outcome kind", () => {
  assert.deepEqual(
    countOutcomes([
      { outcome: OUTCOMES.PUBLISHED },
      { outcome: OUTCOMES.SKIPPED },
      { outcome: OUTCOMES.FAILED },
      { outcome: OUTCOMES.DRY_RUN_COMPLETED }
    ]),
    {
      [OUTCOMES.PUBLISHED]: 1,
      [OUTCOMES.DRY_RUN_COMPLETED]: 1,
      [OUTCOMES.SKIPPED]: 1,
      [OUTCOMES.FAILED]: 1
    }
  );
});
