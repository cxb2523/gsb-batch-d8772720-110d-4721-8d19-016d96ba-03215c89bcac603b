"use strict";

const fs = require("fs");
const path = require("path");
const { dryRunImageText } = require("../douyin");

const anchor = process.argv[2] || process.env.DOUYIN_ANCHOR_KEY || "account1";
const jobPath = path.resolve(process.argv[3] || "test-job.json");
const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));

dryRunImageText({
  anchor,
  job,
  jobDir: path.dirname(jobPath)
})
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
