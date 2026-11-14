/**
 * Managed browser provisioning — the zero-dep lane from bare Ubuntu to a
 * pinned Chrome-for-Testing: zip extraction (STORE + DEFLATE, exec bits,
 * traversal guard), manifest resolution (injected fetch), install
 * bookkeeping, and discovery wiring in browserCandidates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { unzip } from "../src/core/zip.js";
import { managedBinary, managedBrowserCandidates, managedVersion, resolveDownload } from "../src/core/managed-browser.js";
import { browserCandidates } from "../src/core/cdp.js";

/* ------------------------------------------------- tiny zip builder (test) */

/** Build a minimal PKZip archive: [{name, data, mode?, deflate?}] → Buffer.
 *  Writes local headers + central directory with Unix external attributes. */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = e.deflate ? deflateRawSync(e.data) : Buffer.from(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (fixed, deterministic)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((e.mode ?? 0o644) << 16) >>> 0, 38); // external (unix mode)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ tests */

test("zip: STORE and DEFLATE entries extract byte-exact, dirs created, exec bits restored", () => {
  const dir = mkdtempSync(join(tmpdir(), "axuse-zip-"));
  try {
    const binary = Buffer.from("#!/bin/sh\nexit 0\n");
    const archive = buildZip([
      { name: "chrome-linux64/", data: Buffer.alloc(0), mode: 0o755 },
      { name: "chrome-linux64/chrome", data: binary, mode: 0o755 }, // stored
      { name: "chrome-linux64/notes.txt", data: Buffer.from("hello zip"), deflate: true }, // deflated
      { name: "chrome-linux64/sub/deep.txt", data: Buffer.from("nested"), mode: 0o600 },
    ]);
    const r = unzip(archive, dir);
    assert.equal(r.files, 3, "directories are created, not counted as files");
    assert.deepEqual(readFileSync(join(dir, "chrome-linux64/chrome")), binary);
    assert.equal(readFileSync(join(dir, "chrome-linux64/notes.txt"), "utf8"), "hello zip");
    assert.equal(readFileSync(join(dir, "chrome-linux64/sub/deep.txt"), "utf8"), "nested");
    if (process.platform !== "win32") { // NTFS has no POSIX permission bits to restore
      assert.equal(statSync(join(dir, "chrome-linux64/chrome")).mode & 0o777, 0o755, "exec bit restored from external attrs");
      assert.equal(statSync(join(dir, "chrome-linux64/sub/deep.txt")).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zip: path traversal is refused, corrupt archives fail typed", () => {
  const dir = mkdtempSync(join(tmpdir(), "axuse-zipsec-"));
  try {
    const evil = buildZip([{ name: "../escape.txt", data: Buffer.from("nope") }]);
    assert.throws(() => unzip(evil, dir), /escapes the target directory/);
    assert.throws(() => unzip(Buffer.from("this is not a zip at all......."), dir), /not a zip/);
    assert.ok(!existsSync(join(dir, "..", "escape.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed browser: manifest resolution picks the platform download (injected fetch)", async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes("last-known-good")) {
      return {
        channels: {
          Stable: {
            version: "151.0.7922.173",
            downloads: { chrome: [{ platform: "linux64", url: "https://example/cft.zip" }] },
          },
        },
      };
    }
    throw new Error(`unexpected manifest fetch: ${url}`);
  };
  const r = await resolveDownload({ channel: "Stable", platform: "linux", fetchJson });
  assert.equal(r.url, "https://example/cft.zip");
  assert.equal(r.version, "151.0.7922.173");
  // A channel with no linux64 download fails typed, never guesses.
  await assert.rejects(
    () => resolveDownload({ channel: "Beta", platform: "linux", fetchJson: async () => ({ channels: { Beta: { version: "1", downloads: { chrome: [] } } } }) }),
    /no chrome download/,
  );
});

test("managed browser: candidates and version marker wiring", () => {
  const prev = process.env.AXUSE_MANAGED_BROWSER_DIR;
  const root = mkdtempSync(join(tmpdir(), "axuse-mb-"));
  process.env.AXUSE_MANAGED_BROWSER_DIR = root;
  const prevBrowser = process.env.AXUSE_BROWSER;
  delete process.env.AXUSE_BROWSER;
  try {
    const bin = managedBinary(root); // same managed root as the candidates use
    assert.deepEqual(managedBrowserCandidates({ exists: () => false }), [], "no install → no candidates");
    assert.deepEqual(managedBrowserCandidates({ exists: (p) => p === bin }), [bin], "installed → first-class candidate");
    assert.ok(browserCandidates().includes(bin) === existsSync(bin), "browserCandidates consults the managed path");
    // VERSION marker roundtrip
    assert.equal(managedVersion(root), null);
    writeFileSync(join(root, "VERSION"), "151.0.7922.173\n");
    assert.equal(managedVersion(root), "151.0.7922.173");
  } finally {
    if (prev === undefined) delete process.env.AXUSE_MANAGED_BROWSER_DIR;
    else process.env.AXUSE_MANAGED_BROWSER_DIR = prev;
    if (prevBrowser !== undefined) process.env.AXUSE_BROWSER = prevBrowser;
    rmSync(root, { recursive: true, force: true });
  }
});

/** the full installer against an injected archive: extract → promote →
 *  stamp → executable landing (the failure mode that motivated zip.js),
 *  and the already-installed short-circuit on a second run. */
test("managed browser: install promotes, stamps, lands executable; second run short-circuits", async () => {
  const { installManagedBrowser, managedBinary, managedVersion } = await import("../src/core/managed-browser.js");
  const prev = process.env.AXUSE_MANAGED_BROWSER_DIR;
  const root = mkdtempSync(join(tmpdir(), "axuse-install-"));
  process.env.AXUSE_MANAGED_BROWSER_DIR = root;
  try {
    // The archive layout is whatever this platform's managed binary path says
    // (chrome-linux64/chrome, chrome-win64/chrome.exe, the macOS .app bundle).
    const binRel = relative(root, managedBinary(root)).split(sep).join("/");
    const top = binRel.split("/")[0];
    const archive = buildZip([
      { name: binRel, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
      { name: `${top}/priv.json`, data: Buffer.from("{}") },
    ]);
    const resolve = async () => ({ url: "injected://cft.zip", version: "151.0.0.1", platform: "linux64" });
    const fetchZip = async () => archive;
    const r = await installManagedBrowser({ resolve, fetchZip });
    assert.equal(r.alreadyInstalled, false);
    assert.equal(r.version, "151.0.0.1");
    assert.equal(r.files, 2);
    const bin = managedBinary(root);
    assert.equal(r.binary, bin);
    if (process.platform === "win32") assert.ok(statSync(bin).isFile(), "binary landed (NTFS has no exec bit)");
    else assert.equal(statSync(bin).mode & 0o111, 0o111, "executable after promote");
    assert.equal(managedVersion(root), "151.0.0.1");
    // Same version again → no re-download (fetchZip would throw if called).
    const again = await installManagedBrowser({ resolve, fetchZip: async () => { throw new Error("must not download"); } });
    assert.equal(again.alreadyInstalled, true);
    // New version → re-installs.
    const newer = await installManagedBrowser({
      resolve: async () => ({ url: "injected://cft.zip", version: "152.0.0.0", platform: "linux64" }),
      fetchZip,
    });
    assert.equal(newer.alreadyInstalled, false);
    assert.equal(managedVersion(root), "152.0.0.0");
  } finally {
    if (prev === undefined) delete process.env.AXUSE_MANAGED_BROWSER_DIR;
    else process.env.AXUSE_MANAGED_BROWSER_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
