/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — collectionOutcome.helper.js
 * Repository: https://github.com/Shineii86/A/attempt-1
 *
 * @description
 *   Builders for the `collectionOutcome` response field carried by
 *   GET /api/search and GET /api/filter. The outcome makes every scrape
 *   auditable: which mirror actually served the document, which proxy
 *   channel delivered it, the order mirrors were tried in, whether the
 *   chain was stopped by a terminal upstream client fault, and whether the
 *   response was replayed from the in-memory cache rather than freshly
 *   scraped.
 *
 *   Nothing here invents data — every field is normalised from the
 *   `collection` object returned by fetchWithMirror / extractPagesWithOutcome
 *   or from the same object attached to a thrown upstream error.
 *
 * @exports
 *   buildCollectionOutcome, buildCachedCollectionOutcome,
 *   extractCollection, toErrorCollectionOutcome
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

// ---- FEATURE: Normalise a freshly scraped collection outcome ----
/**
 * Converts the internal `collection` trace produced by the mirror/proxy
 * helpers into the public `collectionOutcome` response shape.
 *
 * @param {object} collection - Raw trace from extractPagesWithOutcome
 * @returns {object} Public collection outcome
 */
const buildCollectionOutcome = (collection) => ({
  fromCache: false,
  // Mirror domain that actually served the response (null when every mirror failed)
  mirror: collection?.mirror ?? null,
  // Proxy channel that delivered the bytes: "direct" | "scraperapi" |
  // "flaresolverr" | "direct-retry" | null
  proxy: collection?.proxy ?? null,
  // Every mirror domain attempted, in the order they were contacted
  mirrorAttempts: Array.isArray(collection?.mirrorAttempts)
    ? [...collection.mirrorAttempts]
    : [],
  // Every proxy channel attempted inside the proxy fallback, in order
  proxyAttempts: Array.isArray(collection?.proxyAttempts)
    ? [...collection.proxyAttempts]
    : [],
  // Whether the chain stopped because of a terminal upstream client fault
  // (HTTP 400/404 or a structured upstream 4xx body)
  terminated: collection?.terminated === true,
  terminalStatus: collection?.terminalStatus ?? null,
  terminalReason: collection?.terminalReason ?? null,
  // Page this outcome describes; failedPage is set when that page was rejected
  page: collection?.page ?? 1,
  failedPage: collection?.failedPage ?? null,
});

// ---- FEATURE: Mark an outcome stored in / read from the cache ----
/**
 * Returns a cache-hit copy of a stored outcome. The original mirror data is
 * preserved for forensics but `fromCache` flips to true so callers never
 * mistake a stale mirror record for a fresh scrape.
 *
 * @param {object} storedOutcome - Outcome persisted alongside the cached payload
 * @returns {object} Cache-hit collection outcome
 */
const buildCachedCollectionOutcome = (storedOutcome) => ({
  ...buildCollectionOutcome(storedOutcome),
  fromCache: true,
});

// ---- FEATURE: Split the scrape trace from the extractor payload ----
/**
 * Extractors return `{ totalPages, data, collection }`. The pagination
 * helper must only see the first two, so the trace is peeled off here.
 *
 * @param {object} extracted - Extractor return value
 * @returns {{payload: object, collection: object}}
 */
const extractCollection = (extracted) => {
  const { collection, ...payload } = extracted;
  return { payload, collection };
};

// ---- FEATURE: Build an outcome for a terminal upstream error ----
/**
 * Normalises the `collection` trace attached to an error thrown by
 * fetchWithMirror into the public shape. Used on the error-response path so
 * terminal 4xx answers still explain where and why the chain stopped.
 *
 * @param {Error} error - Error possibly carrying a `collection` trace
 * @returns {object|null} Public collection outcome, or null when untraceable
 */
const toErrorCollectionOutcome = (error) => {
  if (!error?.collection) return null;
  return {
    ...buildCollectionOutcome(error.collection),
    // Errors only reach this path when the scrape failed; make the failure
    // page explicit even when the mirror helper did not classify it as a
    // terminal client fault (e.g. all mirrors exhausted).
    failedPage: error.collection.failedPage ?? error.collection.page ?? null,
  };
};

export {
  buildCollectionOutcome,
  buildCachedCollectionOutcome,
  extractCollection,
  toErrorCollectionOutcome,
};

// ══════════════════════════════════════════════════════════════ END: collectionOutcome.helper.js
