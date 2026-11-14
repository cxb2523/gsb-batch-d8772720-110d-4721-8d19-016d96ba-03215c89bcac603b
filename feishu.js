"use strict";

const fs = require("fs/promises");
const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const path = require("path");
const config = require("./config");
const { MAX_SCHEDULE_LEAD_MS, MIN_SCHEDULE_LEAD_MS } = require("./publish-policy");

let cachedTenantToken = "";
let cachedTenantTokenExpiresAt = 0;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedTenantToken && cachedTenantTokenExpiresAt > now + 60_000) {
    return cachedTenantToken;
  }

  const data = await requestJson(`${config.larkApiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    body: JSON.stringify({
      app_id: requireEnv("LARK_APP_ID"),
      app_secret: requireEnv("LARK_APP_SECRET")
    })
  });

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`failed to get tenant_access_token: ${JSON.stringify(data)}`);
  }

  cachedTenantToken = data.tenant_access_token;
  cachedTenantTokenExpiresAt = now + Math.max(60, data.expire || 7200) * 1000;
  return cachedTenantToken;
}

async function larkApi(apiPath, options = {}) {
  const token = await getTenantAccessToken();
  return requestJson(`${config.larkApiBase}${apiPath}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
}

function extractRecordId(body) {
  return body.record_id || body.recordId || body.record?.record_id || body.record?.id || body.data?.record_id;
}

function extractRequestId(body) {
  return body.request_id || body.requestId || body.record?.request_id || body.data?.request_id;
}

function extractTableId(body) {
  return body.table_id || body.tableId || body.table?.table_id || body.table?.id || body.data?.table_id;
}

function extractBaseToken(body) {
  return body.base_token || body.app_token || body.appToken || body.baseToken || body.data?.base_token || config.defaultBaseToken;
}

async function getRecord(baseToken, tableId, recordId) {
  const data = await larkApi(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`, {
    method: "GET"
  });
  if (data.code !== 0) throw new Error(`failed to get record: ${JSON.stringify(data)}`);
  return data.data.record;
}

async function updateRecord(baseToken, tableId, recordId, fields) {
  const data = await larkApi(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    body: JSON.stringify({ fields })
  });
  if (data.code !== 0) throw new Error(`failed to update record: ${JSON.stringify(data)}`);
  return data.data.record;
}

function looksLikeRecordId(value) {
  return typeof value === "string" && /^rec[a-zA-Z0-9_ -]+$/.test(value.trim());
}

async function listRecords(baseToken, tableId) {
  const records = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);

    const data = await larkApi(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?${params}`, {
      method: "GET"
    });
    if (data.code !== 0) throw new Error(`failed to list records: ${JSON.stringify(data)}`);

    records.push(...(data.data?.items || []));
    pageToken = data.data?.has_more ? data.data?.page_token || "" : "";
  } while (pageToken);

  return records;
}

async function resolveRecordId(baseToken, tableId, recordRef) {
  const ref = String(recordRef || "").trim();
  if (!ref) throw new Error("missing record_id or request_id");
  if (looksLikeRecordId(ref)) return ref;

  const records = await listRecords(baseToken, tableId);
  const matched = records.find((record) => unwrapText(record.fields?.request_id) === ref);
  if (!matched) {
    throw new Error(`request_id not found in table ${tableId}: ${ref}`);
  }
  return matched.record_id;
}

function parseFeishuDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = unwrapText(value);
  if (!text) return null;

  const normalized = text
    .replace(/\//g, "-")
    .replace("T", " ")
    .replace(/\s+/g, " ")
    .trim();

  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeStatus(value) {
  return unwrapText(value).replace(/\s+/g, "").toLowerCase();
}

function statusIn(value, allowed) {
  const normalized = normalizeStatus(value);
  return allowed.some((item) => normalized === normalizeStatus(item));
}

const REVIEW_APPROVED_STATUSES = [
  "通过",
  "审核通过",
  "已通过",
  "已审核",
  "已审核通过",
  "approved",
  "pass",
  "passed"
];

const PUBLISH_READY_STATUSES = [
  "待发布",
  "待发",
  "准备发布",
  "待推送",
  "待发出",
  "ready",
  "ready_to_publish",
  "pending_publish"
];

function isDueForPublish(record, now = new Date()) {
  const fields = record.fields || {};
  const reviewStatus = unwrapText(fields["审核状态"]);
  const publishStatus = unwrapText(fields["发布状态"]);
  const scheduleAt = parseFeishuDate(fields["定时发布时间"]);

  const leadMs = scheduleAt ? scheduleAt.getTime() - now.getTime() : Number.NaN;
  return (
    statusIn(reviewStatus, REVIEW_APPROVED_STATUSES) &&
    statusIn(publishStatus, PUBLISH_READY_STATUSES) &&
    Number.isFinite(leadMs) &&
    leadMs >= MIN_SCHEDULE_LEAD_MS &&
    leadMs <= MAX_SCHEDULE_LEAD_MS
  );
}

function summarizeRecord(record, tableId = "") {
  const fields = record.fields || {};
  return {
    record_id: record.record_id,
    request_id: unwrapText(fields.request_id),
    batch_id: unwrapText(fields["批次ID"] || fields.batch_id),
    anchor: anchorFromFields(tableId, fields),
    title: unwrapText(fields["标题"] || fields["主题"]),
    review_status: unwrapText(fields["审核状态"]),
    publish_status: unwrapText(fields["发布状态"]),
    scheduled_at: unwrapText(fields["定时发布时间"])
  };
}

async function listDuePublishRecords(baseToken, tableId, now = new Date()) {
  const records = await listRecords(baseToken, tableId);
  return records
    .filter((record) => isDueForPublish(record, now))
    .map((record) => ({
      ...summarizeRecord(record, tableId),
      table_id: tableId
    }));
}

function unwrapText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(unwrapText).join("").trim();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.name === "string") return value.name.trim();
    if (typeof value.value === "string") return value.value.trim();
    if (typeof value.link === "string") return value.link.trim();
    if (typeof value.url === "string") return value.url.trim();
  }
  return String(value).trim();
}

function firstUrl(value) {
  const text = unwrapText(value);
  const match = text.match(/https?:\/\/[^\s，,）)]+/i);
  return match ? match[0] : "";
}

function anchorFromFields(tableId, fields) {
  const anchorText = unwrapText(fields["主播"]);
  for (const [alias, anchorKey] of Object.entries(config.anchorAliases || {})) {
    if (alias && anchorText.includes(alias)) return anchorKey;
  }
  return config.tableAnchors[tableId] || Object.keys(config.anchors)[0] || "account1";
}

function extFromContentType(contentType) {
  if (/png/i.test(contentType)) return ".png";
  if (/webp/i.test(contentType)) return ".webp";
  if (/jpeg|jpg/i.test(contentType)) return ".jpg";
  return ".png";
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

function ipv4Number(address) {
  return address.split(".").reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function isForbiddenIpAddress(address) {
  const normalized = String(address || "").trim().toLowerCase().split("%")[0];
  if (net.isIP(normalized) === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4]
    ].some(([base, prefix]) => ipv4InCidr(normalized, base, prefix));
  }
  if (net.isIP(normalized) !== 6) return true;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isForbiddenIpAddress(mapped[1]);
  return normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:");
}

async function resolveSafeImageUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("image URL is invalid");
  }
  if (parsed.protocol !== "https:") throw new Error("image URL must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("image URL must not contain credentials");

  const addresses = net.isIP(parsed.hostname)
    ? [{ address: parsed.hostname, family: net.isIP(parsed.hostname) }]
    : await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isForbiddenIpAddress(address))) {
    throw new Error(`image host is not a public network address: ${parsed.hostname}`);
  }
  return { parsed, addresses };
}

function hasExpectedImageSignature(buffer, contentType) {
  if (/image\/png/i.test(contentType)) {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (/image\/jpe?g/i.test(contentType)) {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (/image\/webp/i.test(contentType)) {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function requestImage(url, addresses) {
  return new Promise((resolve, reject) => {
    const lookup = (_hostname, options, callback) => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    };
    const request = https.get(url, {
      headers: { accept: "image/png,image/jpeg,image/webp" },
      lookup
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url).href });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`image download failed from ${url.hostname}: HTTP ${status}`));
        return;
      }

      const contentType = String(response.headers["content-type"] || "").split(";")[0].trim();
      if (!/^image\/(png|jpe?g|webp)$/i.test(contentType)) {
        response.resume();
        reject(new Error(`image download returned unsupported content type from ${url.hostname}`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > MAX_IMAGE_BYTES) {
        response.resume();
        reject(new Error(`image download exceeds ${MAX_IMAGE_BYTES} bytes`));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          response.destroy(new Error(`image download exceeds ${MAX_IMAGE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      response.on("error", reject);
    });
    request.setTimeout(IMAGE_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error("image download timed out"));
    });
    request.on("error", reject);
  });
}

async function downloadImage(rawUrl, outputDir, name) {
  let nextUrl = rawUrl;
  for (let redirects = 0; redirects <= MAX_IMAGE_REDIRECTS; redirects += 1) {
    const { parsed, addresses } = await resolveSafeImageUrl(nextUrl);
    const result = await requestImage(parsed, addresses);
    if (result.redirect) {
      if (redirects === MAX_IMAGE_REDIRECTS) throw new Error("image download has too many redirects");
      nextUrl = result.redirect;
      continue;
    }
    if (!hasExpectedImageSignature(result.buffer, result.contentType)) {
      throw new Error(`image download content signature does not match ${result.contentType}`);
    }
    const ext = extFromContentType(result.contentType);
    const filePath = path.join(outputDir, `${name}${ext}`);
    await fs.writeFile(filePath, result.buffer);
    return filePath;
  }
  throw new Error("image download has too many redirects");
}

async function recordToDouyinJob({ baseToken, tableId, recordId, requestId }) {
  const resolvedRecordId = await resolveRecordId(baseToken, tableId, recordId || requestId);
  const record = await getRecord(baseToken, tableId, resolvedRecordId);
  const fields = record.fields || {};

  const imageFields = ["封面图", "内容图1", "内容图2", "内容图3", "内容图4", "内容图5"];
  const imageUrls = imageFields.map((name) => firstUrl(fields[name])).filter(Boolean);
  if (imageUrls.length === 0) throw new Error("record has no image URLs in 封面图/内容图1-5");

  const outputDir = path.join(config.downloadsDir, resolvedRecordId);
  await fs.mkdir(outputDir, { recursive: true });
  const images = [];
  for (let index = 0; index < imageUrls.length; index += 1) {
    images.push(await downloadImage(imageUrls[index], outputDir, `image-${index + 1}`));
  }

  const title = unwrapText(fields["标题"] || fields["主题"]);
  const body = unwrapText(fields["正文文案"]);
  const tags = unwrapText(fields["话题标签"]);
  const musicKeyword = unwrapText(fields["音乐关键词"]);
  const scheduledAt = parseFeishuDate(fields["定时发布时间"]);

  return {
    record,
    record_id: resolvedRecordId,
    request_id: unwrapText(fields.request_id),
    job: {
      anchor_key: anchorFromFields(tableId, fields),
      batch_id: unwrapText(fields["批次ID"] || fields.batch_id),
      title,
      body,
      hashtags: tags ? tags.split(/\s+/).filter(Boolean) : [],
      music_keyword: musicKeyword,
      scheduled_at: scheduledAt,
      images
    },
    local_image_dir: outputDir,
    source_image_count: imageUrls.length
  };
}

module.exports = {
  extractBaseToken,
  extractTableId,
  extractRecordId,
  extractRequestId,
  getRecord,
  updateRecord,
  listRecords,
  listDuePublishRecords,
  isDueForPublish,
  parseFeishuDate,
  isForbiddenIpAddress,
  hasExpectedImageSignature,
  resolveSafeImageUrl,
  resolveRecordId,
  recordToDouyinJob
};
