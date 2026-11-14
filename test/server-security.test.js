"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isLoopbackHost,
  isUsableBridgeSecret,
  secretsEqual,
  validateServerSecurity
} = require("../server");

test("HTTP bridge defaults may run without a secret only on loopback", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.equal(isLoopbackHost(host), true);
    assert.doesNotThrow(() => validateServerSecurity({ host, bridgeSecret: "" }));
  }
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.throws(
    () => validateServerSecurity({ host: "0.0.0.0", bridgeSecret: "" }),
    /BRIDGE_SECRET/
  );
  assert.throws(
    () => validateServerSecurity({ host: "192.0.2.10", bridgeSecret: "change-me-now-please" }),
    /BRIDGE_SECRET/
  );
  assert.doesNotThrow(() => validateServerSecurity({
    host: "0.0.0.0",
    bridgeSecret: "example-only-strong-secret"
  }));
});

test("bridge secret validation rejects placeholders and compares exact values", () => {
  assert.equal(isUsableBridgeSecret(""), false);
  assert.equal(isUsableBridgeSecret("change-me-before-use"), false);
  assert.equal(isUsableBridgeSecret("short"), false);
  assert.equal(isUsableBridgeSecret("example-only-strong-secret"), true);
  assert.equal(secretsEqual("same-secret-value", "same-secret-value"), true);
  assert.equal(secretsEqual("same-secret-value", "different-value"), false);
  assert.equal(secretsEqual(undefined, "same-secret-value"), false);
});
