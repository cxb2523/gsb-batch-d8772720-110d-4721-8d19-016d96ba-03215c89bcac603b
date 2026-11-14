"use strict";

const {
  dateKey,
  normalizeSongKey,
  parseLocalDateTime,
  textCharacters
} = require("./publish-policy");

const MAX_TITLE_CHARACTERS = 15;

function requiredText(value, field, errors, prefix) {
  const text = String(value || "").trim();
  if (!text) errors.push(`${prefix}.${field} is required`);
  return text;
}

function positiveInteger(value, field, errors, prefix) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    errors.push(`${prefix}.${field} must be a positive integer`);
  }
  return number;
}

function validStartDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3]);
}

function nextDateKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(year, month - 1, day + 1);
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, "0"),
    String(next.getDate()).padStart(2, "0")
  ].join("-");
}

function scheduleSlot(value) {
  const minutes = value.getHours() * 60 + value.getMinutes();
  if (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 20) return "morning";
  if (minutes >= 14 * 60 && minutes <= 19 * 60 + 20) return "afternoon";
  if (minutes >= 20 * 60 + 30 && minutes <= 22 * 60 + 50) return "night";
  return "outside";
}

function validateContentPlan(records, options = {}) {
  const errors = [];
  const startDate = String(options.startDate || "").trim();
  if (!validStartDate(startDate)) {
    errors.push("start_date is required and must use a real YYYY-MM-DD date");
  }
  if (!Array.isArray(records) || records.length === 0) {
    const error = new Error("content plan must contain at least one item");
    error.code = "CONTENT_PLAN_VALIDATION_FAILED";
    error.errors = [error.message];
    throw error;
  }

  const imageNumbers = new Set();
  const publishNumbers = new Set();
  const publishTimes = new Set();
  const topicCombinations = new Set();
  const songKeys = new Map();

  const items = records.map((record, index) => {
    const prefix = `item ${index + 1}`;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      errors.push(`${prefix} must be an object`);
      return null;
    }

    const sourcePath = requiredText(record.source_path, "source_path", errors, prefix);
    const imageNumber = positiveInteger(record.image_number, "image_number", errors, prefix);
    const publishNumber = positiveInteger(record.publish_number, "publish_number", errors, prefix);
    const title = requiredText(record.title, "title", errors, prefix);
    if (textCharacters(title) > MAX_TITLE_CHARACTERS) {
      errors.push(`${prefix}.title exceeds ${MAX_TITLE_CHARACTERS} characters`);
    }

    const topics = Array.isArray(record.topics)
      ? record.topics.map((topic) => String(topic || "").trim())
      : [];
    if (topics.length !== 3 || topics.some((topic) => !topic.startsWith("#") || textCharacters(topic) < 2)) {
      errors.push(`${prefix}.topics must contain exactly 3 non-empty hashtags`);
    }

    const bgm = requiredText(record.bgm, "bgm", errors, prefix);
    const artist = requiredText(record.artist, "artist", errors, prefix);
    const publishTimeText = requiredText(record.publish_time, "publish_time", errors, prefix);
    let publishTime = null;
    try {
      publishTime = parseLocalDateTime(publishTimeText);
      if (scheduleSlot(publishTime) === "outside") {
        errors.push(`${prefix}.publish_time is outside the configured morning, afternoon, commute, and night ranges`);
      }
    } catch (error) {
      errors.push(`${prefix}.publish_time ${error.message}`);
    }

    if (imageNumbers.has(imageNumber)) errors.push(`duplicate image_number: ${imageNumber}`);
    imageNumbers.add(imageNumber);
    if (publishNumbers.has(publishNumber)) errors.push(`duplicate publish_number: ${publishNumber}`);
    publishNumbers.add(publishNumber);
    if (publishTimes.has(publishTimeText)) errors.push(`duplicate publish_time: ${publishTimeText}`);
    publishTimes.add(publishTimeText);

    const topicKey = topics.join(" ");
    if (topics.length === 3 && topicCombinations.has(topicKey)) {
      errors.push(`duplicate topic combination: ${topicKey}`);
    }
    topicCombinations.add(topicKey);

    const songKey = normalizeSongKey(bgm);
    if (songKey && songKeys.has(songKey)) {
      errors.push(`duplicate BGM or variant: ${bgm} / ${songKeys.get(songKey)}`);
    } else if (songKey) {
      songKeys.set(songKey, bgm);
    }

    return {
      source_path: sourcePath,
      image_number: imageNumber,
      publish_number: publishNumber,
      title,
      topics,
      bgm,
      artist,
      publish_time: publishTimeText,
      scheduled_at: publishTime
    };
  }).filter(Boolean);

  const byPublishNumber = items.slice().sort((a, b) => a.publish_number - b.publish_number);
  byPublishNumber.forEach((item, index) => {
    if (item.publish_number !== index + 1) {
      errors.push(`publish numbers must be contiguous from 1; expected ${index + 1} but found ${item.publish_number}`);
    }
    if (items[index]?.publish_number !== item.publish_number) {
      errors.push("content plan array must be ordered by publish_number");
    }
  });

  const scheduledItems = byPublishNumber.filter((item) => item.scheduled_at);
  if (scheduledItems.some((item, index) => index > 0 && item.scheduled_at <= scheduledItems[index - 1].scheduled_at)) {
    errors.push("publish numbers must be ordered by publish_time");
  }

  const perDay = new Map();
  for (const item of scheduledItems) {
    const day = dateKey(item.scheduled_at);
    const slots = perDay.get(day) || [];
    slots.push(scheduleSlot(item.scheduled_at));
    perDay.set(day, slots);
  }
  const orderedDays = [...perDay.keys()].sort();
  if (validStartDate(startDate) && orderedDays[0] !== startDate) {
    errors.push(`first scheduled date must equal start_date ${startDate}`);
  }
  orderedDays.forEach((day, index) => {
    const slots = perDay.get(day);
    if (slots.length > 3) errors.push(`more than 3 posts scheduled on ${day}`);
    if (new Set(slots).size !== slots.length) errors.push(`duplicate publishing slot on ${day}`);
    if (index > 0 && day !== nextDateKey(orderedDays[index - 1])) {
      errors.push(`scheduled dates must be consecutive; found gap before ${day}`);
    }
    if (slots.length === 3 && !["morning", "afternoon", "night"].every((slot) => slots.includes(slot))) {
      errors.push(`a three-post day must contain morning, afternoon, and night slots: ${day}`);
    }
  });

  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.code = "CONTENT_PLAN_VALIDATION_FAILED";
    error.errors = errors;
    throw error;
  }

  return {
    status: "PASS",
    count: items.length,
    start_date: startDate,
    first_publish_time: byPublishNumber[0].publish_time,
    last_publish_time: byPublishNumber.at(-1).publish_time,
    items: byPublishNumber
  };
}

module.exports = {
  MAX_TITLE_CHARACTERS,
  scheduleSlot,
  validateContentPlan,
  validStartDate
};
