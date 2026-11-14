"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { isDueForPublish } = require("../feishu");
const {
  assertPublishAuthorization,
  parseStrictFilename,
  parseUsageCount,
  validateBatch,
  validateJob,
  validateScheduleWindow
} = require("../publish-policy");
const {
  isLedgerVerified,
  readLedger,
  readPublishAttempts,
  reconcilePublishedThroughFromLedger,
  writePublishAttempt,
  writeVerifiedLedgerEntry
} = require("../local-batch");
const config = require("../config");
const {
  buildManagementTimeVariants,
  classifyLogin,
  normalizeRichTextForVerification,
  verifySingleImageUpload,
  waitForContentCheck,
  waitForCreatorLoginResolution,
  waitForLoginUiReady
} = require("../douyin");

const NOW = new Date(2026, 7, 25, 12, 0, 0);

function filename(number, title = "窗前静听风", bgm = "晚风吹雪", time = "2026年09月02日09时40分", topics = "#窗边时光 #通透光影 #舒适穿搭") {
  const padded = String(number).padStart(2, "0");
  return `图片${padded}-第${padded}条发布内容-${title}-${topics}-${bgm}-陈奕迅-${time}.jpg`;
}

function parsed(number, options = {}) {
  return parseStrictFilename(path.join("C:\\batch", filename(
    number,
    options.title,
    options.bgm,
    options.time,
    options.topics
  )));
}

test("strict seven-field filename parses into one-image publishing metadata", () => {
  const item = parsed(4);
  assert.equal(item.image_number, 4);
  assert.equal(item.publish_number, 4);
  assert.equal(item.title, "窗前静听风");
  assert.deepEqual(item.topics, ["#窗边时光", "#通透光影", "#舒适穿搭"]);
  assert.equal(item.bgm, "晚风吹雪");
  assert.equal(item.scheduled_at_text, "2026-09-02 09:40");
});

test("configured account profile path is not duplicated", () => {
  assert.equal(path.basename(config.anchors.account1.profileDir), "account1");
  assert.notEqual(path.basename(path.dirname(config.anchors.account1.profileDir)), "account1");
});

function loginPageMock(bodyText) {
  return {
    url: () => "https://creator.douyin.com/creator-micro/content/upload?default-tab=3",
    title: async () => "抖音创作者中心",
    locator: (selector) => ({
      innerText: async () => selector === "body" ? bodyText : "",
      count: async () => {
        if (selector.includes('input[type="tel"]')) return bodyText.includes("验证码登录") ? 1 : 0;
        if (selector.startsWith("button")) return 12;
        return 0;
      }
    })
  };
}

test("creator login page is never classified as an authenticated creator page", async () => {
  const login = await classifyLogin(loginPageMock("抖音创作者中心 我是创作者 扫码登录 验证码登录 登录/注册"));
  assert.equal(login.loggedIn, false);
  assert.equal(login.hasLoginHints, true);
  assert.equal(login.hasRenderedLoginUi, true);

  const creator = await classifyLogin(loginPageMock("内容管理 作品管理 发布图文 上传图片"));
  assert.equal(creator.loggedIn, true);
  assert.equal(creator.hasLoginHints, false);
});

test("login defaults allow slow QR rendering and a fifteen-minute scan window", () => {
  assert.equal(config.defaultLoginWaitMs, 15 * 60 * 1000);
  assert.equal(config.maxLoginWaitMs, 30 * 60 * 1000);
  assert.equal(config.loginUiWaitMs, 2 * 60 * 1000);
  assert.equal(config.loginQrSettleMs, 10_000);
  assert.equal(config.uploadWaitMs, 90_000);
  assert.equal(config.contentCheckWaitMs, 2 * 60 * 1000);
  assert.equal(config.managementCheckWaitMs, 2 * 60 * 1000);
});

test("Content Management verification accepts the platform Chinese schedule format", () => {
  assert.deepEqual(buildManagementTimeVariants("2026-09-02 09:40"), [
    "2026-09-02 09:40",
    "2026/09/02 09:40",
    "2026年09月02日 09:40",
    "2026年9月2日 9:40"
  ]);
});

test("login UI readiness waits until login controls appear", async () => {
  let bodyText = "";
  let waits = 0;
  const page = loginPageMock(bodyText);
  page.locator = (selector) => ({
    innerText: async () => selector === "body" ? bodyText : "",
    count: async () => {
      if (selector.includes('input[type="tel"]')) return bodyText.includes("验证码登录") ? 1 : 0;
      if (selector.startsWith("button")) return bodyText ? 12 : 0;
      return 0;
    }
  });
  page.waitForTimeout = async () => {
    waits += 1;
    bodyText = "抖音创作者中心 扫码登录 验证码登录";
  };

  const result = await waitForLoginUiReady(page, 5000);
  assert.equal(result.ready, true);
  assert.equal(result.state.loggedIn, false);
  assert.equal(result.state.hasLoginHints, true);
  assert.equal(waits, 2);
});

test("creator login resolution does not reject an authenticated page while it is loading", async () => {
  let bodyText = "加载中，请稍候";
  let waits = 0;
  const page = loginPageMock(bodyText);
  page.locator = (selector) => ({
    innerText: async () => selector === "body" ? bodyText : "",
    count: async () => selector.startsWith("button") ? 12 : 0
  });
  page.waitForTimeout = async () => {
    waits += 1;
    bodyText = "内容管理 作品管理 发布图文 上传图片";
  };

  const result = await waitForCreatorLoginResolution(page, 5000);
  assert.equal(result.loggedIn, true);
  assert.equal(waits, 1);
});

test("single-image upload verification tolerates whitespace inserted by the page", async () => {
  const page = {
    locator: (selector) => ({
      innerText: async () => selector === "body" ? "已添加\n 1 张图片\n继续添加" : "",
      count: async () => 0
    })
  };

  assert.deepEqual(await verifySingleImageUpload(page, { timeoutMs: 0 }), {
    added_one: true,
    preview_count: 1
  });
});

test("rich-text verification ignores editor-only whitespace and zero-width characters", () => {
  const expected = "窗前静听风\n#窗边时光 #通透光影 #舒适穿搭";
  const editorText = "窗前静听风\u200b\n#窗边时光\t#通透光影\n#舒适穿搭";
  assert.equal(
    normalizeRichTextForVerification(editorText),
    normalizeRichTextForVerification(expected)
  );
});

test("content preflight waits for the explicit no-anomaly state", async () => {
  let bodyText = "快速检测 检测中25%";
  let waits = 0;
  const page = {
    locator: () => ({ innerText: async () => bodyText }),
    waitForTimeout: async () => {
      waits += 1;
      bodyText = "快速检测 作品未见异常";
    }
  };

  assert.deepEqual(await waitForContentCheck(page, 5000), {
    passed: true,
    status: "作品未见异常",
    progress: 100
  });
  assert.equal(waits, 1);
});

test("strict filename rejects malformed fields and title length", () => {
  assert.throws(
    () => parseStrictFilename("C:\\batch\\图片01-第01条发布内容-标题-#话题1 #话题2-BGM-歌手-2026年09月02日09时40分.jpg"),
    /exactly 3/
  );
  assert.throws(
    () => parsed(1, { title: "这是一个明显超过十五个字符限制的作品标题" }),
    /title exceeds/
  );
});

test("job policy enforces one image, three topics, explicit BGM, and schedule", () => {
  assert.throws(
    () => validateJob({
      images: ["a.jpg", "b.jpg"],
      title: "窗边慢一点",
      hashtags: ["#一", "#二", "#三"],
      music_keyword: "晚风",
      scheduled_at: "2026-09-02 09:40"
    }, { now: NOW }),
    /exactly 1 image/
  );
  assert.throws(
    () => validateJob({
      images: ["a.jpg"],
      title: "窗边慢一点",
      hashtags: ["#一", "#二"],
      music_keyword: "晚风",
      scheduled_at: "2026-09-02 09:40"
    }, { now: NOW }),
    /exactly 3 topics/
  );
});

test("remaining batch may start at 04 but must remain contiguous and ordered", () => {
  const result = validateBatch([
    parsed(4, { time: "2026年09月02日09时40分" }),
    parsed(5, { bgm: "海边慢调", time: "2026年09月02日15时12分", topics: "#午后时光 #商场散步 #独处日常" }),
    parsed(6, { bgm: "旧时光", time: "2026年09月02日20时56分", topics: "#夜景随拍 #回家路上 #低头慢步" })
  ], { now: NOW, startDate: "2026-09-01", batchId: "batch-1", publishedThrough: 3 });
  assert.equal(result.status, "PASS");
  assert.equal(result.first_publish_number, 4);
  assert.equal(result.last_publish_number, 6);

  assert.throws(
    () => validateBatch([
      parsed(4),
      parsed(6, { bgm: "旧时光", time: "2026年09月02日20时56分", topics: "#夜景随拍 #回家路上 #低头慢步" })
    ], { now: NOW, startDate: "2026-09-01", batchId: "batch-1", publishedThrough: 3 }),
    /contiguous/
  );
});

test("batch rejects more than three posts per day and BGM variants", () => {
  const fourSameDay = [
    parsed(1, { bgm: "歌曲一", time: "2026年09月02日09时40分" }),
    parsed(2, { bgm: "歌曲二", time: "2026年09月02日12时00分", topics: "#话题二甲 #话题二乙 #话题二丙" }),
    parsed(3, { bgm: "歌曲三", time: "2026年09月02日15时12分", topics: "#话题三甲 #话题三乙 #话题三丙" }),
    parsed(4, { bgm: "歌曲四", time: "2026年09月02日20时56分", topics: "#话题四甲 #话题四乙 #话题四丙" })
  ];
  assert.throws(
    () => validateBatch(fourSameDay, { now: NOW, startDate: "2026-09-01", batchId: "batch-1" }),
    /more than 3 posts/
  );

  assert.throws(
    () => validateBatch([
      parsed(1, { bgm: "晚风", time: "2026年09月02日09时40分" }),
      parsed(2, { bgm: "晚风DJ版", time: "2026年09月02日15时12分", topics: "#话题二甲 #话题二乙 #话题二丙" })
    ], { now: NOW, startDate: "2026-09-01", batchId: "batch-1" }),
    /duplicate BGM or variant/
  );
});

test("schedule window requires at least two hours and no more than fourteen days", () => {
  assert.doesNotThrow(() => validateScheduleWindow(new Date(NOW.getTime() + 2 * 60 * 60 * 1000), NOW));
  assert.throws(() => validateScheduleWindow(new Date(NOW.getTime() + 2 * 60 * 60 * 1000 - 1), NOW), /at least 2 hours/);
  assert.doesNotThrow(() => validateScheduleWindow(new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000), NOW));
  assert.throws(() => validateScheduleWindow(new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000 + 1), NOW), /within 14 days/);
});

test("real publish requires exact current batch authorization", () => {
  assert.deepEqual(
    assertPublishAuthorization({ publish: true, dryRun: false, expectedBatchId: "batch-1", authorization: "batch-1" }),
    { authorized: true, batch_id: "batch-1" }
  );
  assert.throws(
    () => assertPublishAuthorization({ publish: true, dryRun: false, expectedBatchId: "batch-1", authorization: "batch-2" }),
    /exactly match/
  );
  assert.equal(assertPublishAuthorization({ publish: true, dryRun: true }).reason, "dry-run");
});

test("music usage parsing supports people, ten-thousands, and hundred-millions", () => {
  assert.equal(parseUsageCount("123人使用"), 123);
  assert.equal(parseUsageCount("2.5万人使用"), 25_000);
  assert.equal(parseUsageCount("1.2亿人使用"), 120_000_000);
  assert.equal(parseUsageCount("暂无数据"), -1);
});

test("Feishu scheduler selects only approved future records inside platform window", () => {
  const base = {
    record_id: "rec_test",
    fields: {
      "审核状态": "通过",
      "发布状态": "待发布",
      "定时发布时间": "2026-09-02 09:40"
    }
  };
  assert.equal(isDueForPublish(base, NOW), true);
  assert.equal(isDueForPublish({ ...base, fields: { ...base.fields, "定时发布时间": "2026-08-25 13:00" } }, NOW), false);
  assert.equal(isDueForPublish({ ...base, fields: { ...base.fields, "定时发布时间": "" } }, NOW), false);
  assert.equal(isDueForPublish({ ...base, fields: { ...base.fields, "审核状态": "待审核" } }, NOW), false);
});

test("ledger accepts only Content Management verified statuses", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-ledger-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "ledger.json");
  const item = parsed(4);

  await assert.rejects(
    writeVerifiedLedgerEntry(ledgerPath, "batch-1", item, { verified: false, status: "审核中" }),
    /without verified/
  );
  await writeVerifiedLedgerEntry(ledgerPath, "batch-1", item, { verified: true, status: "定时发布中" });
  const ledger = await readLedger(ledgerPath);
  assert.equal(isLedgerVerified(ledger, "batch-1", item), true);
});

test("missing published files advance published_through only with verified ledger evidence", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-state-sync-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const images = path.join(directory, "images");
  const batchConfigPath = path.join(directory, "发布配置.json");
  const ledgerPath = path.join(directory, "ledger.json");
  await fs.mkdir(images);
  await fs.writeFile(path.join(images, filename(
    5,
    "午后慢一点",
    "海边慢调",
    "2026年09月02日15时12分",
    "#午后时光 #商场散步 #独处日常"
  )), "image");
  await fs.writeFile(batchConfigPath, JSON.stringify({
    start_date: "2026-09-01",
    batch_id: "batch-sync",
    published_through: 3
  }));
  await fs.writeFile(ledgerPath, JSON.stringify({
    version: 1,
    verified: [{ batch_id: "batch-sync", publish_number: 4, status: "定时发布中" }]
  }));

  assert.deepEqual(await reconcilePublishedThroughFromLedger({
    batchConfigPath,
    imageDirectory: images,
    ledgerPath
  }), { changed: true, before: 3, after: 4 });
  assert.equal(JSON.parse(await fs.readFile(batchConfigPath, "utf8")).published_through, 4);
});

test("publish attempts retain enough metadata for read-only reconciliation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-attempt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const attemptsPath = path.join(directory, "attempts.json");
  const item = parsed(4);
  await writePublishAttempt(attemptsPath, "batch-attempt", item, "uncertain", {
    message: "publish clicked; verification pending"
  });
  const state = await readPublishAttempts(attemptsPath);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].publish_number, 4);
  assert.equal(state.attempts[0].title, "窗前静听风");
  assert.equal(state.attempts[0].scheduled_at, "2026-09-02 09:40");
  assert.equal(state.attempts[0].status, "uncertain");
});
