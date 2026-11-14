"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const {
  scheduleSlot,
  validateContentPlan,
  validStartDate
} = require("../content-plan-policy");

function planItem(number, overrides = {}) {
  const defaults = [
    { title: "晨光里慢慢出发", bgm: "晨光", artist: "歌手甲", publish_time: "2026-09-08 10:08", topics: ["#晨光日常", "#通勤穿搭", "#自然随拍"] },
    { title: "午后留一点从容", bgm: "风经过", artist: "歌手乙", publish_time: "2026-09-08 15:18", topics: ["#午后时光", "#轻熟穿搭", "#生活记录"] },
    { title: "晚风刚好吹回家", bgm: "灯火里", artist: "歌手丙", publish_time: "2026-09-08 21:38", topics: ["#下班以后", "#夜晚随拍", "#温柔日常"] }
  ][number - 1];
  return {
    source_path: `E:\\batch\\source-${number}.jpg`,
    image_number: number,
    publish_number: number,
    ...defaults,
    ...overrides
  };
}

test("content planning policy accepts the lean existing plan shape", () => {
  const result = validateContentPlan([
    planItem(1),
    planItem(2),
    planItem(3)
  ], { startDate: "2026-09-08" });
  assert.equal(result.status, "PASS");
  assert.equal(result.count, 3);
  assert.equal(Object.hasOwn(result.items[0], "content_description"), false);
  assert.equal(Object.hasOwn(result.items[0], "recommendation_reason"), false);
  assert.equal(Object.hasOwn(result.items[0], "keywords"), false);
});

test("content planning policy keeps explicit dates, three slots, titles, topics, and BGM deterministic", () => {
  assert.equal(validStartDate("2026-09-08"), true);
  assert.equal(validStartDate("2026-02-30"), false);
  assert.equal(scheduleSlot(new Date(2026, 8, 8, 10, 8)), "morning");
  assert.equal(scheduleSlot(new Date(2026, 8, 8, 18, 10)), "afternoon");
  assert.equal(scheduleSlot(new Date(2026, 8, 8, 21, 38)), "night");

  assert.throws(() => validateContentPlan([planItem(1)], { startDate: "" }), /start_date is required/);
  assert.throws(() => validateContentPlan([
    planItem(1, { title: "这是一个明显超过十五个字符限制的发布标题" })
  ], { startDate: "2026-09-08" }), /exceeds 15 characters/);
  assert.throws(() => validateContentPlan([
    planItem(1),
    planItem(2, { bgm: "晨光DJ版" })
  ], { startDate: "2026-09-08" }), /duplicate BGM or variant/);
  assert.throws(() => validateContentPlan([
    planItem(1),
    planItem(2, { publish_time: "2026-09-08 10:48" })
  ], { startDate: "2026-09-08" }), /duplicate publishing slot/);
});

test("project planning contract and control-panel prompt use the optimized lean requirements", async () => {
  const root = path.join(__dirname, "..");
  const schema = JSON.parse(await fs.readFile(path.join(root, "docs", "image-content-plan.schema.json"), "utf8"));
  const required = schema.items.required;
  assert.deepEqual(required, [
    "source_path",
    "image_number",
    "publish_number",
    "title",
    "topics",
    "bgm",
    "artist",
    "publish_time"
  ]);
  assert.equal(required.includes("content_description"), false);
  assert.equal(required.includes("recommendation_reason"), false);
  assert.equal(required.includes("keywords"), false);

  const client = await fs.readFile(path.join(root, "public", "control-panel-client.js"), "utf8");
  assert.match(client, /docs\/image-content-planning\.md/);
  assert.match(client, /paths\.project_root/);
  assert.doesNotMatch(client, /E:\\\\AI-图-素材/);
  assert.match(client, /validate:content-plan/);
  assert.match(client, /不超过15字且句式有变化/);
});
