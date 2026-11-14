"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { isPathInside, normalizeFiles } = require("../douyin");
const { hasExpectedImageSignature, isForbiddenIpAddress } = require("../feishu");

test("remote image downloads reject private and reserved network addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.10.0.5",
    "169.254.169.254",
    "172.20.1.2",
    "192.168.1.5",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1"
  ]) {
    assert.equal(isForbiddenIpAddress(address), true, address);
  }
  assert.equal(isForbiddenIpAddress("8.8.8.8"), false);
  assert.equal(isForbiddenIpAddress("2606:4700:4700::1111"), false);
});

test("downloaded image content must match the declared image type", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  const webp = Buffer.from("RIFF0000WEBP", "ascii");
  assert.equal(hasExpectedImageSignature(png, "image/png"), true);
  assert.equal(hasExpectedImageSignature(jpeg, "image/jpeg"), true);
  assert.equal(hasExpectedImageSignature(webp, "image/webp"), true);
  assert.equal(hasExpectedImageSignature(Buffer.from("not an image"), "image/png"), false);
});

test("local image path containment rejects sibling traversal", () => {
  const root = path.join(os.tmpdir(), "publisher-workspace");
  assert.equal(isPathInside(path.join(root, "已重命名-素材", "one.png"), root), true);
  assert.equal(isPathInside(path.join(os.tmpdir(), "publisher-workspace-copy", "one.png"), root), false);
  assert.deepEqual(
    normalizeFiles(["test-assets/cover.png"], path.resolve(__dirname, "..")),
    [path.resolve(__dirname, "..", "test-assets", "cover.png")]
  );
  assert.throws(() => normalizeFiles([], root), /exactly 1 image/);
});
