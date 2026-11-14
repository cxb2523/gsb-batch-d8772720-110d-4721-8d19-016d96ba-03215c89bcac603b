"use strict";

const path = require("path");

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_TITLE_CHARACTERS = 15;
const MAX_POSTS_PER_DAY = 3;
const MIN_SCHEDULE_LEAD_MS = 2 * 60 * 60 * 1000;
const MAX_SCHEDULE_LEAD_MS = 14 * 24 * 60 * 60 * 1000;
const ACCEPTED_MANAGEMENT_STATUSES = ["审核中", "定时发布中"];

function textCharacters(value) {
  return Array.from(String(value || "").trim()).length;
}

function parseLocalDateTime(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("invalid scheduled time");
    return new Date(value.getTime());
  }

  const text = String(value || "").trim();
  const match = text.match(
    /^(\d{4})(?:年|-)(\d{2})(?:月|-)(\d{2})(?:日|[ T])(\d{2})(?:时|:)(\d{2})(?:分)?$/
  );
  if (!match) {
    throw new Error(`invalid scheduled time: ${text || "(empty)"}`);
  }

  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`invalid scheduled time: ${text}`);
  }
  return date;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatScheduleTime(value) {
  const date = parseLocalDateTime(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function dateKey(value) {
  return formatScheduleTime(value).slice(0, 10);
}

function normalizeTopics(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/\s+/)
      .filter(Boolean);
  return raw
    .map((topic) => String(topic || "").trim())
    .filter(Boolean)
    .map((topic) => (topic.startsWith("#") ? topic : `#${topic}`));
}

function normalizeSongKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(dj|remix|剪辑|加速|慢速|翻唱|伴奏|纯享|版本|版)/gi, "")
    .replace(/[\s（）()\[\]【】_·.，,、]+/g, "")
    .trim();
}

function parseStrictFilename(filePath) {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported image extension: ${path.basename(filePath)}`);
  }

  const baseName = path.basename(absolutePath, path.extname(absolutePath));
  const fields = baseName.split("-");
  if (fields.length !== 7) {
    throw new Error(`filename must contain exactly 7 fields: ${path.basename(filePath)}`);
  }
  if (fields.some((field) => !field.trim())) {
    throw new Error(`filename contains an empty field: ${path.basename(filePath)}`);
  }

  const imageMatch = fields[0].match(/^图片(?<number>\d{2})$/);
  const publishMatch = fields[1].match(/^第(?<number>\d{2})条发布内容$/);
  if (!imageMatch) throw new Error(`invalid image number: ${path.basename(filePath)}`);
  if (!publishMatch) throw new Error(`invalid publish number: ${path.basename(filePath)}`);

  const title = fields[2].trim();
  if (textCharacters(title) > MAX_TITLE_CHARACTERS) {
    throw new Error(`title exceeds ${MAX_TITLE_CHARACTERS} characters: ${title}`);
  }

  const topicField = fields[3].trim();
  if (!/^#[^\s#-]+(?:\s+#[^\s#-]+){2}$/.test(topicField)) {
    throw new Error(`exactly 3 well-formed topics are required: ${path.basename(filePath)}`);
  }
  const topics = normalizeTopics(topicField);
  if (new Set(topics).size !== 3) {
    throw new Error(`topics must be unique within one post: ${path.basename(filePath)}`);
  }

  const scheduledAt = parseLocalDateTime(fields[6]);
  return {
    path: absolutePath,
    filename: path.basename(absolutePath),
    image_number: Number(imageMatch.groups.number),
    publish_number: Number(publishMatch.groups.number),
    title,
    topics,
    topic_text: topics.join(" "),
    bgm: fields[4].trim(),
    artist: fields[5].trim(),
    scheduled_at: scheduledAt,
    scheduled_at_text: formatScheduleTime(scheduledAt),
    extension
  };
}

function validateScheduleWindow(value, now = new Date(), options = {}) {
  const scheduledAt = parseLocalDateTime(value);
  const reference = parseLocalDateTime(now);
  const minLeadMs = options.minLeadMs ?? MIN_SCHEDULE_LEAD_MS;
  const maxLeadMs = options.maxLeadMs ?? MAX_SCHEDULE_LEAD_MS;
  const leadMs = scheduledAt.getTime() - reference.getTime();
  if (leadMs < minLeadMs) {
    throw new Error(`scheduled time must be at least 2 hours ahead: ${formatScheduleTime(scheduledAt)}`);
  }
  if (leadMs > maxLeadMs) {
    throw new Error(`scheduled time must be within 14 days: ${formatScheduleTime(scheduledAt)}`);
  }
  return { scheduledAt, leadMs };
}

function validateJob(job, options = {}) {
  if (!job || typeof job !== "object") throw new Error("job is required");
  const images = Array.isArray(job.images) ? job.images.filter(Boolean) : [];
  if (images.length !== 1) throw new Error(`exactly 1 image is required per post; received ${images.length}`);

  const title = String(job.title || "").trim();
  if (!title) throw new Error("title is required");
  if (textCharacters(title) > MAX_TITLE_CHARACTERS) {
    throw new Error(`title exceeds ${MAX_TITLE_CHARACTERS} characters: ${title}`);
  }

  const topics = normalizeTopics(job.hashtags || job.tags || []);
  if (topics.length !== 3) throw new Error(`exactly 3 topics are required; received ${topics.length}`);
  if (new Set(topics).size !== 3) throw new Error("topics must be unique within one post");
  if (topics.some((topic) => /\s/.test(topic.slice(1)) || topic.includes("-"))) {
    throw new Error("topics cannot contain whitespace or half-width hyphens");
  }

  const musicKeyword = String(job.music_keyword || job.musicKeyword || job.music || job.bgm || "").trim();
  if (!musicKeyword) throw new Error("an explicit BGM name is required");

  const scheduledAt = parseLocalDateTime(job.scheduled_at || job.schedule_at || job.publish_time);
  if (options.requireScheduleWindow !== false) {
    validateScheduleWindow(scheduledAt, options.now || new Date(), options);
  }

  return {
    ...job,
    images,
    title,
    hashtags: topics,
    music_keyword: musicKeyword,
    scheduled_at: scheduledAt,
    scheduled_at_text: formatScheduleTime(scheduledAt)
  };
}

function collectDuplicates(items, keyFn) {
  const seen = new Map();
  const duplicates = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) duplicates.push(key);
    else seen.set(key, item);
  }
  return duplicates;
}

function validateBatch(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("batch contains no publishable images");
  const ordered = items.slice().sort((a, b) => a.publish_number - b.publish_number);
  const errors = [];

  const duplicateChecks = [
    ["image number", (item) => item.image_number],
    ["publish number", (item) => item.publish_number],
    ["publish time", (item) => item.scheduled_at_text],
    ["topic combination", (item) => item.topics.join(" ")],
    ["BGM or variant", (item) => normalizeSongKey(item.bgm)]
  ];
  for (const [label, keyFn] of duplicateChecks) {
    for (const duplicate of collectDuplicates(ordered, keyFn)) {
      errors.push(`duplicate ${label}: ${duplicate}`);
    }
  }

  const firstPublishNumber = ordered[0].publish_number;
  const publishedThrough = Number(options.publishedThrough || 0);
  if (!Number.isInteger(publishedThrough) || publishedThrough < 0) {
    errors.push("published_through must be a non-negative integer");
  } else if (firstPublishNumber !== publishedThrough + 1) {
    errors.push(`first remaining publish number must be ${publishedThrough + 1} after published_through=${publishedThrough}`);
  }
  ordered.forEach((item, index) => {
    const expected = firstPublishNumber + index;
    if (item.publish_number !== expected) {
      errors.push(`publish numbers must be contiguous; expected ${expected} but found ${item.publish_number}`);
    }
    try {
      validateJob(
        {
          images: [item.path],
          title: item.title,
          hashtags: item.topics,
          music_keyword: item.bgm,
          scheduled_at: item.scheduled_at
        },
        {
          requireScheduleWindow: options.requireScheduleWindow !== false,
          now: options.now || new Date(),
          minLeadMs: options.minLeadMs,
          maxLeadMs: options.maxLeadMs
        }
      );
    } catch (error) {
      errors.push(`${item.filename}: ${error.message}`);
    }
  });

  const byTime = ordered.slice().sort((a, b) => a.scheduled_at - b.scheduled_at);
  if (byTime.some((item, index) => item.publish_number !== ordered[index].publish_number)) {
    errors.push("publish numbers are not ordered by scheduled time");
  }

  const perDay = new Map();
  for (const item of ordered) {
    const key = dateKey(item.scheduled_at);
    perDay.set(key, (perDay.get(key) || 0) + 1);
  }
  for (const [day, count] of perDay) {
    if (count > MAX_POSTS_PER_DAY) errors.push(`more than ${MAX_POSTS_PER_DAY} posts scheduled on ${day}`);
  }

  if (!String(options.startDate || "").trim()) {
    errors.push("batch start_date is required");
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(options.startDate))) {
      errors.push("batch start_date must use YYYY-MM-DD");
    } else if (ordered.some((item) => dateKey(item.scheduled_at) < options.startDate)) {
      errors.push(`scheduled item is earlier than batch start_date ${options.startDate}`);
    }
  }
  if (!String(options.batchId || "").trim()) errors.push("batch_id is required");

  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.code = "BATCH_VALIDATION_FAILED";
    error.errors = errors;
    throw error;
  }

  return {
    status: "PASS",
    count: ordered.length,
    first_publish_number: ordered[0].publish_number,
    last_publish_number: ordered.at(-1).publish_number,
    published_through: publishedThrough,
    first_scheduled_at: ordered[0].scheduled_at_text,
    last_scheduled_at: ordered.at(-1).scheduled_at_text,
    batch_id: options.batchId,
    items: ordered
  };
}

function assertPublishAuthorization({ publish, dryRun, expectedBatchId, authorization }) {
  if (!publish || dryRun) return { authorized: false, reason: "dry-run" };
  const batchId = String(expectedBatchId || "").trim();
  if (!batchId) throw new Error("real publish blocked: batch_id is missing");
  if (String(authorization || "").trim() !== batchId) {
    throw new Error("real publish blocked: DOUYIN_AUTHORIZED_BATCH_ID must exactly match batch_id");
  }
  return { authorized: true, batch_id: batchId };
}

function parseUsageCount(value) {
  const text = String(value || "").replace(/,/g, "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*([万亿]?)人使用/);
  if (!match) return -1;
  const number = Number(match[1]);
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  return Math.round(number * multiplier);
}

module.exports = {
  ACCEPTED_MANAGEMENT_STATUSES,
  MAX_POSTS_PER_DAY,
  MAX_SCHEDULE_LEAD_MS,
  MAX_TITLE_CHARACTERS,
  MIN_SCHEDULE_LEAD_MS,
  assertPublishAuthorization,
  dateKey,
  formatScheduleTime,
  normalizeSongKey,
  normalizeTopics,
  parseLocalDateTime,
  parseStrictFilename,
  parseUsageCount,
  textCharacters,
  validateBatch,
  validateJob,
  validateScheduleWindow
};
