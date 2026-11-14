"use strict";

const assert = require("node:assert/strict");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildJobSpec,
  deleteDirectoryContents,
  isAllowedOrigin,
  isLoopbackAddress,
  validateClearFolderRequest,
  validatePublishRequest
} = require("../control-panel");

test("control panel accepts only loopback addresses and its own origin", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.20"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:3400", 3400), true);
  assert.equal(isAllowedOrigin("http://localhost:3400", 3400), true);
  assert.equal(isAllowedOrigin("https://example.com", 3400), false);
});

test("real publishing requires the exact current batch id and explicit confirmation", () => {
  assert.equal(validatePublishRequest({
    requestedBatchId: "batch-123",
    currentBatchId: "batch-123",
    confirmed: true
  }), "batch-123");
  assert.throws(() => validatePublishRequest({
    requestedBatchId: "batch-old",
    currentBatchId: "batch-123",
    confirmed: true
  }), /批次 ID/);
  assert.throws(() => validatePublishRequest({
    requestedBatchId: "batch-123",
    currentBatchId: "batch-123",
    confirmed: false
  }), /勾选/);
});

test("publish job authorization is ephemeral and supports one or all remaining posts", () => {
  const one = buildJobSpec("publish", {
    account: "account1",
    batchId: "batch-123",
    scope: "one"
  });
  assert.equal(one.env.DOUYIN_DRY_RUN, "false");
  assert.equal(one.env.DOUYIN_AUTHORIZED_BATCH_ID, "batch-123");
  assert.deepEqual(one.args.slice(-2), ["--limit", "1"]);
  assert.equal(path.basename(one.command).toLowerCase(), path.basename(process.execPath).toLowerCase());

  const all = buildJobSpec("publish", {
    account: "account1",
    batchId: "batch-123",
    scope: "all"
  });
  assert.equal(all.args.at(-1), "--all");
});

test("dry-run job never overrides the persistent production gate", () => {
  const spec = buildJobSpec("dry-run", { account: "account1", scope: "one" });
  assert.deepEqual(spec.args.slice(-2), ["--limit", "1"]);
  assert.notEqual(spec.env.DOUYIN_DRY_RUN, "false");
  assert.throws(() => buildJobSpec("publish", { account: "unknown", batchId: "batch" }), /unknown account/);
});

test("reconciliation is a separate read-only recovery command", () => {
  const spec = buildJobSpec("reconcile", { account: "account1" });
  assert.equal(path.basename(spec.args[0]), "reconcile-local.js");
  assert.deepEqual(spec.args.slice(-2), ["--account", "account1"]);
  assert.notEqual(spec.env.DOUYIN_DRY_RUN, "false");
  assert.equal(spec.env.DOUYIN_AUTHORIZED_BATCH_ID || "", "");
});

test("folder clearing accepts only the two fixed folders with exact confirmations", () => {
  const source = validateClearFolderRequest({
    folder: "source",
    confirmation: "CLEAR_SOURCE_IMAGES"
  });
  const renamed = validateClearFolderRequest({
    folder: "renamed",
    confirmation: "CLEAR_RENAMED_IMAGES"
  });
  assert.equal(source.label, "待发布-素材");
  assert.equal(renamed.label, "已重命名-素材");
  assert.throws(() => validateClearFolderRequest({
    folder: "screenshots",
    confirmation: "CLEAR_SOURCE_IMAGES"
  }), /只允许清空/);
  assert.throws(() => validateClearFolderRequest({
    folder: "source",
    confirmation: "CLEAR_RENAMED_IMAGES"
  }), /明确确认/);
});

test("folder clearing permanently deletes all contents but preserves the source directory", async (t) => {
  const testRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "douyin-panel-clear-"));
  t.after(async () => {
    await fsPromises.rm(testRoot, { recursive: true, force: true });
  });
  const source = path.join(testRoot, "source");
  await fsPromises.mkdir(path.join(source, "nested"), { recursive: true });
  await fsPromises.writeFile(path.join(source, "photo.jpg"), "test");
  await fsPromises.writeFile(path.join(source, "nested", "note.txt"), "test");

  const result = await deleteDirectoryContents({
    sourceDirectory: source,
    folderKey: "source"
  });

  assert.equal(result.deleted_entries, 2);
  assert.equal(result.permanent, true);
  assert.deepEqual(await fsPromises.readdir(source), []);
  await assert.rejects(fsPromises.access(path.join(source, "photo.jpg")), { code: "ENOENT" });
  await assert.rejects(fsPromises.access(path.join(source, "nested", "note.txt")), { code: "ENOENT" });
  assert.equal("recovery_path" in result, false);

  const emptyResult = await deleteDirectoryContents({
    sourceDirectory: source,
    folderKey: "source"
  });
  assert.equal(emptyResult.deleted_entries, 0);
  assert.equal(emptyResult.permanent, true);
});

test("folder clearing removes an internal directory link without deleting its external target", async (t) => {
  const testRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "douyin-panel-link-"));
  t.after(async () => {
    await fsPromises.rm(testRoot, { recursive: true, force: true });
  });
  const source = path.join(testRoot, "source");
  const outside = path.join(testRoot, "outside");
  const link = path.join(source, "linked-directory");
  await fsPromises.mkdir(source);
  await fsPromises.mkdir(outside);
  await fsPromises.writeFile(path.join(outside, "keep.txt"), "keep");
  try {
    await fsPromises.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = await deleteDirectoryContents({ sourceDirectory: source, folderKey: "source" });
  assert.equal(result.deleted_entries, 1);
  assert.deepEqual(await fsPromises.readdir(source), []);
  assert.equal(await fsPromises.readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
});

test("control panel describes permanent clearing and no longer exposes the recycle shortcut", async () => {
  const client = await fsPromises.readFile(path.join(__dirname, "..", "public", "control-panel-client.js"), "utf8");
  const html = await fsPromises.readFile(path.join(__dirname, "..", "public", "control-panel.html"), "utf8");
  assert.match(client, /永久清空/);
  assert.match(client, /不会进入项目回收区/);
  assert.doesNotMatch(client, /E:\\\\AI-图-素材/);
  assert.doesNotMatch(html, /E:\\AI-图-素材/);
  assert.doesNotMatch(html, /data-folder="recycle"/);
});

test("Windows launcher detects an existing healthy panel without starting a duplicate server", async () => {
  const launcher = await fsPromises.readFile(path.join(__dirname, "..", "control-panel.cmd"), "utf8");
  assert.match(launcher, /Invoke-RestMethod[^\r\n]+api\/panel\/status/);
  assert.match(launcher, /\$status\.ok -eq \$true/);
  assert.doesNotMatch(launcher, /\^\|/);
  assert.match(launcher, /goto :already_running/);
  assert.match(launcher, /Control panel exited with code/);
  assert.match(launcher, /pause/);
});
