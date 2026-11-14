"use strict";

const { loginCheck } = require("../douyin");

const anchor = process.argv[2] || process.env.DOUYIN_ANCHOR_KEY || "account1";
const configuredWait = process.env.DOUYIN_LOGIN_WAIT_MS;
const waitForLoginMs = configuredWait == null || configuredWait === ""
  ? undefined
  : Number(configuredWait);

loginCheck({ anchor, waitForLoginMs })
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.logged_in) {
      console.error("Login was not completed before the timeout.");
      process.exitCode = 2;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
