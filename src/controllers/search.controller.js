/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — search.controller.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Controller for search functionality. Provides both full search
 *   results with pagination and lightweight autocomplete suggestions.
 *   Both endpoints require a 'keyword' query parameter.
 *
 * @exports
 *   getSearchResults - Express route handler for GET /api/search
 *   getSearchSuggestions - Express route handler for GET /api/search/suggest
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import { extractSearchResults, extractSearchSuggestions } from "../extractors/search.extractor.js";
import { getCache, setCache, TTL } from "../helper/cache.helper.js";
import { addPaginationMeta } from "../helper/pagination.helper.js";
import {
  buildCollectionOutcome,
  buildCachedCollectionOutcome,
  extractCollection,
} from "../helper/collectionOutcome.helper.js";

// ══════════════════════════════════════════════════════════════
// CONTROLLER: SEARCH RESULTS
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Full search results endpoint ----
/**
 * Handles GET /api/search requests with keyword and optional page.
 * Returns paginated search results from the source site.
 *
 * Every response (including cache hits) carries a top-level
 * `collectionOutcome` describing the real scrape chain: the mirror that
 * served the page, the proxy channel, the order mirrors were tried and any
 * terminal upstream rejection. The legacy `success`/`results` shape is
 * untouched so existing consumers keep working.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Sends JSON response with search results
 *
 * @example
 *   GET /api/search?keyword=naruto&page=2
 *   Response: { success: true, results: { anime, ... }, collectionOutcome: {...} }
 *
 * @throws {400} If 'keyword' query parameter is missing
 */
const getSearchResults = async (req, res, next) => {
  try {
    const { keyword, page = 1 } = req.query;
    if (!keyword) {
      return res.status(400).json({ success: false, message: "Keyword is required" });
    }
    const cacheKey = `search_${keyword}_${page}`;
    const cached = getCache(cacheKey);
    if (cached) {
      // NOTE: Cached payload keeps its original scrape trace, but is explicitly
      // stamped fromCache so stale mirror info is never read as a fresh fetch.
      return res.json({
        success: true,
        results: cached.results,
        collectionOutcome: buildCachedCollectionOutcome(cached.collectionOutcome),
      });
    }
    const extracted = await extractSearchResults(keyword, page);
    const { payload, collection } = extractCollection(extracted);
    const response = addPaginationMeta(payload, page);
    const collectionOutcome = buildCollectionOutcome(collection);
    setCache(cacheKey, { results: response, collectionOutcome }, TTL.search);
    res.json({ success: true, results: response, collectionOutcome });
  } catch (error) {
    next(error);
  }
};

// ══════════════════════════════════════════════════════════════
// CONTROLLER: SEARCH SUGGESTIONS
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Search autocomplete suggestions endpoint ----
/**
 * Handles GET /api/search/suggest requests for autocomplete.
 * Returns lightweight suggestion list for the given keyword.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Sends JSON response with suggestion list
 *
 * @example
 *   GET /api/search/suggest?keyword=nar
 *   Response: { success: true, results: [{ id, title, ... }] }
 *
 * @throws {400} If 'keyword' query parameter is missing
 */
const getSearchSuggestions = async (req, res, next) => {
  try {
    const { keyword } = req.query;
    if (!keyword) {
      return res.status(400).json({ success: false, message: "Keyword is required" });
    }
    const cacheKey = `search_suggest_${keyword}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ success: true, results: cached });
    }
    const data = await extractSearchSuggestions(keyword);
    setCache(cacheKey, data, TTL.search);
    res.json({ success: true, results: data });
  } catch (error) {
    next(error);
  }
};

export { getSearchResults, getSearchSuggestions };

// ══════════════════════════════════════════════════════════════ END: search.controller.js