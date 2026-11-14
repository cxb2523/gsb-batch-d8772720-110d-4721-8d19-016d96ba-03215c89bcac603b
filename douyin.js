"use strict";

const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const config = require("./config");
const {
  ACCEPTED_MANAGEMENT_STATUSES,
  assertPublishAuthorization,
  formatScheduleTime,
  validateJob
} = require("./publish-policy");

function resolveAnchor(anchor) {
  const key = String(anchor || "").trim().toLowerCase();
  const found = config.anchors[key];
  if (!found) {
    const allowed = Object.keys(config.anchors);
    const hint = key.includes("?")
      ? ` The request body looks garbled. Use ASCII anchor_key/profile: ${allowed.join(", ")}.`
      : "";
    throw new Error(`unknown anchor: ${key || "(empty)"}. allowed: ${allowed.join(", ")}.${hint}`);
  }
  return found;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureDirs() {
  await fs.mkdir(config.screenshotsDir, { recursive: true });
  await fs.mkdir(config.downloadsDir, { recursive: true });
  for (const anchor of Object.values(config.anchors)) {
    await fs.mkdir(anchor.profileDir, { recursive: true });
  }
}

async function classifyLogin(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const qrcodeCount = await page
    .locator('img[src*="qrcode" i], img[class*="qrcode" i], [class*="qrcode" i] img')
    .count()
    .catch(() => 0);
  const loginInputCount = await page
    .locator('input[type="tel"], input[type="password"], input[autocomplete*="tel" i]')
    .count()
    .catch(() => 0);
  const interactiveCount = await page
    .locator('button, a, [role="button"], input, textarea')
    .count()
    .catch(() => 0);

  const isCreatorHome = /creator\.douyin\.com\/creator-micro\/home/i.test(url);
  const isCreatorPage = /creator\.douyin\.com/i.test(url) && !/login|passport|sso/i.test(url);
  const hasChineseLoginText =
    bodyText.includes("\u626b\u7801\u767b\u5f55") ||
    bodyText.includes("验证码登录") ||
    bodyText.includes("密码登录") ||
    bodyText.includes("登录/注册") ||
    bodyText.includes("创作者登录") ||
    bodyText.includes("我是创作者") ||
    bodyText.includes("\u8bf7\u767b\u5f55") ||
    bodyText.includes("\u83b7\u53d6\u9a8c\u8bc1\u7801") ||
    bodyText.includes("\u767b\u5f55\u6296\u97f3");
  const hasChineseCreatorText =
    bodyText.includes("\u5185\u5bb9\u7ba1\u7406") ||
    bodyText.includes("\u4f5c\u54c1\u7ba1\u7406") ||
    bodyText.includes("\u53d1\u5e03\u56fe\u6587") ||
    bodyText.includes("上传图片");

  const hasLoginHints =
    /login|passport|sso/i.test(url) ||
    (!isCreatorHome && (qrcodeCount > 0 || loginInputCount > 0)) ||
    /(login|qrcode|captcha|verify|sms)/i.test(bodyText) ||
    hasChineseLoginText;
  const hasRenderedLoginUi = qrcodeCount > 0 || loginInputCount > 0 || hasChineseLoginText;

  const hasCreatorHints =
    (isCreatorHome || isCreatorPage) &&
    (hasChineseCreatorText || (isCreatorHome && interactiveCount > 5 && !hasChineseLoginText));

  return {
    loggedIn: hasCreatorHints && !hasLoginHints,
    url,
    title,
    hasLoginHints,
    hasRenderedLoginUi,
    hasCreatorHints,
    qrcodeCount,
    loginInputCount,
    interactiveCount
  };
}

async function waitForCreatorDom(page, timeout = 20_000) {
  return page.waitForFunction(() => {
    const body = document.body;
    if (!body) return false;
    const text = (body.innerText || "").trim();
    const interactive = body.querySelectorAll("button, a, [role='button'], input, textarea").length;
    return text.length >= 10 || interactive > 0;
  }, { timeout }).then(() => true).catch(() => false);
}

async function dismissKnownPopups(page) {
  await page
    .evaluate(() => {
      const labels = [
        "\u6211\u77e5\u9053\u4e86",
        "\u77e5\u9053\u4e86",
        "\u5173\u95ed",
        "\u53d6\u6d88",
        "\u5b8c\u6210",
        "\u786e\u5b9a"
      ];
      function visible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], a")).filter(visible);
      for (const item of candidates) {
        const text = (item.textContent || "").trim();
        if (labels.some((label) => text.includes(label))) {
          item.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

async function closeMusicPanelIfOpen(page) {
  if (!(await musicPanelIsOpen(page).catch(() => false))) {
    return { closed: false, reason: "music panel was not open" };
  }

  const attempts = [];

  async function check(method) {
    await page.waitForTimeout(800);
    const open = await musicPanelIsOpen(page).catch(() => false);
    if (!open) return { closed: true, method };
    return null;
  }

  await page.keyboard.press("Escape").catch((error) => attempts.push(`escape: ${error.message}`));
  const escaped = await check("escape");
  if (escaped) return escaped;

  const clicked = await page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const textLabels = [
      "\u53d6\u6d88",
      "\u5b8c\u6210",
      "\u786e\u5b9a",
      "\u5173\u95ed"
    ];
    const textButtons = Array.from(document.querySelectorAll("button, [role='button'], a, div, span"))
      .filter(visible)
      .filter((el) => {
        const text = (el.textContent || "").trim();
        return textLabels.some((label) => text === label || text.includes(label));
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, score: rect.y < 180 ? 1000 : 0 + rect.x };
      })
      .sort((a, b) => b.score - a.score);

    if (textButtons[0]) {
      textButtons[0].el.click();
      return "text-button";
    }

    const closeSelectors = [
      "[aria-label*='\u5173\u95ed']",
      "[class*='close']",
      "[class*='Close']"
    ];
    for (const selector of closeSelectors) {
      const item = Array.from(document.querySelectorAll(selector)).find(visible);
      if (item) {
        item.click();
        return selector;
      }
    }

    return "";
  }).catch((error) => {
    attempts.push(`js-close: ${error.message}`);
    return "";
  });

  if (clicked) {
    const closed = await check(clicked);
    if (closed) return closed;
  }

  await page.keyboard.press("Escape").catch((error) => attempts.push(`escape-2: ${error.message}`));
  const escapedAgain = await check("escape-2");
  if (escapedAgain) return escapedAgain;

  return {
    closed: false,
    reason: "music panel may still be open",
    attempts
  };
}

async function waitForLoginIfRequested(page, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let state = await classifyLogin(page);
  while (!state.loggedIn && Date.now() < deadline) {
    await page.waitForTimeout(3000);
    state = await classifyLogin(page);
  }
  return state;
}

async function waitForCreatorLoginResolution(page, timeoutMs = config.actionTimeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let state = await classifyLogin(page);
  while (!state.loggedIn && !state.hasRenderedLoginUi && Date.now() < deadline) {
    await page.waitForTimeout(2000);
    state = await classifyLogin(page);
  }
  return state;
}

async function waitForLoginUiReady(page, timeoutMs = config.loginUiWaitMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let state = await classifyLogin(page);

  while (
    !state.loggedIn &&
    !state.hasRenderedLoginUi &&
    Date.now() < deadline
  ) {
    await page.waitForTimeout(2000);
    state = await classifyLogin(page);
  }

  const ready =
    state.loggedIn ||
    state.hasRenderedLoginUi;

  if (!state.loggedIn && ready && config.loginQrSettleMs > 0) {
    await page.waitForTimeout(config.loginQrSettleMs);
    state = await classifyLogin(page);
  }

  return { ready, state };
}

function screenshotPublicUrl(filename) {
  if (!config.screenshotBaseUrl) return `/screenshots/${filename}`;
  return `${config.screenshotBaseUrl.replace(/\/$/, "")}/screenshots/${filename}`;
}

async function openAnchorContext(anchorConfig) {
  const options = {
    headless: config.headless,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-notifications",
      "--no-default-browser-check",
      "--start-maximized"
    ]
  };
  if (config.browserChannel && config.browserChannel !== "chromium") {
    options.channel = config.browserChannel;
  }
  const context = await chromium.launchPersistentContext(anchorConfig.profileDir, options);
  context.setDefaultTimeout(config.actionTimeoutMs);
  context.setDefaultNavigationTimeout(Math.max(config.actionTimeoutMs, 60_000));
  return context;
}

async function createScreenshot(page, prefix) {
  const screenshotFile = `${prefix}-${safeTimestamp()}.png`;
  const screenshotPath = path.join(config.screenshotsDir, screenshotFile);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return {
    screenshot: screenshotPublicUrl(screenshotFile),
    screenshot_path: screenshotPath
  };
}

async function loginCheck({ anchor, waitForLoginMs } = {}) {
  await ensureDirs();
  const anchorConfig = resolveAnchor(anchor || Object.keys(config.anchors)[0] || "account1");
  const requestedWaitMs = Number.isFinite(Number(waitForLoginMs))
    ? Number(waitForLoginMs)
    : config.defaultLoginWaitMs;
  const waitMs = Math.max(0, Math.min(requestedWaitMs, config.maxLoginWaitMs));

  const context = await openAnchorContext(anchorConfig);

  let page = context.pages()[0] || await context.newPage();
  let loginState;
  let loginUiReady = false;
  let shot;
  try {
    await page.goto(config.creatorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForCreatorDom(page);
    const loginUi = await waitForLoginUiReady(page);
    loginUiReady = loginUi.ready;
    loginState = loginUi.state.loggedIn
      ? loginUi.state
      : await waitForLoginIfRequested(page, waitMs);
    await dismissKnownPopups(page);
    await page.waitForTimeout(800);

    shot = await createScreenshot(page, `${anchorConfig.key}-login-check`);
  } finally {
    await context.close();
  }

  return {
    ok: true,
    anchor: anchor || anchorConfig.key,
    profile: anchorConfig.key,
    profile_dir: anchorConfig.profileDir,
    logged_in: loginState.loggedIn,
    login_ui_ready: loginUiReady,
    login_wait_ms: waitMs,
    login_ui_wait_ms: config.loginUiWaitMs,
    login_qr_settle_ms: config.loginQrSettleMs,
    dry_run: config.dryRun,
    headless: config.headless,
    url: loginState.url,
    title: loginState.title,
    has_login_hints: loginState.hasLoginHints,
    has_rendered_login_ui: loginState.hasRenderedLoginUi,
    has_creator_hints: loginState.hasCreatorHints,
    qrcode_count: loginState.qrcodeCount,
    login_input_count: loginState.loginInputCount,
    interactive_count: loginState.interactiveCount,
    ...shot
  };
}

function normalizeFiles(files, jobDir) {
  if (!Array.isArray(files) || files.length !== 1) {
    throw new Error(`exactly 1 image is required per post; received ${Array.isArray(files) ? files.length : 0}`);
  }
  return files.map((file) => {
    const value = String(file || "").trim();
    if (!value) throw new Error("job.images contains empty path");
    return path.isAbsolute(value) ? value : path.resolve(jobDir || process.cwd(), value);
  });
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function allowedImageRoots() {
  const configuredRoots = [
    config.workspaceDir,
    config.localImageDirectory,
    config.downloadsDir,
    path.join(config.rootDir, "test-assets")
  ];
  return Promise.all(configuredRoots.map(async (root) => {
    const resolved = path.resolve(root);
    return fs.realpath(resolved).catch(() => resolved);
  }));
}

async function validateImageFilePaths(files) {
  const roots = await allowedImageRoots();
  const validated = [];
  for (const file of files) {
    const realFile = await fs.realpath(file);
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) throw new Error(`image path is not a regular file: ${path.basename(file)}`);
    if (!roots.some((root) => isPathInside(realFile, root))) {
      throw new Error(`image path is outside the configured workspace: ${path.basename(file)}`);
    }
    validated.push(realFile);
  }
  return validated;
}

async function assertFilesExist(files) {
  for (const file of files) {
    await fs.access(file);
  }
}

async function clickFirstVisibleText(page, texts, timeout = 3000) {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: false }).first();
    try {
      await locator.click({ timeout });
      return text;
    } catch {
      // Try next text candidate.
    }
  }
  return "";
}

async function clickVisibleExactText(page, text, timeout = 3000, fromLast = false) {
  const matches = page.getByText(text, { exact: true });
  const count = await matches.count().catch(() => 0);
  const indexes = Array.from({ length: count }, (_, index) => index);
  if (fromLast) indexes.reverse();
  for (const index of indexes) {
    const locator = matches.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;
    try {
      await locator.click({ timeout });
      return { clicked: true, index, text };
    } catch {
      // Try the next exact visible match.
    }
  }
  return { clicked: false, text };
}

async function openImageTextPublisher(page) {
  await page.goto(config.creatorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForCreatorDom(page);
  await dismissKnownPopups(page);

  const directUploadReady = await page
    .locator('input[type="file"]')
    .count()
    .then((count) => count > 0)
    .catch(() => false);
  const directText = await pageBodyText(page);
  if (directUploadReady || directText.includes("上传图片") || directText.includes("点击上传")) {
    return "direct-upload-url";
  }

  const clicked = await clickFirstVisibleText(page, [
    "\u53d1\u5e03\u56fe\u6587",
    "\u56fe\u6587",
    "\u9ad8\u6e05\u53d1\u5e03"
  ], 8000);

  if (!clicked) {
    throw new Error("could not find Douyin image-text publish entry");
  }

  if (clicked !== "\u53d1\u5e03\u56fe\u6587") {
    await page.waitForTimeout(1000);
    await clickFirstVisibleText(page, ["\u53d1\u5e03\u56fe\u6587", "\u56fe\u6587"], 5000);
  }

  await page.waitForTimeout(3000);
  return clicked;
}

async function uploadImages(page, files) {
  await assertFilesExist(files);

  const inputs = page.locator('input[type="file"][accept*="image" i], input[type="file"]:not([accept])');
  const count = await inputs.count();
  let lastError = null;
  for (let index = 0; index < count; index += 1) {
    try {
      await inputs.nth(index).setInputFiles(files, { timeout: 20_000 });
    } catch (error) {
      lastError = error;
      continue;
    }
    const verification = await verifySingleImageUpload(page);
    return { input_index: index, file_count: files.length, verification };
  }

  try {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 })
      .then((chooser) => ({ chooser }))
      .catch((error) => ({ error }));
    const clicked = await clickFirstVisibleText(page, [
      "\u4e0a\u4f20\u56fe\u7247",
      "\u70b9\u51fb\u4e0a\u4f20",
      "\u4e0a\u4f20",
      "\u6dfb\u52a0\u56fe\u7247"
    ], 5000);
    if (!clicked) {
      await chooserPromise;
      throw new Error("no upload trigger found");
    }
    const chooserResult = await chooserPromise;
    if (chooserResult.error) throw chooserResult.error;
    const chooser = chooserResult.chooser;
    await chooser.setFiles(files);
    const verification = await verifySingleImageUpload(page);
    return { input_index: -1, file_count: files.length, trigger: clicked, verification };
  } catch (error) {
    const directInputDetail = lastError ? `; direct input error: ${lastError.message}` : "";
    throw new Error(`failed to upload images: ${error.message}${directInputDetail}`);
  }
}

async function verifySingleImageUpload(
  page,
  { timeoutMs = config.uploadWaitMs, pollMs = 2000 } = {}
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let evidence;

  do {
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const normalizedBodyText = bodyText.replace(/\s+/g, "");
    const addedOne = normalizedBodyText.includes("已添加1张图片");
    const hasPreviewUi = ["继续添加", "编辑图片", "清空并重新上传"]
      .some((text) => normalizedBodyText.includes(text));
    evidence = {
      added_one: addedOne,
      preview_count: hasPreviewUi ? 1 : 0
    };

    if (evidence.added_one && evidence.preview_count === 1) return evidence;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.max(100, Math.min(pollMs, deadline - Date.now())));
  } while (Date.now() <= deadline);

  throw new Error(
    `upload verification failed after ${Math.max(0, Number(timeoutMs) || 0)}ms: ` +
    `added_one=${evidence.added_one} preview_count=${evidence.preview_count}`
  );
}

async function fillEditableByHints(page, hints, value, fallbackIndex = 0) {
  if (!value) return { filled: false, reason: "empty value" };
  const result = await page.evaluate(
    ({ hints, value, fallbackIndex }) => {
      function visible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      function setValue(el, text) {
        el.focus();
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          el.value = text;
        } else {
          el.textContent = text;
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const all = Array.from(document.querySelectorAll("input:not([type='file']), textarea, [contenteditable='true']"))
        .filter(visible);

      const byHint = all.find((el) => {
        const haystack = [
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.getAttribute("data-placeholder"),
          el.textContent
        ].filter(Boolean).join(" ");
        return hints.some((hint) => haystack.includes(hint));
      });

      const target = byHint || all[fallbackIndex] || all[0];
      if (!target) return { filled: false, reason: "no editable target", candidates: 0 };
      setValue(target, value);
      return {
        filled: true,
        tag: target.tagName,
        placeholder: target.getAttribute("placeholder") || "",
        candidates: all.length,
        used_hint: Boolean(byHint)
      };
    },
    { hints, value, fallbackIndex }
  );
  await page.waitForTimeout(500);
  return result;
}

async function readEditableValue(locator) {
  const tag = await locator.evaluate((el) => el.tagName).catch(() => "");
  if (tag === "INPUT" || tag === "TEXTAREA") {
    return locator.inputValue({ timeout: 1000 }).catch(() => "");
  }
  return locator.evaluate((el) => (el.textContent || "").trim()).catch(() => "");
}

function normalizeRichTextForVerification(value) {
  return String(value || "").replace(/[\s\u200B-\u200D\uFEFF]+/gu, "");
}

function editableValuesMatch(actual, expected, comparison) {
  if (comparison === "rich-text") {
    return normalizeRichTextForVerification(actual) === normalizeRichTextForVerification(expected);
  }
  return actual.trim() === expected.trim();
}

async function fillLocatorAndVerify(page, locator, value, method, comparison = "exact") {
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await locator.click({ timeout: 3000 });
  await locator.fill("");
  await locator.fill(value);
  await page.waitForTimeout(300);

  let actual = await readEditableValue(locator);
  if (editableValuesMatch(actual, value, comparison)) {
    return { filled: true, verified: true, method, value: actual };
  }

  await locator.click({ timeout: 3000 });
  await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await locator.type(value, { delay: 15 });
  await page.waitForTimeout(500);

  actual = await readEditableValue(locator);
  return {
    filled: actual.trim().length > 0,
    verified: editableValuesMatch(actual, value, comparison),
    method: `${method}+type-fallback`,
    value: actual
  };
}

async function fillTitle(page, title) {
  if (!title) return { filled: false, verified: false, reason: "empty title" };

  const titleHints = [
    "\u6dfb\u52a0\u4f5c\u54c1\u6807\u9898",
    "\u4f5c\u54c1\u6807\u9898",
    "\u6dfb\u52a0\u6807\u9898",
    "\u6807\u9898"
  ];

  for (const hint of titleHints) {
    const locator = page.getByPlaceholder(hint, { exact: false }).first();
    if (await locator.count().catch(() => 0)) {
      const result = await fillLocatorAndVerify(page, locator, title, `placeholder:${hint}`);
      if (result.verified) return result;
    }
  }

  const marked = await page.evaluate((hints) => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const all = Array.from(document.querySelectorAll("input:not([type='file']), textarea, [contenteditable='true']"))
      .filter(visible);

    const target = all.find((el) => {
      const haystack = [
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("data-placeholder"),
        el.textContent
      ].filter(Boolean).join(" ");
      return hints.some((hint) => haystack.includes(hint));
    });
    if (!target) return false;
    target.setAttribute("data-rpa-title-target", "1");
    return true;
  }, titleHints);

  if (marked) {
    const locator = page.locator('[data-rpa-title-target="1"]').first();
    const result = await fillLocatorAndVerify(page, locator, title, "dom-hint");
    if (result.verified) return result;
  }

  const fallback = page.locator("input:not([type='file'])").first();
  if (await fallback.count().catch(() => 0)) {
    return fillLocatorAndVerify(page, fallback, title, "first-visible-input");
  }

  return { filled: false, verified: false, reason: "title input not found" };
}

async function fillDescription(page, value) {
  if (!value) return { filled: false, verified: false, reason: "empty description" };
  const hints = ["添加作品描述", "作品描述", "添加描述", "描述", "正文", "文案"];
  for (const hint of hints) {
    const locator = page.getByPlaceholder(hint, { exact: false }).first();
    if (await locator.count().catch(() => 0)) {
      const result = await fillLocatorAndVerify(page, locator, value, `placeholder:${hint}`, "rich-text");
      if (result.verified) return result;
    }
  }

  const editables = page.locator('[contenteditable="true"]:visible');
  const editableCount = await editables.count().catch(() => 0);
  if (editableCount) {
    const fallbackIndex = editableCount > 1 ? 1 : 0;
    return fillLocatorAndVerify(
      page,
      editables.nth(fallbackIndex),
      value,
      `contenteditable:${fallbackIndex}`,
      "rich-text"
    );
  }
  return { filled: false, verified: false, reason: "description editor not found" };
}

function pickMusicKeyword(job = {}) {
  const explicit = String(
    job.music_keyword ||
    job.musicKeyword ||
    job.music ||
    job["\u97f3\u4e50\u5173\u952e\u8bcd"] ||
    ""
  ).trim();
  if (explicit) return { keyword: explicit, source: "job" };
  throw new Error("explicit BGM name is required; random music fallback is disabled");
}

async function fillMusicSearch(page, keyword) {
  const hints = ["\u641c\u7d22\u97f3\u4e50", "\u641c\u7d22\u6b4c\u66f2", "\u641c\u7d22", "\u8f93\u5165\u97f3\u4e50"];

  for (const hint of hints) {
    const locator = page.getByPlaceholder(hint, { exact: false }).first();
    if (await locator.count().catch(() => 0)) {
      await locator.click({ timeout: 3000 });
      await locator.fill("");
      await locator.fill(keyword);
      await locator.press("Enter").catch(() => {});
      await page.waitForTimeout(2500);
      const hasResults = await page
        .locator("body")
        .innerText({ timeout: 1000 })
        .then((text) => text.includes("\u4eba\u4f7f\u7528") || text.includes("\u4f7f\u7528") || text.includes("\u00b7"))
        .catch(() => false);
      return { filled: true, method: `placeholder:${hint}`, results_visible: hasResults };
    }
  }

  const marked = await page.evaluate((hints) => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const target = Array.from(document.querySelectorAll("input:not([type='file']), textarea"))
      .filter(visible)
      .find((el) => {
        const haystack = [
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.getAttribute("data-placeholder")
        ].filter(Boolean).join(" ");
        return hints.some((hint) => haystack.includes(hint));
      });

    if (!target) return false;
    target.setAttribute("data-rpa-music-search", "1");
    return true;
  }, hints);

  if (!marked) return { filled: false, reason: "music search input not found" };

  const locator = page.locator('[data-rpa-music-search="1"]').first();
  await locator.click({ timeout: 3000 });
  await locator.fill("");
  await locator.fill(keyword);
  await locator.press("Enter").catch(() => {});
  await page.waitForTimeout(2500);
  return { filled: true, method: "dom-hint" };
}

async function clickHighestUsageMusicUseButton(page) {
  const rows = await page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 260 &&
        rect.height >= 46 &&
        rect.height <= 112
      );
    }

    function usageCount(text) {
      const match = String(text || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([万亿]?)人使用/);
      if (!match) return -1;
      const multiplier = match[2] === "亿" ? 100000000 : match[2] === "万" ? 10000 : 1;
      return Math.round(Number(match[1]) * multiplier);
    }

    document.querySelectorAll("[data-rpa-music-hover-row], [data-rpa-music-use]").forEach((el) => {
      el.removeAttribute("data-rpa-music-hover-row");
      el.removeAttribute("data-rpa-music-use");
    });

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    return Array.from(document.querySelectorAll("div, li, [role='listitem'], [role='button']"))
      .map((el, index) => {
        const text = (el.textContent || "").trim();
        const rect = el.getBoundingClientRect();
        return { el, index, text, rect };
      })
      .filter(({ el, text, rect }) =>
        visible(el) &&
        rect.x > viewportWidth * 0.55 &&
        text.length < 220 &&
        /\d{1,2}:\d{2}/.test(text) &&
        /\d+(\.\d+)?\s*[\u4e07\u4ebf]?\u4eba\u4f7f\u7528/.test(text)
      )
      .sort((a, b) => a.rect.y - b.rect.y)
      .slice(0, 10)
      .map((item, originalIndex) => ({ ...item, originalIndex, usageCount: usageCount(item.text) }))
      .sort((a, b) => b.usageCount - a.usageCount || a.originalIndex - b.originalIndex)
      .map((item, orderIndex) => {
        item.el.setAttribute("data-rpa-music-hover-row", String(orderIndex));
        return {
          orderIndex,
          text: item.text.slice(0, 120),
          x: item.rect.x,
          y: item.rect.y,
          width: item.rect.width,
          height: item.rect.height,
          usage_count: item.usageCount
        };
      });
  }).catch(() => []);

  if (!rows.length) {
    return { clicked: false, reason: "no music result rows found" };
  }

  const attempts = [];
  for (const row of rows) {
    const rowLocator = page.locator(`[data-rpa-music-hover-row="${row.orderIndex}"]`).first();
    const rowBox = await rowLocator.boundingBox({ timeout: 1000 }).catch(() => row);
    if (!rowBox) continue;

    await rowLocator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    await page.mouse.move(rowBox.x + Math.min(rowBox.width * 0.35, 180), rowBox.y + rowBox.height / 2);
    await page.waitForTimeout(650);

    const useButton = await page.evaluate((orderIndex) => {
      function visible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width >= 28 &&
          rect.width <= 130 &&
          rect.height >= 20 &&
          rect.height <= 64
        );
      }

      function redScore(el) {
        const style = window.getComputedStyle(el);
        const color = `${style.backgroundColor} ${style.color}`;
        return /(rgb\(255,\s*(0|44|45|56)|rgb\(254,\s*(44|45|56)|#fe|#ff|rgba\(255,\s*(0|44|45|56))/i.test(color)
          ? 500
          : 0;
      }

      document.querySelectorAll("[data-rpa-music-use]").forEach((el) => {
        el.removeAttribute("data-rpa-music-use");
      });

      const row = document.querySelector(`[data-rpa-music-hover-row="${orderIndex}"]`);
      if (!row) return null;
      const rowRect = row.getBoundingClientRect();
      const rowCenterY = rowRect.y + rowRect.height / 2;

      const candidates = Array.from(document.querySelectorAll("button, [role='button'], div, span, a"))
        .map((el) => {
          const text = (el.textContent || "").trim();
          const rect = el.getBoundingClientRect();
          return { el, text, rect };
        })
        .filter(({ el, text, rect }) =>
          visible(el) &&
          text === "\u4f7f\u7528" &&
          rect.x >= rowRect.x + rowRect.width * 0.62 &&
          Math.abs((rect.y + rect.height / 2) - rowCenterY) <= Math.max(rowRect.height, 72)
        )
        .map(({ el, text, rect }) => ({
          el,
          text,
          rect,
          score: redScore(el) + rect.x + (el.tagName === "BUTTON" ? 100 : 0)
        }))
        .sort((a, b) => b.score - a.score);

      if (!candidates.length) return null;
      const target = candidates[0];
      target.el.setAttribute("data-rpa-music-use", "1");
      return {
        text: target.text,
        x: target.rect.x,
        y: target.rect.y,
        width: target.rect.width,
        height: target.rect.height
      };
    }, row.orderIndex).catch(() => null);

    const locator = page.locator('[data-rpa-music-use="1"]').first();
    const text = useButton?.text || "\u4f7f\u7528";

    async function attempt(method, action) {
      try {
        await action();
        await page.waitForTimeout(1500);
        const stillOpen = await musicPanelIsOpen(page).catch(() => true);
        if (!stillOpen) {
          return { clicked: true, method, index: row.orderIndex, text: text.trim(), row };
        }
        attempts.push(`${method}: clicked but music panel stayed open`);
        return null;
      } catch (error) {
        attempts.push(`${method}: ${error.message}`);
        return null;
      }
    }

    let result = null;
    if (useButton) {
      result =
        await attempt("hover-use-locator", () => locator.click({ timeout: 2500 })) ||
        await attempt("hover-use-coordinate", () =>
          page.mouse.click(useButton.x + useButton.width / 2, useButton.y + useButton.height / 2)
        );
    }

    if (!result) {
      result = await attempt("hover-row-right-coordinate", () =>
        page.mouse.click(rowBox.x + rowBox.width - 42, rowBox.y + rowBox.height / 2)
      );
    }

    if (result) return result;
  }

  return { clicked: false, reason: `music use button click failed after hover: ${attempts.join(" | ")}` };
}

async function musicPanelIsOpen(page) {
  const search = page.getByPlaceholder("\u641c\u7d22\u97f3\u4e50", { exact: false }).first();
  if (await search.isVisible({ timeout: 800 }).catch(() => false)) return true;

  return page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 120 && rect.height > 34;
    }

    return Array.from(document.querySelectorAll("div, li, [role='listitem'], [role='button']"))
      .some((el) => visible(el) && /\d+(\.\d+)?\s*[\u4e07\u4ebf]?\u4eba\u4f7f\u7528/.test(el.textContent || ""));
  }).catch(() => false);
}

async function clickMusicEntry(page) {
  const labels = [
    "\u9009\u62e9\u97f3\u4e50",
    "\u70b9\u51fb\u6dfb\u52a0\u5408\u9002\u4f5c\u54c1\u98ce\u683c\u97f3\u4e50",
    "\u6dfb\u52a0\u97f3\u4e50"
  ];

  for (const label of labels) {
    const marked = await page.evaluate((targetLabel) => {
      function visible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      document.querySelectorAll("[data-rpa-music-entry]").forEach((el) => {
        el.removeAttribute("data-rpa-music-entry");
      });

      const candidates = Array.from(document.querySelectorAll("button, [role='button'], div, span"))
        .filter((el) => visible(el) && (el.textContent || "").trim().includes(targetLabel))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, rect, text: (el.textContent || "").trim() };
        });

      if (!candidates.length) return false;

      const scored = candidates
        .map((candidate) => {
          let score = 0;
          if (targetLabel === "\u9009\u62e9\u97f3\u4e50") {
            score += candidate.rect.x > 760 ? 1000 : 0;
            score += candidate.rect.width <= 140 ? 100 : 0;
            score += candidate.rect.x;
          } else {
            score += candidate.rect.width >= 160 ? 200 : 0;
            score += candidate.rect.x;
          }
          return { ...candidate, score };
        })
        .sort((a, b) => b.score - a.score);

      const target = scored[0].el;
      target.setAttribute("data-rpa-music-entry", "1");
      return true;
    }, label);

    if (!marked) continue;

    const locator = page.locator('[data-rpa-music-entry="1"]').first();
    try {
      await locator.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
      await page.waitForTimeout(500);
      const box = await locator.boundingBox({ timeout: 2000 }).catch(() => null);
      if (!box) continue;

      await locator.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1200);
      if (await musicPanelIsOpen(page)) return { clicked: true, label, method: "locator" };

      const ancestorClicked = await page.evaluate((targetLabel) => {
        function visible(el) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        }
        const match = Array.from(document.querySelectorAll("button, [role='button'], div, span"))
          .filter(visible)
          .find((el) => (el.textContent || "").trim().includes(targetLabel));
        let current = match;
        let best = match;
        for (let index = 0; current && index < 6; index += 1) {
          const rect = current.getBoundingClientRect();
          if (rect.width >= 260 && rect.height >= 34 && rect.height <= 90) best = current;
          current = current.parentElement;
        }
        if (!best) return false;
        best.click();
        return true;
      }, label).catch(() => {});
      await page.waitForTimeout(1200);
      if (ancestorClicked && await musicPanelIsOpen(page)) return { clicked: true, label, method: "ancestor-js-click" };

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(800);
      if (await musicPanelIsOpen(page)) return { clicked: true, label, method: "center-coordinate" };

      await page.mouse.click(box.x + box.width + 18, box.y + box.height / 2);
      await page.waitForTimeout(1200);
      if (await musicPanelIsOpen(page)) return { clicked: true, label, method: "right-coordinate" };
    } catch {
      // Try next label.
    }
  }

  return { clicked: false, reason: "music panel did not open" };
}

async function selectGentleMusic(page, job) {
  const { keyword, source } = pickMusicKeyword(job);
  const result = {
    requested: true,
    keyword,
    keyword_source: source,
    selected: false
  };

  const entry = await clickMusicEntry(page);

  if (!entry.clicked) {
    return { ...result, skipped: true, reason: "music entry not found" };
  }

  await page.waitForTimeout(1500);
  const search = await fillMusicSearch(page, keyword);
  if (!search.filled) {
    return { ...result, entry_clicked: entry, search, skipped: true, reason: search.reason };
  }

  await page.waitForTimeout(3000);
  const use = await clickHighestUsageMusicUseButton(page);
  if (!use.clicked) {
    return { ...result, entry_clicked: entry, search, skipped: true, reason: use.reason, selection: use };
  }

  await page.waitForTimeout(1500);
  return {
    ...result,
    selected: true,
    entry_clicked: entry,
    search,
    selection: use
  };
}

async function pageBodyText(page) {
  return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
}

async function addFirstOfficialActivity(page) {
  const titleField = page.getByPlaceholder("添加作品标题", { exact: false }).first();
  if (await titleField.count().catch(() => 0)) {
    await titleField.click({ timeout: 3000 }).catch(() => {});
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  const activityState = await page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }
    document.querySelectorAll("[data-rpa-official-activity]").forEach((el) => {
      el.removeAttribute("data-rpa-official-activity");
    });
    const label = Array.from(document.querySelectorAll("div, span, label"))
      .filter(visible)
      .find((el) => (el.textContent || "").replace(/\s+/g, "").trim() === "官方活动");
    if (!label) return { marked: false, reason: "official activity row label not found" };
    const labelRect = label.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], li, div"))
      .filter(visible)
      .map((el) => ({ el, text: (el.textContent || "").trim(), rect: el.getBoundingClientRect() }))
      .filter(({ text, rect }) =>
        text.includes("热度") &&
        text.length < 200 &&
        rect.x > labelRect.right - 20 &&
        Math.abs((rect.y + rect.height / 2) - (labelRect.y + labelRect.height / 2)) < 90 &&
        rect.width >= 80 && rect.width <= 320 && rect.height >= 30 && rect.height <= 120
      )
      .sort((a, b) => a.rect.x - b.rect.x || a.text.length - b.text.length);
    if (!candidates.length) return { marked: false, reason: "official activity card not found" };
    candidates[0].el.setAttribute("data-rpa-official-activity", "1");
    return { marked: true, alreadyAdded: candidates[0].text.includes("已添加"), text: candidates[0].text };
  }).catch(() => false);

  if (!activityState?.marked) throw new Error(activityState?.reason || "official activity card not found");
  if (activityState.alreadyAdded) {
    return { added: true, method: "card-already-added", text: activityState.text };
  }
  const activity = page.locator('[data-rpa-official-activity="1"]').first();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const clicked = await activity.click({ timeout: 5000 })
      .then(() => true)
      .catch(() => activity.evaluate((el) => {
        el.click();
        return true;
      }).catch(() => false));
    if (!clicked) throw new Error("official activity card click was blocked");
    await page.waitForTimeout(1200);
    const text = await activity.innerText({ timeout: 2000 }).catch(() => "");
    if (text.includes("已添加")) {
      return { added: true, method: "first-official-activity", attempt, text };
    }
  }
  throw new Error("official activity click was not confirmed as 已添加");
}

async function selectMarkerType(page) {
  const alreadySelected = page.getByText("标记万物", { exact: true });
  if (await alreadySelected.count().catch(() => 0)) {
    const visible = await alreadySelected.first().isVisible().catch(() => false);
    if (visible) return { selected: true, value: "标记万物", method: "already-selected" };
  }

  let current = null;
  for (const label of ["位置", "游戏手柄"]) {
    const result = await clickVisibleExactText(page, label, 5000);
    if (result.clicked) {
      current = label;
      break;
    }
  }
  if (!current) throw new Error("current label type control was not found");

  await page.waitForTimeout(700);
  const option = await clickVisibleExactText(page, "标记万物", 5000, true);
  await page.waitForTimeout(700);
  const confirmed = page.getByText("标记万物", { exact: true }).first();
  const confirmedVisible = await confirmed.isVisible().catch(() => false);
  if (!option.clicked || !confirmedVisible) {
    throw new Error("label type 标记万物 was not confirmed");
  }
  return { selected: true, value: "标记万物", method: `dropdown:${current}` };
}

async function selectCustomRadioLabel(page, text) {
  const attribute = "data-rpa-radio-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  const marked = await page.evaluate(({ text, attribute }) => {
    const labels = Array.from(document.querySelectorAll("label"));
    const target = labels.find((label) =>
      (label.textContent || "").replace(/[\s\u200B-\u200D\uFEFF]+/gu, "") === text
    );
    if (!target) return false;
    target.setAttribute(attribute, "1");
    return true;
  }, { text, attribute }).catch(() => false);
  if (!marked) return { selected: false, reason: text + " label not found" };

  const label = page.locator("[" + attribute + "=\"1\"]").first();
  const snapshot = () => label.evaluate((el) => ({
    html: el.outerHTML,
    semantic_selected: Boolean(
      el.querySelector('input:checked, [aria-checked="true"], [class*="checked" i], [class*="selected" i], [class*="active" i]') ||
      el.matches('[aria-checked="true"], [class*="checked" i], [class*="selected" i], [class*="active" i]')
    )
  })).catch(() => ({ html: "", semantic_selected: false }));

  const before = await snapshot();
  await label.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const clicked = await label.click({ timeout: 5000 })
    .then(() => true)
    .catch(() => label.evaluate((el) => {
      el.click();
      return true;
    }).catch(() => false));
  await page.waitForTimeout(500);
  const after = await snapshot();
  return {
    selected: clicked && (after.semantic_selected || after.html !== before.html || before.semantic_selected),
    clicked,
    semantic_selected: after.semantic_selected,
    changed: after.html !== before.html
  };
}

async function configureVisibilityAndSave(page) {
  const visibility = await selectCustomRadioLabel(page, "公开");
  const savePermission = await selectCustomRadioLabel(page, "不允许");
  if (!visibility.selected || !savePermission.selected) {
    throw new Error(
      "permission verification failed: public=" + visibility.selected +
      " save_denied=" + savePermission.selected
    );
  }
  return {
    visibility: "公开",
    save_permission: "不允许",
    verified: true,
    visibility_state: visibility,
    save_permission_state: savePermission
  };
}

async function setScheduledPublishTime(page, scheduledAt) {
  const expected = formatScheduleTime(scheduledAt);
  const [expectedDate, expectedTime] = expected.split(" ");
  let selected = await clickVisibleExactText(page, "定时发布", 5000, true);
  if (!selected.clicked) {
    const scheduleLabel = page.locator("label").filter({ hasText: /定\s*时发布/ }).last();
    if (await scheduleLabel.count().catch(() => 0)) {
      await scheduleLabel.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      const clicked = await scheduleLabel.click({ timeout: 5000 })
        .then(() => true)
        .catch(() => scheduleLabel.evaluate((el) => {
          el.click();
          return true;
        }).catch(() => false));
      if (clicked) selected = { clicked: true, text: "定时发布", method: "schedule-label" };
    }
  }
  if (!selected.clicked) {
    const diagnostics = await page.evaluate(() => ({
      text_nodes: Array.from(document.querySelectorAll("label, span, div, button"))
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent || "").replace(/\s+/g, " ").trim(),
          class_name: el.className || ""
        }))
        .filter((item) => item.text.includes("定时发布") && item.text.length < 120)
        .slice(0, 12),
      radios: Array.from(document.querySelectorAll('input[type="radio"]')).map((input) => ({
        checked: input.checked,
        value: input.value,
        name: input.name,
        class_name: input.className || "",
        parent_text: (input.parentElement?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120)
      }))
    })).catch(() => ({}));
    throw new Error(`scheduled publish option was not found; diagnostics=${JSON.stringify(diagnostics)}`);
  }
  await page.waitForTimeout(1200);

  const inputs = page.locator('input:not([type="file"])');
  await page.waitForTimeout(500);
  const count = await inputs.count();
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const type = await input.getAttribute("type").catch(() => "");
    const hint = [
      await input.getAttribute("placeholder").catch(() => ""),
      await input.getAttribute("aria-label").catch(() => "")
    ].filter(Boolean).join(" ");
    const currentValue = await input.inputValue().catch(() => "");
    const isCombinedDateTime = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(currentValue);
    const isScheduleInput = type === "datetime-local" || hint.includes("日期") || hint.includes("时间") || isCombinedDateTime;
    if (!isScheduleInput) continue;
    const candidates = type === "datetime-local"
      ? [expected.replace(" ", "T"), expected]
      : isCombinedDateTime
        ? [expected]
      : hint.includes("日期")
        ? [expectedDate]
        : hint.includes("时间")
          ? [expectedTime]
          : [expected];
    for (const candidate of candidates) {
      try {
        await input.fill(candidate, { timeout: 5000 });
        await input.press("Tab").catch(() => {});
        await page.waitForTimeout(500);
        const actual = await input.inputValue().catch(() => "");
        if (actual) values.push({ index, hint, type, value: actual });
        break;
      } catch {
        try {
          await input.click({ timeout: 2000 });
          await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
          await input.type(candidate, { delay: 20 });
          await input.press("Tab").catch(() => {});
          const actual = await input.inputValue().catch(() => "");
          if (actual) values.push({ index, hint, type, value: actual });
          break;
        } catch {
          // Try the next supported input format.
        }
      }
    }
  }

  await page.waitForTimeout(700);
  const confirmationText = [
    await pageBodyText(page),
    ...values.map((item) => item.value)
  ].join(" ");
  const dateVariants = [expectedDate, expectedDate.replace(/-/g, "/"), expectedDate.replace(/-/g, ".")];
  const dateConfirmed = dateVariants.some((value) => confirmationText.includes(value));
  const timeConfirmed = confirmationText.includes(expectedTime);
  if (dateConfirmed && timeConfirmed) {
    return { selected: true, expected, values };
  }
  throw new Error(`scheduled publish time was not confirmed: ${expected}`);
}

async function waitForContentCheck(page, timeoutMs = config.contentCheckWaitMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let lastProgress = null;
  do {
    const text = await pageBodyText(page);
    if (text.includes("作品未见异常")) {
      return { passed: true, status: "作品未见异常", progress: 100 };
    }
    const progressMatch = text.match(/检测中\s*(\d{1,3})%/);
    if (progressMatch) lastProgress = Number(progressMatch[1]);
    const failure = ["作品存在异常", "检测发现异常", "内容存在风险"]
      .find((message) => text.includes(message));
    if (failure) return { passed: false, status: failure, progress: lastProgress };
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.max(200, Math.min(2000, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return { passed: false, status: "timeout", progress: lastProgress };
}

async function collectPreflightSnapshot(page, state) {
  const text = await pageBodyText(page);
  const checks = {
    single_image: state.uploadResult?.verification?.added_one === true,
    title: state.titleResult?.verified === true,
    topics: state.topics.every((topic) => text.includes(topic.replace(/^#/, "")) || text.includes(topic)),
    activity: state.activityResult?.added === true,
    music: state.musicResult?.selected === true,
    marker: state.markerResult?.selected === true,
    visibility: state.permissionResult?.visibility === "公开",
    save_permission: state.permissionResult?.save_permission === "不允许",
    scheduled_time: state.scheduleResult?.selected === true,
    content_check: state.contentCheckResult?.passed === true || text.includes("作品未见异常")
  };
  const failed = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  return { ok: failed.length === 0, checks, failed };
}

function buildManagementTimeVariants(expectedTime) {
  const match = String(expectedTime || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) return [String(expectedTime || "")];
  return [
    expectedTime,
    expectedTime.replace(/-/g, "/"),
    `${match[1]}年${match[2]}月${match[3]}日 ${match[4]}:${match[5]}`,
    `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日 ${Number(match[4])}:${match[5]}`
  ];
}

async function inspectContentManagement(page, job, timeoutMs = 5000) {
  const managePage = await page.context().newPage();
  const expectedTime = formatScheduleTime(job.scheduled_at);
  const timeVariants = buildManagementTimeVariants(expectedTime);
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let last = null;
  let attempts = 0;

  async function applyTitleSearch() {
    const search = managePage.locator("input[placeholder*='搜索作品'], input[placeholder*='搜索']").first();
    if (!(await search.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    await search.fill(job.title, { timeout: 5000 });
    await search.press("Enter").catch(() => {});
    return true;
  }

  try {
    await managePage.goto(config.contentManageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let searched = await applyTitleSearch();
    do {
      attempts += 1;
      await managePage.waitForTimeout(attempts === 1 ? 2500 : 1500);
      last = await managePage.evaluate(({ title, expectedTime, timeVariants, statuses, searched }) => {
        function visible(el) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        }
        const normalizedVariants = timeVariants.map((value) => value.replace(/\s+/g, ""));
        const visibleNodes = Array.from(document.querySelectorAll("tr, li, [role='row'], article, div"))
          .filter(visible)
          .map((el) => {
            const text = (el.textContent || "").replace(/\s+/g, " ").trim();
            return { el, text, compact: text.replace(/\s+/g, "") };
          });
        const titleCandidates = visibleNodes.filter(({ text }) => text.includes(title) && text.length < 3000);
        const timeCandidates = visibleNodes.filter(({ compact }) => normalizedVariants.some((time) => compact.includes(time)));
        const candidates = titleCandidates
          .filter(({ compact }) => normalizedVariants.some((time) => compact.includes(time)))
          .sort((a, b) => a.text.length - b.text.length);
        const evidence = candidates[0]?.text || "";
        const status = statuses.find((value) => evidence.includes(value)) || "";
        return {
          verified: Boolean(evidence && status),
          title_found: titleCandidates.length > 0,
          time_found: timeCandidates.length > 0,
          status,
          evidence: evidence.slice(0, 800),
          searched
        };
      }, { title: job.title, expectedTime, timeVariants, statuses: ACCEPTED_MANAGEMENT_STATUSES, searched });
      if (last.verified) return { ...last, expected_time: expectedTime, url: managePage.url() };
      if (Date.now() < deadline && attempts % 5 === 0) {
        await managePage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        searched = await applyTitleSearch();
      }
    } while (Date.now() < deadline);
    return { ...(last || {}), verified: false, expected_time: expectedTime, url: managePage.url() };
  } finally {
    await managePage.close().catch(() => {});
  }
}

async function clickFinalPublish(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await dismissKnownPopups(page);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
  }).catch(() => {});
  await page.waitForTimeout(500);

  const marked = await page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    document.querySelectorAll("[data-rpa-final-publish]").forEach((el) => {
      el.removeAttribute("data-rpa-final-publish");
    });

    const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((el) => visible(el))
      .filter((el) => {
        const text = (el.textContent || "").trim();
        return text === "\u53d1\u5e03" || text.includes("\u7acb\u5373\u53d1\u5e03") || text.includes("\u5b9a\u65f6\u53d1\u5e03");
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || "").trim();
        let score = 0;
        if (text === "\u53d1\u5e03") score += 1000;
        if (text.includes("\u7acb\u5373\u53d1\u5e03")) score += 800;
        score += rect.y;
        score += rect.x > 200 ? 100 : 0;
        return { el, score, text };
      })
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) return false;
    candidates[0].el.setAttribute("data-rpa-final-publish", "1");
    return true;
  });

  if (!marked) {
    throw new Error("final publish button not found");
  }

  const button = page.locator("[data-rpa-final-publish='1']").first();
  await button.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const text = await button.innerText({ timeout: 2000 }).catch(() => "\u53d1\u5e03");
  if (!(await button.isEnabled({ timeout: 3000 }).catch(() => false))) {
    throw new Error("final publish button is disabled");
  }
  await button.click({ timeout: config.actionTimeoutMs });

  await page.waitForTimeout(8000);
  return {
    clicked: true,
    text: text.trim(),
    method: "verified-locator",
    url_after_click: page.url()
  };
}

function mergeBodyAndTags(body, hashtags) {
  const tags = Array.isArray(hashtags)
    ? hashtags
    : String(hashtags || "").split(/\s+/).filter(Boolean);
  const normalizedTags = tags
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
  return [body || "", normalizedTags.join(" ")].filter(Boolean).join("\n");
}

async function dryRunImageText({ anchor, job, jobDir, publish = false, authorization = "" } = {}) {
  await ensureDirs();
  const validatedJob = validateJob(job, { now: new Date(), requireScheduleWindow: true });
  const authorizationResult = assertPublishAuthorization({
    publish: Boolean(publish),
    dryRun: config.dryRun,
    expectedBatchId: validatedJob.batch_id,
    authorization
  });
  const anchorConfig = resolveAnchor(anchor || validatedJob.anchor_key || Object.keys(config.anchors)[0] || "account1");
  const files = await validateImageFilePaths(normalizeFiles(validatedJob.images, jobDir));
  const body = mergeBodyAndTags(validatedJob.body || validatedJob.content || "", validatedJob.hashtags);
  const shouldPublish = Boolean(publish) && !config.dryRun;

  const context = await openAnchorContext(anchorConfig);
  const page = await context.newPage();
  let shot;
  let loginState;
  let entryClicked = "";
  let uploadResult = null;
  let titleResult = null;
  let bodyResult = null;
  let activityResult = null;
  let musicResult = null;
  let musicPanelCloseResult = null;
  let markerResult = null;
  let permissionResult = null;
  let scheduleResult = null;
  let contentCheckResult = null;
  let preflight = null;
  let publishResult = null;
  let managementVerification = null;

  try {
    await page.goto(config.creatorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const creatorDomReady = await waitForCreatorDom(page);
    loginState = await waitForCreatorLoginResolution(page);
    if (!loginState.loggedIn) {
      shot = await createScreenshot(page, `${anchorConfig.key}-dry-run-login-required`);
      return {
        ok: false,
        status: creatorDomReady ? "login_required" : "creator_page_unavailable",
        anchor: anchorConfig.key,
        message: creatorDomReady
          ? "Douyin profile is not logged in"
          : "Douyin creator page loaded no interactive DOM; check network, browser profile, or platform response",
        ...loginState,
        ...shot
      };
    }

    if (shouldPublish) {
      managementVerification = await inspectContentManagement(page, validatedJob, Math.min(15_000, config.managementCheckWaitMs));
      if (managementVerification.verified) {
        return {
          ok: true,
          status: "duplicate_verified",
          anchor: anchorConfig.key,
          dry_run: false,
          publish_requested: true,
          message: "matching title and scheduled time already exist in Content Management; publish skipped",
          management_verification: managementVerification
        };
      }
    }

    entryClicked = await openImageTextPublisher(page);
    uploadResult = await uploadImages(page, files);

    titleResult = await fillTitle(page, validatedJob.title);
    if (!titleResult.verified) throw new Error("title field was not verified after fill");
    bodyResult = await fillDescription(page, body);
    if (!bodyResult.verified) throw new Error("description/topics field was not verified after fill");

    activityResult = await addFirstOfficialActivity(page);
    musicResult = await selectGentleMusic(page, validatedJob);
    if (!musicResult.selected) throw new Error(`music selection failed: ${musicResult.reason || "not selected"}`);

    musicPanelCloseResult = await closeMusicPanelIfOpen(page);
    if (!musicPanelCloseResult.closed && musicPanelCloseResult.reason !== "music panel was not open") {
      throw new Error(`music panel close failed: ${musicPanelCloseResult.reason}`);
    }
    markerResult = await selectMarkerType(page);
    permissionResult = await configureVisibilityAndSave(page);
    scheduleResult = await setScheduledPublishTime(page, validatedJob.scheduled_at);
    await dismissKnownPopups(page);
    contentCheckResult = await waitForContentCheck(page);

    preflight = await collectPreflightSnapshot(page, {
      uploadResult,
      titleResult,
      topics: validatedJob.hashtags,
      activityResult,
      musicResult,
      markerResult,
      permissionResult,
      scheduleResult,
      contentCheckResult
    });
    if (!preflight.ok) {
      shot = await createScreenshot(page, `${anchorConfig.key}-preflight-failed`);
      return {
        ok: false,
        status: "preflight_failed",
        anchor: anchorConfig.key,
        message: `publish preflight failed: ${preflight.failed.join(", ")}`,
        preflight,
        ...shot
      };
    }

    if (shouldPublish) {
      publishResult = await clickFinalPublish(page);
      managementVerification = await inspectContentManagement(page, validatedJob, config.managementCheckWaitMs);
      if (!managementVerification.verified) {
        shot = await createScreenshot(page, `${anchorConfig.key}-publish-result-uncertain`);
        return {
          ok: false,
          status: "publish_result_uncertain",
          anchor: anchorConfig.key,
          message: "publish was clicked but title, scheduled time, and accepted status were not jointly verified; do not retry blindly",
          publish_result: publishResult,
          management_verification: managementVerification,
          ...shot
        };
      }
      shot = await createScreenshot(page, `${anchorConfig.key}-published-verified`);
    } else {
      shot = await createScreenshot(page, `${anchorConfig.key}-dry-run`);
    }

    return {
      ok: true,
      status: shouldPublish ? "published_verified" : "dry_run_completed",
      anchor: anchorConfig.key,
      dry_run: !shouldPublish,
      publish_requested: Boolean(publish),
      authorization: authorizationResult,
      url: page.url(),
      entry_clicked: entryClicked,
      uploaded: uploadResult,
      title_filled: titleResult,
      body_filled: bodyResult,
      activity: activityResult,
      music_selection: musicResult,
      music_panel_close: musicPanelCloseResult,
      marker: markerResult,
      permissions: permissionResult,
      schedule: scheduleResult,
      content_check: contentCheckResult,
      preflight,
      publish_result: publishResult,
      management_verification: managementVerification,
      image_count: files.length,
      ...shot
    };
  } catch (error) {
    shot = await createScreenshot(page, `${anchorConfig.key}-rpa-failed`).catch(() => ({}));
    return {
      ok: false,
      status: "rpa_failed",
      anchor: anchorConfig.key,
      message: error.message,
      publish_requested: Boolean(publish),
      preflight,
      management_verification: managementVerification,
      ...shot
    };
  } finally {
    await context.close();
  }
}

module.exports = {
  classifyLogin,
  ensureDirs,
  loginCheck,
  waitForLoginUiReady,
  waitForCreatorLoginResolution,
  verifySingleImageUpload,
  normalizeRichTextForVerification,
  isPathInside,
  normalizeFiles,
  validateImageFilePaths,
  waitForContentCheck,
  buildManagementTimeVariants,
  dryRunImageText,
  clickFinalPublish,
  inspectContentManagement,
  openAnchorContext,
  resolveAnchor
};
