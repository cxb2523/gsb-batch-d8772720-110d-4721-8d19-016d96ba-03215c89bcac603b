"use strict";

const { dryRunImageText } = require("../douyin");
const { recordToDouyinJob } = require("../feishu");

const baseToken = process.argv[2] || process.env.FEISHU_BASE_TOKEN;
const tableId = process.argv[3];
const recordRef = process.argv[4];
const anchor = process.argv[5] || "";

if (!baseToken || !tableId || !recordRef) {
  console.error("usage: node scripts/dry-run-feishu.js <base_token> <table_id> <record_id_or_request_id> [anchor_key]");
  process.exit(1);
}

recordToDouyinJob({ baseToken, tableId, recordId: recordRef })
  .then((built) => dryRunImageText({
    anchor: anchor || built.job.anchor_key,
    job: built.job,
    jobDir: built.local_image_dir
  }).then((result) => ({
    ...result,
    source_record: {
      base_token: baseToken,
      table_id: tableId,
      record_ref: recordRef,
      record_id: built.record_id,
      request_id: built.request_id,
      local_image_dir: built.local_image_dir,
      source_image_count: built.source_image_count
    }
  })))
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
