/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — filter.controller.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Controller for advanced anime filtering. Accepts multiple query
 *   parameters to filter anime by genre, year, season, type, status,
 *   and more. All parameters are forwarded to the extractor.
 *
 * @exports
 *   getFilter - Express route handler for GET /api/filter
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import { extractFilter } from "../extractors/filter.extractor.js";
import { getCache, setCache, TTL } from "../helper/cache.helper.js";
import { addPaginationMeta } from "../helper/pagination.helper.js";
import {
  buildCollectionOutcome,
  buildCachedCollectionOutcome,
  extractCollection,
} from "../helper/collectionOutcome.helper.js";

// ══════════════════════════════════════════════════════════════
// CONTROLLER: FILTER
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Advanced filter endpoint ----
/**
 * Handles GET /api/filter requests. Returns filtered anime list
 * based on provided query parameters.
 *
 * Every response (including cache hits) carries a top-level
 * `collectionOutcome` with the verifiable scrape chain — mirror used, proxy
 * channel, mirror attempt order, terminal upstream faults and the page that
 * failed. The legacy `success`/`results`/`pagination` shape is unchanged.
 *
 * @param {object} req - Express request object
 * @param {string} req.query.genre - Genre filter (optional)
 * @param {string} req.query.year - Year filter (optional)
 * @param {string} req.query.season - Season filter (optional)
 * @param {string} req.query.type - Type filter (optional)
 * @param {string} req.query.status - Status filter (optional)
 * @param {number} req.query.page - Page number (optional, default: 1)
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Sends JSON response with filtered anime list
 *
 * @example
 *   GET /api/filter?genre=action&year=2024&type=tv
 *   Response: { success: true, results: { anime, pagination, ... }, collectionOutcome: {...} }
 * NOTE: The cache key uses JSON.stringify of all params for unique caching
 */
const getFilter = async (req, res, next) => {
  try {
    const params = req.query;
    const page = params.page || 1;
    const cacheKey = `filter_${JSON.stringify(params, Object.keys(params).sort())}`;
    const cached = getCache(cacheKey);
    if (cached) {
      // NOTE: Replay the stored scrape trace but mark it as a cache hit so
      // nobody treats the old mirror data as a freshly observed fetch.
      return res.json({
        success: true,
        results: cached.results,
        collectionOutcome: buildCachedCollectionOutcome(cached.collectionOutcome),
      });
    }
    // Normalize array params to strings
    if (Array.isArray(params.genre)) params.genre = params.genre.join(",");
    if (Array.isArray(params.type)) params.type = params.type.join(",");
    if (Array.isArray(params.status)) params.status = params.status.join(",");
    const extracted = await extractFilter(params);
    const { payload, collection } = extractCollection(extracted);
    const response = addPaginationMeta(payload, page);
    const collectionOutcome = buildCollectionOutcome(collection);
    setCache(cacheKey, { results: response, collectionOutcome }, TTL.genres);
    res.json({ success: true, results: response, collectionOutcome });
  } catch (error) {
    next(error);
  }
};

export { getFilter };

// ══════════════════════════════════════════════════════════════ END: filter.controller.js