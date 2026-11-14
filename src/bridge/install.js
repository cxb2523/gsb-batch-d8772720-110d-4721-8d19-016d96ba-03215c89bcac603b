/**
 * axuse bridge — installer.
 *
 * Registers the native messaging host for Chrome so the extension's
 * connectNative() can reach the hub:
 *   - Windows: writes a batch launcher (cmd.exe relays the native-messaging
 *     stdio pipes faithfully; native messaging manifests need a full
 *     executable — no args allowed — and .bat qualifies) plus the host
 *     manifest to %LOCALAPPDATA%\axuse, registered under HKCU (no admin).
 *   - macOS/Linux: writes a shebang launcher (chmod +x) and the manifest into
 *     the selected Chromium-family browser's NativeMessagingHosts directory.
 *
 * The extension ID is derived from the "key" in the extension manifest
 * (SHA-256 of the DER SPKI, first 32 hex nibbles, 0-f → a-p), so
 * allowed_extensions can never drift from the shipped key.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDir } from "./hub.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = join(HERE, "..", "..", "bridge", "extension");
export const HOST_NAME = "com.axuse.bridge";

export function extensionId() {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const der = Buffer.from(manifest.key, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((h) => "abcdefghijklmnop"[parseInt(h, 16)]).join("");
}

const POSIX_BROWSERS = new Set(["chrome", "edge", "edge-beta", "chromium", "chrome-for-testing", "chrome-beta", "chrome-canary"]);

function normalizeBrowser(browser) {
  const value = String(browser ?? "chrome").trim().toLowerCase();
  if (!POSIX_BROWSERS.has(value)) {
    throw new Error(`Unsupported browser "${browser}". Use chrome, edge, chromium, chrome-for-testing, chrome-beta, chrome-canary, or edge-beta.`);
  }
  if (process.platform === "win32" && !["chrome", "edge", "edge-beta"].includes(value)) {
    throw new Error(`Browser "${value}" is not supported by the Windows native-host installer.`);
  }
  return value;
}

function winRegistryKey(browser) {
  const vendors = {
    chrome: "Google\\Chrome",
    edge: "Microsoft\\Edge",
    "edge-beta": "Microsoft\\Edge Beta",
  };
  return `HKCU\\Software\\${vendors[browser] ?? vendors.chrome}\\NativeMessagingHosts\\${HOST_NAME}`;
}

function otherPosixRegistrationExists(excludedPath) {
  const excluded = resolve(excludedPath);
  for (const browser of POSIX_BROWSERS) {
    const candidate = join(nativeMessagingDir(browser), `${HOST_NAME}.json`);
    if (resolve(candidate) !== excluded && existsSync(candidate)) return true;
  }
  return false;
}

function otherWindowsRegistrationExists(browser) {
  const other = browser === "chrome" ? "edge" : "chrome";
  const result = spawnSync("reg", ["query", winRegistryKey(other)], { encoding: "utf8" });
  return result.status === 0;
}

export function nativeMessagingDir(browser = "chrome") {
  const value = normalizeBrowser(browser);
  if (process.platform === "darwin") {
    const roots = {
      chrome: join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      "chrome-beta": join(homedir(), "Library", "Application Support", "Google", "Chrome Beta", "NativeMessagingHosts"),
      "chrome-canary": join(homedir(), "Library", "Application Support", "Google", "Chrome Canary", "NativeMessagingHosts"),
      edge: join(homedir(), "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
      "edge-beta": join(homedir(), "Library", "Application Support", "Microsoft Edge Beta", "NativeMessagingHosts"),
      chromium: join(homedir(), "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
      "chrome-for-testing": join(homedir(), "Library", "Application Support", "Google", "ChromeForTesting", "NativeMessagingHosts"),
    };
    return roots[value];
  }
  const roots = {
    chrome: join(homedir(), ".config", "google-chrome", "NativeMessagingHosts"),
    "chrome-beta": join(homedir(), ".config", "google-chrome-beta", "NativeMessagingHosts"),
    "chrome-canary": join(homedir(), ".config", "google-chrome-canary", "NativeMessagingHosts"),
    edge: join(homedir(), ".config", "microsoft-edge", "NativeMessagingHosts"),
    "edge-beta": join(homedir(), ".config", "microsoft-edge-beta", "NativeMessagingHosts"),
    chromium: join(homedir(), ".config", "chromium", "NativeMessagingHosts"),
    "chrome-for-testing": join(homedir(), ".config", "google-chrome-for-testing", "NativeMessagingHosts"),
  };
  return roots[value];
}

/**
 * @param {{browser?: "chrome"|"edge"|"chromium"|"chrome-for-testing", stateDir?: string, manifestDir?: string}} [opts]
 * @returns {{hostPath: string, extensionDir: string, extensionId: string, registry?: string}}
 */
export async function installBridge({ browser = "chrome", stateDir, manifestDir } = {}) {
  browser = normalizeBrowser(browser);
  const dir = stateDir ?? bridgeDir();
  mkdirSync(dir, { recursive: true });
  const extId = extensionId();
  const script = join(HERE, "nm-host.js");

  let hostPath;
  let via;
  if (process.platform === "win32") {
    // Batch launcher (empirically proven on Chromium 155/Edge: cmd.exe relays
    // the native-messaging stdio pipes faithfully; a compiled C# shim using
    // Console.OpenStandardInput failed to see Chrome's stdin writes). The
    // manifest "path" must be a full executable — .bat qualifies here.
    // Fallback chain: the installing node first, then PATH node — the
    // launcher keeps working across node upgrades that move the binary.
    const bat = join(dir, "axuse-nm.bat");
    writeFileSync(bat, `@echo off\r\nif exist "${process.execPath}" ("${process.execPath}" "${script}") else (node "${script}")\r\n`);
    hostPath = bat;
    via = "batch launcher";
  } else {
    // Same resilience on POSIX: exec the installing node when it still
    // exists, else whatever node resolves on PATH. `exec` replaces the
    // shell, so a node that starts and exits non-zero never double-runs.
    const launcher = join(dir, "axuse-nm");
    writeFileSync(launcher, `#!/bin/sh\nif [ -x "${process.execPath}" ]; then exec "${process.execPath}" "${script}" "$@"; fi\nexec node "${script}" "$@"\n`);
    chmodSync(launcher, 0o755);
    hostPath = launcher;
    via = "shebang launcher";
  }

  const manifest = {
    name: HOST_NAME,
    description: "axuse bridge — lets an agent harness control this browser via trusted CDP (chrome.debugger), Codex-style.",
    path: hostPath,
    type: "stdio",
    // Both authorization fields: Chrome accepts allowed_extensions (IDs);
    // Edge documents allowed_origins (chrome-extension://ID/ URLs). Carrying
    // both satisfies every Chromium build without drift.
    allowed_extensions: [extId],
    allowed_origins: [`chrome-extension://${extId}/`],
  };

  let registry = null;
  if (process.platform === "win32") {
    const manifestPath = join(dir, `${HOST_NAME}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const key = winRegistryKey(browser);
    const r = spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`reg add failed (${r.status}): ${r.stderr ?? r.stdout}`);
    }
    registry = key;
  } else {
    const targetDir = manifestDir ?? nativeMessagingDir(browser);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2));
    registry = join(targetDir, `${HOST_NAME}.json`);
  }

  return { hostPath, via, extensionDir: EXTENSION_DIR, extensionId: extId, registry, browser };
}

/** Remove the native-host registration (leaves the hub/info file alone). */
export async function uninstallBridge({ browser = "chrome", stateDir, manifestDir } = {}) {
  browser = normalizeBrowser(browser);
  const removed = [];
  const dir = stateDir ?? bridgeDir();
  if (process.platform === "win32") {
    const key = winRegistryKey(browser);
    const r = spawnSync("reg", ["delete", key, "/f"], { encoding: "utf8" });
    if (r.status === 0) removed.push(key);
    if (!otherWindowsRegistrationExists(browser)) {
      for (const f of ["axuse-nm.bat", "axuse-nm.exe", "axuse-nm-shim.cs", `${HOST_NAME}.json`]) {
        const p = join(dir, f);
        try { unlinkSync(p); removed.push(p); } catch {}
      }
    }
  } else {
    const p = join(manifestDir ?? nativeMessagingDir(browser), `${HOST_NAME}.json`);
    try { unlinkSync(p); removed.push(p); } catch {}
    if (!otherPosixRegistrationExists(p)) {
      try { unlinkSync(join(dir, "axuse-nm")); removed.push(join(dir, "axuse-nm")); } catch {}
    }
  }
  return { removed };
}
