// One "look at the trend" request, collected into one readable conclusion.
//
// The underlying tool answers one dataType per call, and the raw JSON leaves the caller to
// notice four things that decide whether an answer can be trusted: a cold term comes back as a
// successful but empty series, the newest bucket carries isPartial, the free plan answers 429
// with concurrency_limit instead of queueing, and a revoked key answers 401. This module makes
// each of those explicit on the result instead of handing the caller another raw payload.

export const TOOL_NAME = 'hasdata_google_trends_search_getTrendsData';

// Four attempts means the initial call plus three retries. The free plan's concurrency limit is
// transient, so back off further each time instead of hammering it.
export const MAX_ATTEMPTS = 4;
export const RETRY_DELAYS_MS = Object.freeze([4000, 8000, 16000]);

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Result-shape helpers
// ---------------------------------------------------------------------------

function tryParse(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function hasPayloadKey(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    ('interestOverTime' in value ||
      'timelineData' in value ||
      'geoMap' in value ||
      'interestByRegion' in value ||
      'relatedQueries' in value ||
      'relatedTopics' in value ||
      'timeseries' in value)
  );
}

// A tool result reaches us in one of three shapes: the payload itself, an MCP content block
// whose text is JSON, or HasData's wrapper of {url, status, text, json}. Unwrap all of them so
// the collectors below only ever see the payload.
function unwrapToolResult(value, depth = 0) {
  if (value == null || depth > 5) return {};
  if (typeof value === 'string') {
    const parsed = tryParse(value);
    return parsed === undefined ? {} : unwrapToolResult(parsed, depth + 1);
  }
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return {};

  if (hasPayloadKey(value)) return value;
  if (value.result && typeof value.result === 'object') {
    return unwrapToolResult(value.result, depth + 1);
  }
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (item == null) continue;
      if (typeof item.text === 'string') {
        const parsed = tryParse(item.text);
        if (parsed !== undefined) return unwrapToolResult(parsed, depth + 1);
      }
      if (item.json && typeof item.json === 'object') {
        return unwrapToolResult(item.json, depth + 1);
      }
    }
  }
  if (value.structuredContent && typeof value.structuredContent === 'object') {
    return unwrapToolResult(value.structuredContent, depth + 1);
  }
  if (value.json && typeof value.json === 'object') return unwrapToolResult(value.json, depth + 1);
  if (typeof value.json === 'string') {
    const parsed = tryParse(value.json);
    if (parsed !== undefined) return unwrapToolResult(parsed, depth + 1);
  }
  if (value.data && typeof value.data === 'object') return unwrapToolResult(value.data, depth + 1);
  // HasData's wrapper keeps the payload under `json`; if only the `text` survives, parse it.
  if (typeof value.text === 'string') {
    const parsed = tryParse(value.text);
    if (parsed !== undefined) return unwrapToolResult(parsed, depth + 1);
  }
  return value;
}

function textFromResult(result) {
  if (result == null || typeof result !== 'object') return '';
  if (Array.isArray(result.content)) {
    const texts = result.content
      .filter((item) => item && typeof item.text === 'string')
      .map((item) => item.text);
    if (texts.length) return texts.join('\n');
  }
  if (typeof result.text === 'string') return result.text;
  if (typeof result.message === 'string') return result.message;
  return '';
}

function httpStatusOf(error) {
  if (error == null || typeof error !== 'object') return null;
  const candidates = [
    error.status,
    error.statusCode,
    error.response?.status,
    error.cause?.status,
    error.result?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number') return candidate;
  }
  return null;
}

// Errors can be thrown, but an MCP server answers 200 and puts the failure in the result. Catch
// the second shape before the payload is unwrapped, or a rate limit looks like an empty answer.
function returnedError(result) {
  if (result == null || typeof result !== 'object') return null;
  const layers = [result.result, result].filter((layer) => layer && typeof layer === 'object');
  for (const layer of layers) {
    const status = httpStatusOf(layer);
    if (status === 401 || status === 429) {
      return { message: textFromResult(layer) || `HTTP ${status}`, status };
    }
    if (layer.isError === true) {
      return { message: textFromResult(layer) || 'the tool returned isError: true' };
    }
    // HasData wraps a successful scrape as {url, status: 'ok', text, json} and reports a failed
    // one inside the same envelope. A non-ok status there is a failure, not an empty series.
    if (typeof layer.status === 'string') {
      const word = layer.status.trim().toLowerCase();
      const failed = !['ok', 'success', 'succeeded'].includes(word);
      if (failed && (layer.json == null || layer.json === '') && layer.isError !== false) {
        return {
          message: typeof layer.text === 'string' && layer.text.trim() ? layer.text : layer.status,
        };
      }
    }
    if (layer.ok === false && status !== null) {
      return { message: textFromResult(layer) || `HTTP ${status}`, status };
    }
    if (layer.error != null) {
      const message =
        typeof layer.error === 'string' ? layer.error : errorMessage(layer.error);
      return { message: message || 'the tool returned an error' };
    }
  }
  return null;
}

function errorMessage(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message.trim()) return error.message;
  if (typeof error.error === 'string' && error.error.trim()) return error.error;
  if (error.error && typeof error.error.message === 'string') return error.error.message;
  const text = textFromResult(error);
  if (text.trim()) return text;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function classifyError(error) {
  const message = errorMessage(error);
  const status = httpStatusOf(error);
  if (status === 401 || /unauthorized/i.test(message)) return 'unauthorized';
  if (status === 429 || /concurrency_limit/i.test(message) || /\b429\b/.test(message)) {
    return 'rate_limited';
  }
  return 'failed';
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,\s%]/g, '').replace(/^\+/, '');
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractTimeline(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload == null || typeof payload !== 'object') return [];
  const block = payload.interestOverTime ?? payload.interest_over_time ?? payload.timeseries;
  if (Array.isArray(block)) return block;
  if (block != null && typeof block === 'object') {
    if (Array.isArray(block.timelineData)) return block.timelineData;
    if (Array.isArray(block.timeline_data)) return block.timeline_data;
  }
  if (Array.isArray(payload.timelineData)) return payload.timelineData;
  if (Array.isArray(payload.timeline_data)) return payload.timeline_data;
  return [];
}

function extractGeoEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload == null || typeof payload !== 'object') return [];

  const block = payload.geoMap ?? payload.interestByRegion ?? payload.regions ?? payload.geoMapData;
  if (Array.isArray(block)) return block;
  if (block != null && typeof block === 'object') {
    for (const key of ['geoMap', 'geoMapData', 'regions', 'locations', 'data', 'items', 'entries']) {
      if (Array.isArray(block[key])) return block[key];
    }
    // A map keyed by location is also possible. Keep the key as the name when the value does
    // not already carry one.
    return Object.entries(block).map(([name, value]) =>
      value != null && typeof value === 'object' ? { name, ...value } : { name, value },
    );
  }
  return [];
}

function regionStrength(entry) {
  if (entry == null) return 0;
  if (typeof entry !== 'object') return toNumber(entry) ?? 0;
  for (const key of ['extractedValue', 'strength', 'score', 'value', 'percent', 'interest']) {
    const parsed = toNumber(entry[key]);
    if (parsed !== null) return parsed;
  }
  return 0;
}

// Strongest region first. The original entries are returned untouched, so the caller still sees
// every field the tool sent; only the order is ours.
function sortRegions(entries) {
  return entries
    .map((entry, index) => ({ entry, index, strength: regionStrength(entry) }))
    .sort((a, b) => b.strength - a.strength || a.index - b.index)
    .map(({ entry }) => entry);
}

function extractRelated(payload) {
  if (payload == null || typeof payload !== 'object') return { rising: [], top: [] };
  const block = payload.relatedQueries ?? payload.related ?? payload.relatedQuery;
  if (Array.isArray(block)) {
    // A flat list carries no rising/top split. Treat it as the top group so nothing is lost.
    return { rising: [], top: block };
  }
  const rising = Array.isArray(block?.rising)
    ? block.rising
    : Array.isArray(payload.rising)
      ? payload.rising
      : [];
  const top = Array.isArray(block?.top) ? block.top : Array.isArray(payload.top) ? payload.top : [];
  return { rising, top };
}

function risingLabel(entry) {
  return entry?.value == null ? '' : String(entry.value).trim();
}

// Rising values are labels such as "+300%" or "Breakout". A Breakout carries a sentinel
// extractedValue, so it is grouped on its own and never enters the ranking. For the rest the
// label's own number is the sort key; extractedValue is only a fallback reading of the same
// number and is not more trustworthy.
function splitRising(entries) {
  const ranked = [];
  const breakout = [];
  for (const entry of entries) {
    const label = risingLabel(entry);
    if (label.toLowerCase() === 'breakout') {
      breakout.push(entry);
    } else {
      ranked.push({ entry, index: ranked.length, numeric: toNumber(label) });
    }
  }
  ranked.sort((a, b) => {
    if (a.numeric !== null && b.numeric !== null) {
      return b.numeric - a.numeric || a.index - b.index;
    }
    if (a.numeric !== null) return -1;
    if (b.numeric !== null) return 1;
    return risingLabel(a.entry).localeCompare(risingLabel(b.entry)) || a.index - b.index;
  });
  return { rising: ranked.map(({ entry }) => entry), breakout };
}

function pointHasInterest(point) {
  if (point == null || typeof point !== 'object') return false;
  if (Array.isArray(point.values)) {
    return point.values.some((value) => {
      if (value == null || value.hasData === false) return false;
      const parsed = toNumber(value.extractedValue ?? value.value);
      return parsed !== null && parsed > 0;
    });
  }
  const parsed = toNumber(point.extractedValue ?? point.value);
  return parsed !== null && parsed > 0;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function baseArgs(term, options) {
  const args = { q: term };
  if (options.geo != null && options.geo !== '') args.geo = options.geo;
  if (options.date != null && options.date !== '') args.date = options.date;
  if (options.tz != null) args.tz = options.tz;
  if (options.cat != null && options.cat !== '') args.cat = options.cat;
  if (options.gprop != null && options.gprop !== '') args.gprop = options.gprop;
  return args;
}

function recordFailure(errors, block, attempt) {
  errors[block] = {
    status: attempt.status,
    message: attempt.message,
    attempts: attempt.attempts,
    ...(attempt.code != null ? { code: attempt.code } : {}),
  };
}

async function callWithRetry(block, args, callTool, sleep) {
  let attempts = 0;
  let lastMessage = '';
  let lastCode;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const raw = await callTool(TOOL_NAME, args);
      const surfaced = returnedError(raw);
      if (surfaced) throw surfaced;
      return { ok: true, status: 'ok', payload: unwrapToolResult(raw), attempts };
    } catch (error) {
      const kind = classifyError(error);
      lastMessage = errorMessage(error) || `${block} tool call failed`;
      lastCode = error?.code;

      if (kind === 'unauthorized') {
        // A bad key will not become good by waiting, so this one is never retried.
        return {
          ok: false,
          status: 'unauthorized',
          message: lastMessage,
          attempts,
          code: lastCode,
        };
      }

      if (kind === 'rate_limited' && attempts < MAX_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
        try {
          await sleep(delay);
        } catch {
          // A broken clock must not fail a whole block; retry immediately instead.
        }
        continue;
      }

      return {
        ok: false,
        status: kind === 'rate_limited' ? 'rate_limited' : 'failed',
        message: lastMessage,
        attempts,
        code: lastCode,
      };
    }
  }

  return { ok: false, status: 'rate_limited', message: lastMessage, attempts, code: lastCode };
}

function failureNote(block, attempt) {
  if (attempt.status === 'unauthorized') {
    return `${block} was rejected with 401 Unauthorized and was not retried.`;
  }
  if (attempt.status === 'rate_limited') {
    const waits = RETRY_DELAYS_MS.slice(0, Math.max(0, attempt.attempts - 1));
    const backoff = waits.length ? ` after ${attemptsLabel(waits)} of backoff` : '';
    return `${block} hit the free-plan concurrency limit and still failed after ${attempt.attempts} attempts${backoff}.`;
  }
  return `${block} failed: ${attempt.message}`;
}

function attemptsLabel(waits) {
  return waits.map((ms) => `${ms}ms`).join(', ');
}

/**
 * Collect the three Google Trends blocks for a term into one conclusion object.
 *
 * @param {string} term
 * @param {{geo?: string, date?: string, region?: string, tz?: number, cat?: string|number, gprop?: string}} [options]
 * @param {{callTool: (name: string, args: object) => Promise<any>, sleep?: (ms: number) => Promise<void>}} deps
 * @returns {Promise<object>}
 */
export async function collectTrend(term, options = {}, deps = {}) {
  if (typeof term !== 'string' || !term.trim()) {
    throw new TypeError('collectTrend requires a non-empty term string');
  }
  if (!deps || typeof deps.callTool !== 'function') {
    throw new TypeError('collectTrend requires deps.callTool(name, args)');
  }

  const opts = options != null && typeof options === 'object' ? options : {};
  const pick = (value) => (value === '' || value == null ? null : value);
  const geo = pick(opts.geo);
  const date = pick(opts.date);
  // geoMap chooses its own granularity when region is absent, and that makes the answer hard to
  // read. Always send one explicitly; when the caller did not pick, use the API's own default:
  // country for worldwide, and the first finer level once a geo is set.
  const region = pick(opts.region) ?? (geo ? 'region' : 'country');
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : DEFAULT_SLEEP;
  const base = baseArgs(term, opts);

  const statuses = {};
  const errors = {};
  const notes = [];
  let noInterestReason = null;

  let series = [];
  let droppedPartial = 0;
  let regions = [];
  let rising = [];
  let breakout = [];
  let top = [];

  const timelineResult = await callWithRetry('timeseries', { ...base }, deps.callTool, sleep);

  if (timelineResult.ok) {
    const timeline = extractTimeline(timelineResult.payload);
    for (const point of timeline) {
      if (point?.isPartial === true || point?.isPartial === 'true') {
        droppedPartial += 1;
      } else {
        series.push(point);
      }
    }

    const noInterest = series.length === 0 || series.every((point) => !pointHasInterest(point));
    if (noInterest) {
      const reason =
        timeline.length === 0
          ? 'the timeseries came back empty'
          : series.length === 0
            ? `no complete points remained after dropping ${droppedPartial} partial point(s)`
            : 'every value in the timeseries is zero';
      noInterestReason =
        `No measurable interest for "${term}"${geo ? ` in ${geo}` : ''}${date ? ` over ${date}` : ''}: ` +
        `${reason}. geoMap and relatedQueries were skipped because they cannot improve on an empty series.`;
    } else {
      statuses.timeseries = 'ok';
      if (droppedPartial > 0) {
        notes.push(
          `Dropped ${droppedPartial} partial point(s) marked isPartial before reading the trend.`,
        );
      }
    }
  } else {
    statuses.timeseries = timelineResult.status;
    recordFailure(errors, 'timeseries', timelineResult);
    notes.push(failureNote('timeseries', timelineResult));
  }

  if (noInterestReason) {
    // A cold term costs one call, not three. The remaining blocks cannot improve on a series
    // that has nothing in it, so they are not requested at all.
    statuses.timeseries = 'no_interest';
    statuses.geoMap = 'skipped';
    statuses.relatedQueries = 'skipped';
    notes.push(noInterestReason);
    return buildResult();
  }

  const geoResult = await callWithRetry(
    'geoMap',
    { ...base, dataType: 'geoMap', region },
    deps.callTool,
    sleep,
  );
  if (geoResult.ok) {
    regions = sortRegions(extractGeoEntries(geoResult.payload));
    statuses.geoMap = 'ok';
    if (regions.length === 0) {
      notes.push('geoMap returned no regions for this request.');
    }
  } else {
    statuses.geoMap = geoResult.status;
    recordFailure(errors, 'geoMap', geoResult);
    notes.push(failureNote('geoMap', geoResult));
  }

  const relatedResult = await callWithRetry(
    'relatedQueries',
    { ...base, dataType: 'relatedQueries' },
    deps.callTool,
    sleep,
  );
  if (relatedResult.ok) {
    const related = extractRelated(relatedResult.payload);
    ({ rising, breakout } = splitRising(related.rising));
    top = related.top;
    statuses.relatedQueries = 'ok';
    if (rising.length === 0 && breakout.length === 0 && top.length === 0) {
      notes.push('relatedQueries returned no related queries for this request.');
    }
  } else {
    statuses.relatedQueries = relatedResult.status;
    recordFailure(errors, 'relatedQueries', relatedResult);
    notes.push(failureNote('relatedQueries', relatedResult));
  }

  if (series.length > 0 || regions.length > 0 || rising.length > 0 || top.length > 0) {
    notes.push(
      'Each block is scaled to its own maximum; numbers from the series, regions and related queries are not comparable with each other.',
    );
  }

  return buildResult();

  function buildResult() {
    const timeseriesStatus = statuses.timeseries;
    return {
      term,
      geo,
      date,
      region,
      series,
      droppedPartial,
      // A machine-readable echo of why there is no series, or null when there is one.
      reason: noInterestReason,
      regions,
      rising,
      breakout,
      top,
      status: {
        // The result field is `series`, the dataType is `timeseries`; expose both names so a
        // caller can key off whichever vocabulary its surrounding code already uses.
        series: timeseriesStatus,
        timeseries: timeseriesStatus,
        geoMap: statuses.geoMap,
        relatedQueries: statuses.relatedQueries,
      },
      errors,
      notes,
    };
  }
}

export default collectTrend;
