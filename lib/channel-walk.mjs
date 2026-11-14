// Walk one YouTube channel tab page by page, and say what happened on every page.
//
// A tools/call response does not carry the scraped data at the top level. The path is
// result.content[0].text (a string), parsed as JSON, then `.json` inside it. requestMetadata
// lives in that same parsed object. A tab's entries land in `sections` (each with an `items`
// array) or under a tab-specific array such as `videos` or `shorts`; a successfully empty
// result simply has no such key, which is a natural end and not a failure.
//
// The caller supplies rpc(method, params) -> { raw, body }, the same shape the contract tests
// use, so this module never touches fetch, a key, or the network itself.
//
// The returned `resumeToken` is the paginationToken to pass back as options.paginationToken
// to retry the page that was rate-limited or otherwise failed, or to continue after maxPages.

export const CHANNEL_TOOL = 'hasdata_youtube_channel_getYoutubeChannel';

export const PAGE_STATUS = Object.freeze({
  SUCCESS: 'success', // entries were returned
  EMPTY: 'empty', // the call succeeded but the tab had nothing to report
  RATE_LIMITED: 'rate_limited', // concurrency_limit survived every retry
  FAILED: 'failed', // isError, 401, a malformed envelope, or an rpc that threw
});

export const OUTCOME = Object.freeze({
  COMPLETED: 'completed', // no next token, or an empty page: the tab is exhausted
  TRUNCATED: 'truncated', // maxPages was reached while a next page existed
  RATE_LIMITED: 'rate_limited', // stopped on a page that never got past concurrency_limit
  FAILED: 'failed', // stopped on any other failure
});

// Where a tab keeps its entries. Keys are tried in order, then the generic keys. A channel
// response documented in this repo puts content in `sections`, each section carrying `items`,
// while tab-specific payloads name the array after the tab. `items` covers payloads that put
// the page's entries at the top level.
const TAB_ITEM_KEYS = Object.freeze({
  featured: ['sections', 'items'],
  videos: ['videos', 'videoResults', 'videoItems', 'sections', 'items'],
  shorts: ['shorts', 'shortsResults', 'shortsItems', 'sections', 'items'],
  streams: ['streams', 'liveStreams', 'streamItems', 'sections', 'items'],
  playlists: ['playlists', 'playlistResults', 'sections', 'items'],
  posts: ['posts', 'communityPosts', 'postItems', 'sections', 'items'],
  community: ['posts', 'communityPosts', 'postItems', 'sections', 'items'],
  podcasts: ['podcasts', 'episodes', 'sections', 'items'],
  releases: ['releases', 'albums', 'sections', 'items'],
  about: ['about', 'sections', 'items'],
  store: ['store', 'products', 'sections', 'items'],
});

const GENERIC_ITEM_KEYS = ['sections', 'items'];

const DEFAULTS = Object.freeze({
  maxPages: Infinity,
  maxConcurrencyRetries: 4,
  retryDelayMs: 2_000,
});

/**
 * Walk a channel tab to the end (or to maxPages), page by page.
 *
 * @param {(method: string, params: object) => Promise<{raw: string, body: object}>} rpc
 * @param {string} channelId Canonical UC… id or @handle.
 * @param {string} [tab] One of the values the channel tool accepts; defaults to featured.
 * @param {object} [options]
 * @param {number} [options.maxPages] Stop after this many calls this run. Default: no limit.
 * @param {string} [options.paginationToken] Resume token from a previous run's `resumeToken`.
 * @param {string} [options.resumeToken] Accepts a prior result's own `resumeToken` under its
 *   name. Same meaning as `paginationToken`, which wins when both are set.
 * @param {number} [options.maxConcurrencyRetries] Retries after a concurrency_limit response.
 * @param {number} [options.retryDelayMs] Base wait; retry n waits retryDelayMs * n.
 * @param {(ms: number) => Promise<void>} [options.sleep] Injectable wait, for tests.
 * @param {boolean} [options.includeData] Attach the scraped `json` to each page. Default: true.
 * @param {(page: object) => void|Promise<void>} [options.onPage] Called after every page,
 *   including a failed one, so an unattended run can report progress as it goes.
 * @returns {Promise<object>} `{ channelId, tab, pages, pageCount, itemCount, outcome,
 *   outcomeReason, resumeToken, resumedFrom, lastPage }`.
 */
export async function walkChannelTab(rpc, channelId, tab = 'featured', options = {}) {
  if (typeof rpc !== 'function') throw new TypeError('walkChannelTab needs an rpc function');
  if (typeof channelId !== 'string' || channelId.trim() === '') {
    throw new TypeError('channelId must be a non-empty string');
  }
  if (typeof tab !== 'string' || tab.trim() === '') {
    throw new TypeError('tab must be a non-empty string');
  }

  const opts = options ?? {};
  const maxPages = normalizeMaxPages(opts.maxPages);
  const maxConcurrencyRetries = normalizeRetries(opts.maxConcurrencyRetries);
  const retryDelayMs = normalizeDelay(opts.retryDelayMs);
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const includeData = opts.includeData !== false;
  const itemKeys = TAB_ITEM_KEYS[tab] ?? GENERIC_ITEM_KEYS;

  const resumedFrom = readToken(
    opts.paginationToken ?? opts.resumeToken,
    opts.paginationToken != null ? 'paginationToken' : 'resumeToken'
  );
  let token = resumedFrom;
  const seenTokens = new Set();
  if (token) seenTokens.add(token);

  const pages = [];
  let outcome = null;
  let outcomeReason = null;
  let resumeToken = null;

  while (pages.length < maxPages) {
    const requestToken = token;
    const page = await fetchPage(rpc, channelId, tab, requestToken, itemKeys, {
      maxConcurrencyRetries,
      retryDelayMs,
      sleep,
      includeData,
    });
    page.page = pages.length + 1;

    // Detect a token that never advances before reporting the page, so a progress logger sees
    // the page that caused the stop rather than an unmarked page followed by a surprise.
    let loopDetected = false;
    if (page.status === PAGE_STATUS.SUCCESS && page.hasNext) {
      if (page.nextPageToken === requestToken || seenTokens.has(page.nextPageToken)) {
        page.loopDetected = true;
        loopDetected = true;
      }
    }
    pages.push(page);

    // Every page is reported, failures included, so an unattended run can log each attempt
    // as it happens instead of only learning the outcome at the end.
    if (opts.onPage) await opts.onPage(page);

    if (page.status === PAGE_STATUS.RATE_LIMITED || page.status === PAGE_STATUS.FAILED) {
      outcome = page.status === PAGE_STATUS.RATE_LIMITED ? OUTCOME.RATE_LIMITED : OUTCOME.FAILED;
      outcomeReason = page.reason;
      // The token this page was requested with is the one that retries this page. On the
      // first page it is null, which correctly means "start again from the top".
      resumeToken = requestToken;
      break;
    }

    // An empty page is the documented shape of an exhausted tab: requestMetadata.status is
    // ok and the data key is absent. It ends the walk normally, even if a token came back.
    if (page.status === PAGE_STATUS.EMPTY) {
      outcome = OUTCOME.COMPLETED;
      break;
    }

    if (loopDetected) {
      // A repeated token would loop forever. Stop and surface it rather than spending credits.
      outcome = OUTCOME.FAILED;
      outcomeReason = `pagination token did not advance on page ${page.page}`;
      resumeToken = requestToken;
      break;
    }

    if (!page.hasNext) {
      outcome = OUTCOME.COMPLETED;
      break;
    }

    const nextToken = page.nextPageToken;
    if (pages.length >= maxPages) {
      outcome = OUTCOME.TRUNCATED;
      outcomeReason = `stopped at maxPages=${maxPages} with page ${page.page} reporting a next page`;
      resumeToken = nextToken;
      break;
    }

    seenTokens.add(nextToken);
    token = nextToken;
  }

  // maxPages can only be reached through the truncation branch above, but a defensive
  // fallback keeps the contract ("outcome is always set") true if the loop is ever edited.
  if (outcome === null) {
    const last = pages[pages.length - 1];
    if (last?.status === PAGE_STATUS.EMPTY) {
      outcome = OUTCOME.COMPLETED;
    } else if (last?.hasNext) {
      outcome = OUTCOME.TRUNCATED;
      outcomeReason = `stopped at maxPages=${maxPages} with more pages available`;
      resumeToken = last.nextPageToken;
    } else {
      outcome = OUTCOME.COMPLETED;
    }
  }

  return {
    channelId,
    tab,
    resumedFrom,
    pages,
    pageCount: pages.length,
    itemCount: pages.reduce((total, page) => total + page.itemCount, 0),
    outcome,
    outcomeReason,
    resumeToken,
    lastPage: pages[pages.length - 1] ?? null,
  };
}

async function fetchPage(rpc, channelId, tab, requestToken, itemKeys, opts) {
  let attempts = 0;
  let waitedMs = 0;

  for (;;) {
    attempts += 1;
    const args = { channelId, tab };
    if (requestToken) args.paginationToken = requestToken;

    let call;
    try {
      call = await rpc('tools/call', { name: CHANNEL_TOOL, arguments: args });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (mentionsConcurrency(reason)) {
        if (attempts <= opts.maxConcurrencyRetries) {
          waitedMs += await waitBeforeRetry(opts, attempts);
          continue;
        }
        return failedPage(PAGE_STATUS.RATE_LIMITED, attempts, waitedMs, requestToken, {
          reason: `concurrency_limit persisted after ${attempts} attempts (rpc threw: ${reason})`,
        });
      }
      return failedPage(PAGE_STATUS.FAILED, attempts, waitedMs, requestToken, {
        reason: `rpc threw: ${reason}`,
      });
    }

    const signal = classifyFailure(call);

    if (signal === 'concurrency') {
      if (attempts <= opts.maxConcurrencyRetries) {
        waitedMs += await waitBeforeRetry(opts, attempts);
        continue;
      }
      return failedPage(PAGE_STATUS.RATE_LIMITED, attempts, waitedMs, requestToken, {
        reason: `concurrency_limit persisted after ${attempts} attempts`,
      });
    }

    if (signal === 'unauthorized') {
      return failedPage(PAGE_STATUS.FAILED, attempts, waitedMs, requestToken, {
        reason: 'HasData API error: 401 Unauthorized',
      });
    }

    const read = readEnvelope(call?.body);
    if (read.failure) {
      return failedPage(PAGE_STATUS.FAILED, attempts, waitedMs, requestToken, {
        reason: read.failure,
      });
    }

    const { data, requestMetadata, envelope, pagination } = read;
    const items = resolveItems(data, itemKeys);
    let nextPageToken;
    try {
      nextPageToken = readToken(pagination?.nextPageToken, 'pagination.nextPageToken');
    } catch (err) {
      return failedPage(PAGE_STATUS.FAILED, attempts, waitedMs, requestToken, {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const status = items.itemCount === 0 ? PAGE_STATUS.EMPTY : PAGE_STATUS.SUCCESS;

    const page = {
      status,
      attempts,
      waitedMs,
      itemCount: items.itemCount,
      itemsKey: items.key,
      // True when the success carried none of the keys this tab should have produced. It is
      // still an empty page, not a failure, but the distinction is useful in a report.
      missingDataKey: status === PAGE_STATUS.EMPTY && !items.present,
      hasNext: Boolean(nextPageToken),
      paginationToken: requestToken,
      nextPageToken,
      requestMetadata,
      reason: null,
    };

    if (opts.includeData) {
      page.data = data;
      // Keep the unwrapped envelope too: it carries `url`, `status` and `text` that a report
      // may want to quote. `data` stays the scraped `json` so callers do not re-navigate.
      page.envelope = envelope;
    }

    return page;
  }
}

function failedPage(status, attempts, waitedMs, requestToken, extra) {
  return {
    status,
    attempts,
    waitedMs,
    itemCount: 0,
    itemsKey: null,
    missingDataKey: false,
    hasNext: false,
    paginationToken: requestToken,
    nextPageToken: null,
    requestMetadata: null,
    reason: extra.reason,
  };
}

function readEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { failure: 'the rpc response carried no JSON-RPC body' };
  }
  if (body.error) {
    return { failure: `JSON-RPC error: ${messageOf(body.error)}` };
  }

  const result = body.result;
  if (!result || typeof result !== 'object') {
    return { failure: 'the JSON-RPC response carried no result' };
  }
  if (result.isError) {
    return { failure: toolText(result) || 'the tool returned isError' };
  }

  const text = Array.isArray(result.content)
    ? result.content.find((entry) => typeof entry?.text === 'string')?.text
    : undefined;
  if (typeof text !== 'string' || text.trim() === '') {
    return { failure: 'the tool result carried no text block' };
  }

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { failure: 'the tool result text was not valid JSON' };
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { failure: 'the tool result text was not a JSON object' };
  }

  const requestMetadata = envelope.requestMetadata ?? envelope.json?.requestMetadata ?? null;
  if (requestMetadata?.status && requestMetadata.status !== 'ok') {
    const detail = typeof envelope.text === 'string' && envelope.text.trim() ? `: ${envelope.text}` : '';
    return { failure: `requestMetadata.status was ${requestMetadata.status}${detail}` };
  }
  if (envelope.status === 'error') {
    const detail = typeof envelope.text === 'string' && envelope.text.trim() ? `: ${envelope.text}` : '';
    return { failure: `the tool envelope reported an error${detail}` };
  }

  // A successful-but-empty result omits `json` entirely; that is an empty page, not an error.
  const data = envelope.json && typeof envelope.json === 'object' && !Array.isArray(envelope.json)
    ? envelope.json
    : {};

  // The token is documented inside the scraped data, but an envelope that carries the
  // pagination block beside `json` is read too rather than silently ending the walk.
  const pagination = data.pagination ?? envelope.pagination ?? null;

  return { data, requestMetadata, envelope, pagination };
}

function resolveItems(data, itemKeys) {
  // Prefer the key that actually holds entries: a page can carry an empty array beside a
  // populated one, and reporting the empty one would call a full page empty.
  let firstPresent = null;
  for (const key of [...itemKeys, ...GENERIC_ITEM_KEYS]) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (data[key] === null || data[key] === undefined) continue;
    const itemCount = countItems(key, data[key]);
    if (firstPresent === null) firstPresent = { key, present: true, itemCount };
    if (itemCount > 0) return { key, present: true, itemCount };
  }
  return firstPresent ?? { key: itemKeys[0] ?? null, present: false, itemCount: 0 };
}

function countItems(key, value) {
  if (Array.isArray(value)) {
    return key === 'sections' ? countSectionItems(value) : value.length;
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.items)) return value.items.length;
    // `sections` normally arrives as an array, but an object of named arrays still carries
    // entries; count them rather than calling a populated page empty.
    if (key === 'sections') {
      return Object.values(value).reduce(
        (total, section) => total + (Array.isArray(section) ? section.length : 0),
        0
      );
    }
    // Any other object is metadata (a channel about block, a single channelInfo), not a
    // list of entries, so it does not make an otherwise-empty page non-empty.
    return 0;
  }
  return 0;
}

function countSectionItems(sections) {
  return sections.reduce((total, section) => {
    if (Array.isArray(section?.items)) return total + section.items.length;
    return total;
  }, 0);
}

function toolText(result) {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .map((entry) => (typeof entry?.text === 'string' ? entry.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function messageOf(error) {
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function mentionsConcurrency(value) {
  return textOf(value).toLowerCase().includes('concurrency_limit')
    || textOf(value).toLowerCase().includes('concurrency limit');
}

// Decide whether a response is a rate limit or an auth failure by looking only at the error
// surfaces, never at scraped data: a video titled "401 Unauthorized explained" must not end
// the walk. Scraped text lives in result.content[0].text, which is the envelope JSON, so it
// is only consulted when result.isError is already set. Raw text is a fallback for the case
// where no parseable JSON-RPC body came back at all.
function classifyFailure(call) {
  const body = call?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.error) {
      const error = textOf(body.error);
      if (mentionsConcurrency(error) || body.error.code === 429) return 'concurrency';
      if (error.includes('401') || error.includes('Unauthorized')) return 'unauthorized';
      return null;
    }
    if (body.result?.isError) {
      const content = toolText(body.result);
      if (mentionsConcurrency(content)) return 'concurrency';
      if (content.includes('401 Unauthorized')) return 'unauthorized';
    }
    return null;
  }

  const raw = textOf(call?.raw);
  if (mentionsConcurrency(raw)) return 'concurrency';
  if (raw.includes('401 Unauthorized')) return 'unauthorized';
  return null;
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readToken(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string when present`);
  }
  return value.trim() === '' ? null : value;
}

function normalizeMaxPages(value) {
  if (value === undefined || value === null) return DEFAULTS.maxPages;
  if (value === Infinity) return Infinity;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError('maxPages must be a positive integer or Infinity');
  }
  return value;
}

function normalizeRetries(value) {
  if (value === undefined || value === null) return DEFAULTS.maxConcurrencyRetries;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('maxConcurrencyRetries must be a non-negative integer');
  }
  return value;
}

function normalizeDelay(value) {
  if (value === undefined || value === null) return DEFAULTS.retryDelayMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError('retryDelayMs must be a non-negative finite number');
  }
  return value;
}

async function waitBeforeRetry(opts, attempt) {
  const delay = opts.retryDelayMs * attempt;
  await opts.sleep(delay);
  return delay;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
