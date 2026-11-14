"use strict";

const http = require("node:http");
const config = require("../config");

const request = http.get({
  host: "127.0.0.1",
  port: config.port,
  path: "/health",
  timeout: 3000
}, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    body += chunk;
  });
  response.on("end", () => {
    try {
      const result = JSON.parse(body);
      if (response.statusCode === 200 && result.ok === true) {
        console.log(`douyin-rpa-publisher is running on http://127.0.0.1:${config.port}`);
        process.exit(0);
      }
    } catch {
      // The non-zero exit below is the public health-check contract.
    }
    console.error(`Health check failed with HTTP ${response.statusCode || "unknown"}.`);
    process.exit(1);
  });
});

request.on("timeout", () => request.destroy(new Error("health check timed out")));
request.on("error", (error) => {
  console.error(`Health check failed: ${error.message}`);
  process.exit(1);
});
