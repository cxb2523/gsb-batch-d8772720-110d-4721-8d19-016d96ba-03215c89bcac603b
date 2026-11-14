import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserHandle, browserCandidates } from "../src/core/cdp.js";
import { Codes } from "../src/core/errors.js";

test("macOS browser candidates distinguish branded Chrome from extension-capable builds", { skip: process.platform !== "darwin" }, async () => {
  assert.ok(browserCandidates({ browser: "chromium", ignoreEnv: true }).some((p) => /Chromium\.app/.test(p)));
  assert.ok(browserCandidates({ browser: "chrome-for-testing", ignoreEnv: true }).some((p) => /Chrome for Testing\.app/.test(p)));
  assert.ok(browserCandidates({ browser: "chrome", exact: true, ignoreEnv: true }).every((p) => /Google Chrome\.app/.test(p)));
  const extension = browserCandidates({ extensionCapable: true, ignoreEnv: true });
  assert.ok(extension.every((p) => !/Google Chrome\.app/.test(p)), extension.join("\n"));
  assert.ok(extension.some((p) => /Microsoft Edge|Chromium|Chrome for Testing/.test(p)));
});

test("browser candidates cover preview channels (beta/canary) per platform", () => {
  const all = browserCandidates({ ignoreEnv: true });
  // Each platform's Edge Beta preview path shape (macOS .app bundle,
  // Windows "Edge Beta" install dir, Linux distro package name).
  const edgeBetaShape = process.platform === "win32" ? /Microsoft\\Edge Beta\\Application\\msedge\.exe$/
    : process.platform === "darwin" ? /Microsoft Edge Beta\.app/
      : /\/microsoft-edge-beta$/;
  if (process.platform === "darwin") {
    assert.ok(browserCandidates({ browser: "chrome-beta", ignoreEnv: true }).some((p) => /Chrome Beta\.app/.test(p)));
    assert.ok(browserCandidates({ browser: "chrome-canary", ignoreEnv: true }).some((p) => /Chrome Canary\.app/.test(p)));
    assert.ok(browserCandidates({ browser: "edge-beta", ignoreEnv: true }).some((p) => /Microsoft Edge Beta\.app/.test(p)));
    // Unpinned discovery tries preview channels after stable + CfT.
    assert.ok(all.findIndex((p) => /Chrome Beta\.app/.test(p)) > all.findIndex((p) => /Chrome for Testing\.app/.test(p)),
      "preview channels rank AFTER the stable automation builds");
  } else if (process.platform === "win32") {
    // Windows installs Beta under "Chrome Beta" and Canary under "Chrome SxS".
    assert.ok(browserCandidates({ browser: "chrome-beta", ignoreEnv: true }).some((p) => /Google\\Chrome Beta\\Application\\chrome\.exe$/.test(p)));
    assert.ok(browserCandidates({ browser: "chrome-canary", ignoreEnv: true }).some((p) => /Google\\Chrome SxS\\Application\\chrome\.exe$/.test(p)));
  } else {
    assert.ok(browserCandidates({ browser: "chrome-beta", ignoreEnv: true }).some((p) => /chrome-beta/i.test(p)));
  }
  // The extension-capable lane excludes EVERY branded Chrome channel
  // (stable, Beta, Canary — all ignore --load-extension; live-verified on
  // macOS .app builds AND google-chrome-stable 151 on Ubuntu) and includes
  // Edge Beta, which honors it.
  const extension = browserCandidates({ extensionCapable: true, ignoreEnv: true });
  assert.ok(extension.every((p) => !/Google Chrome( Beta| Dev| Canary)?\.app\/Contents\/MacOS\/Google Chrome( Beta| Dev| Canary)?$/.test(p)), "no branded Chrome channel in the extension lane");
  if (process.platform === "linux") {
    assert.ok(extension.every((p) => !/^\/usr\/bin\/google-chrome(-stable|-beta|-unstable)?$/.test(p)), "no branded Linux Chrome package in the extension lane");
    assert.ok(extension.some((p) => /\/chromium$/.test(p)) && extension.some((p) => /chrome-for-testing$/.test(p)), "chromium + CfT join the extension lane");
  }
  assert.ok(extension.some((p) => edgeBetaShape.test(p)), `Edge Beta joins the extension lane (${process.platform})`);
});

test("isMacBrandedChrome-classified env overrides cannot defeat the extension lane", () => {
  if (process.platform !== "darwin") return;
  const saved = process.env.AXUSE_BROWSER;
  for (const exe of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ]) {
    process.env.AXUSE_BROWSER = exe;
    assert.ok(browserCandidates({ extensionCapable: true }).every((p) => p !== exe), `AXUSE_BROWSER=${exe} must not leak into the extension lane`);
  }
  // A non-branded override still wins the lane.
  process.env.AXUSE_BROWSER = "/opt/side-installed/Chromium.app/Contents/MacOS/Chromium";
  assert.ok(browserCandidates({ extensionCapable: true }).every((p) => p !== "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
  if (saved === undefined) delete process.env.AXUSE_BROWSER;
  else process.env.AXUSE_BROWSER = saved;
});

test("branded-Chrome env overrides cannot defeat the extension lane (linux paths)", () => {
  if (process.platform !== "linux") return;
  const saved = process.env.AXUSE_BROWSER;
  // Branded distro packages must not leak into the lane…
  for (const exe of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]) {
    process.env.AXUSE_BROWSER = exe;
    assert.ok(browserCandidates({ extensionCapable: true }).every((p) => p !== exe), `AXUSE_BROWSER=${exe} must not leak into the extension lane`);
  }
  // …but a Chrome-for-Testing override still wins it.
  process.env.AXUSE_BROWSER = "/tmp/cft/chrome-linux64/chrome";
  assert.deepEqual(browserCandidates({ extensionCapable: true }), ["/tmp/cft/chrome-linux64/chrome"]);
  if (saved === undefined) delete process.env.AXUSE_BROWSER;
  else process.env.AXUSE_BROWSER = saved;
});

test("browser launch reports a typed spawn failure instead of an unhandled child error", async () => {
  const profileRoot = mkdtempSync(join(tmpdir(), "axuse launch failure-"));
  try {
    await assert.rejects(
      () => BrowserHandle.launch({ executablePath: "/definitely/not-an-axuse-browser", profileRoot }),
      (e) => e.code === Codes.LAUNCH_FAILED && /Could not start browser/.test(e.message),
    );
    assert.deepEqual(readdirSync(profileRoot), [], "failed startup must remove its ephemeral profile");
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
});
