/**
 * axuse — managed browser provisioning: a pinned Chrome-for-Testing build
 * under ~/.cache/axuse, no sudo, no apt repo, no system unzip.
 *
 * Why: the server lane starts from a bare Ubuntu box. Installing distro
 * Chrome means Google's apt repo + root; CfT is the same engine in a
 * self-contained directory. `axuse install-browser` downloads the
 * channel's current stable build (or --version NNN to pin a fleet), and
 * browserCandidates() picks the managed build up automatically so nothing
 * else changes. AXUSE_MANAGED_BROWSER_DIR relocates it (containers often
 * mount a cached volume there — fleets download once, run everywhere).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unzip } from "./zip.js";

const MANIFEST = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const PLATFORMS = { linux: "linux64", darwin: "mac-x64", win32: "win64" };
const darwinArm = process.arch === "arm64";
export const MANAGED_ROOT_DEFAULT = () =>
  process.env.AXUSE_MANAGED_BROWSER_DIR || join(homedir(), ".cache", "axuse", "browsers");

/** The Chrome binary path of a managed install root. */
export function managedBinary(root = MANAGED_ROOT_DEFAULT()) {
  if (process.platform === "darwin") {
    const name = darwinArm ? "chrome-mac-arm64" : "chrome-mac-x64";
    return join(root, name, darwinArm ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  }
  if (process.platform === "win32") return join(root, "chrome-win64", "chrome.exe");
  return join(root, "chrome-linux64", "chrome");
}

/** Candidate paths for the browser finder: the managed install when its
 *  binary exists (also in the extension-capable lane — CfT honors
 *  --load-extension, unlike branded distro builds). */
export function managedBrowserCandidates({ exists = existsSync } = {}) {
  const bin = managedBinary();
  return exists(bin) ? [bin] : [];
}

/** The pinned version of the current managed install (marker file), or null. */
export function managedVersion(root = MANAGED_ROOT_DEFAULT()) {
  try { return String(readFileSync(join(root, "VERSION"), "utf8")).trim() || null; } catch { return null; }
}

/** Fetch the download manifest and resolve the URL for this platform. */
export async function resolveDownload({ channel = "Stable", version, platform = process.platform, fetchJson } = {}) {
  const get = fetchJson ?? (async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`manifest ${r.status}`); return r.json(); });
  const manifest = await get(MANIFEST);
  const plat = platform === "darwin" && darwinArm ? "mac-arm64" : PLATFORMS[platform];
  if (!plat) throw new Error(`no Chrome-for-Testing platform mapping for ${platform}`);
  if (version) {
    // Pinned fleet build: the per-version manifest lists the same shape.
    const exact = await get(`https://googlechromelabs.github.io/chrome-for-testing/latest-patch-versions-per-build.json`)
      .catch(() => null);
    const patch = exact?.builds?.[version];
    if (!patch) throw new Error(`version ${version} not found in the CfT patch-version manifest`);
    const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${plat}/chrome-${plat}.zip`;
    return { url, version, platform: plat };
  }
  const ch = manifest.channels[channel];
  if (!ch) throw new Error(`channel "${channel}" not in the CfT manifest`);
  const hit = ch.downloads.chrome.find((d) => d.platform === plat);
  if (!hit) throw new Error(`CfT ${channel} has no chrome download for ${plat}`);
  return { url: hit.url, version: ch.version, platform: plat };
}

/** Download `url` into memory with a progress hook (fetched in chunks). */
export async function downloadZip(url, { onProgress, timeoutMs = 900_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    const parts = [];
    let got = 0;
    for await (const chunk of res.body) {
      parts.push(Buffer.from(chunk));
      got += chunk.length;
      if (onProgress) onProgress(got, total);
    }
    return Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
  }
}

/** Install (or verify) the managed browser build. `resolve`/`fetchZip` are
 *  injectable seams (tests drive the promote/stamp logic without the
 *  160 MB network path). Returns install facts. */
export async function installManagedBrowser({ channel = "Stable", version, onProgress, onEntry, resolve = resolveDownload, fetchZip = downloadZip } = {}) {
  const { url, version: resolved } = await resolve({ channel, version });
  const root = MANAGED_ROOT_DEFAULT();
  const bin = managedBinary(root);
  if (existsSync(bin) && managedVersion(root) === resolved) {
    return { alreadyInstalled: true, root, binary: bin, version: resolved };
  }
  mkdirSync(root, { recursive: true });
  const archive = await fetchZip(url, { onProgress });
  const tmpRoot = join(root, ".partial");
  const { files, bytes } = unzip(archive, tmpRoot, { onEntry });
  // Promote atomically-ish: extract into .partial, then move payload dirs
  // into the root and stamp the version marker last.
  const { renameSync, readdirSync, rmSync } = await import("node:fs");
  for (const name of ["chrome-linux64", "chrome-mac", "chrome-mac-arm64", "chrome-win64"]) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(tmpRoot)) {
    renameSync(join(tmpRoot, name), join(root, name));
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  writeFileSync(join(root, "VERSION"), `${resolved}\n`);
  if (!existsSync(bin)) throw new Error(`install finished but ${bin} is missing — archive layout changed?`);
  const st = statSync(bin);
  return { alreadyInstalled: false, root, binary: bin, version: resolved, files, bytes, mode: st.mode & 0o777 };
}
