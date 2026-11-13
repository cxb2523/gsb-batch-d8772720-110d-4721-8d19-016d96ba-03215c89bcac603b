/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — episodeLatest.controller.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Controller for the latest-episode checker. Returns just the newest
 *   episode for an anime — built for bots and notification jobs that
 *   only need "is there a new episode?" without the full episode list.
 *
 * @exports
 *   getLatestEpisode - Express route handler for GET /api/episodes/latest
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import { extractEpisodeList } from "../extractors/episodeList.extractor.js";
import { getCache, setCache, TTL } from "../helper/cache.helper.js";

// ══════════════════════════════════════════════════════════════
// CONTROLLER: LATEST EPISODE
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Latest episode checker endpoint ----
/**
 * Handles GET /api/episodes/latest requests. Extracts the episode list
 * (cached) and returns only the newest episode plus summary counts.
 * Requires 'slug' query param.
 *
 * NOTE: Registered before /api/episodes/:id so the literal path wins
 * the route match — Express evaluates routes in registration order.
 *
 * @param {object} req - Express request object
 * @param {string} [req.query.slug] - Anime slug (or numeric anime ID)
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void} Sends JSON response with the latest episode
 *
 * @example
 *   GET /api/episodes/latest?slug=one-piece-odmau
 *   Response: {
 *     success: true,
 *     results: {
 *       slug, animeId, totalEpisodes,
 *       latest: { episode_no, title, id, href, server_ids, mal_id }
 *     }
 *   }
 *
 * @throws {400} If 'slug' query parameter is missing
 * @throws {404} If no episodes are found for the anime
 */
const getLatestEpisode = async (req, res, next) => {
  try {
    const { slug } = req.query;
    if (!slug) {
      return res.status(400).json({ success: false, message: "Anime slug is required (?slug=)" });
    }

    const cacheKey = `ep_latest_${slug}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ success: true, results: cached });
    }

    // NOTE: Reuses the episode-list extractor — same upstream call, and
    // its 10min TTL cache means repeated bot polls cost one AJAX hit
    const data = await extractEpisodeList(slug);
    const episodes = data?.episodes || [];

    if (!episodes.length) {
      return res.status(404).json({ success: false, message: "No episodes found for this anime" });
    }

    // NOTE: Episode numbers arrive as numbers — plain max reduce beats
    // assuming list order (some anime are listed non-sequentially)
    const latest = episodes.reduce((newest, ep) =>
      (ep.episode_no > newest.episode_no ? ep : newest), episodes[0]);

    const result = {
      slug: data.slug || slug,
      animeId: data.animeId || 0,
      totalEpisodes: data.totalEpisodes || episodes.length,
      latest: {
        episode_no: latest.episode_no,
        title: latest.title || "",
        id: latest.id || null,
        slug: latest.slug || "",
        href: latest.href || "",
        server_ids: latest.server_ids || "",
        mal_id: latest.mal_id || null,
      },
    };

    setCache(cacheKey, result, TTL.episodes);
    res.json({ success: true, results: result });
  } catch (error) {
    next(error);
  }
};

export { getLatestEpisode };

// ══════════════════════════════════════════════════════════════ END: episodeLatest.controller.js
