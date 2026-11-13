/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — extractPages.helper.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   HTTP client utility for fetching and parsing HTML content from
 *   paginated URLs. Uses mirror fallback for resilience and Cheerio
 *   for DOM parsing, with support for page-based pagination.
 *
 * @exports
 *   extractPages
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import * as cheerio from "cheerio";
import { fetchWithMirror } from "./mirror.helper.js";

// ══════════════════════════════════════════════════════════════
// PAGE EXTRACTOR
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Paginated Page Fetcher ----
/**
 * Fetches HTML content from a URL with pagination and mirror fallback.
 * Automatically tries alternative domains if primary fails.
 *
 * @param {string} url - Base URL path to fetch (e.g., "/filter?keyword=naruto")
 * @param {number} [page=1] - Page number to fetch (1-indexed)
 * @returns {Promise<CheerioAPI>} Parsed Cheerio instance of the page
 *
 * @example
 *   const $ = await extractPages("/filter?keyword=one-piece");
 *   const $page2 = await extractPages("/filter?keyword=one-piece", 2);
 */
const extractPages = async (url, page = 1) => {
  const { $ } = await extractPagesWithOutcome(url, page);
  return $;
};

// ---- FEATURE: Paginated fetcher that also returns the collection outcome ----
/**
 * Same resilient fetch as `extractPages`, but additionally returns the
 * verifiable collection outcome produced by `fetchWithMirror`. The requested
 * page number is stamped onto the outcome so a failed multi-page scrape can
 * name the exact page that upstream rejected (e.g. `failedPage: 3`), and the
 * same stamp is attached to a thrown error's `error.collection`.
 *
 * @param {string} url - Base URL path to fetch
 * @param {number} [page=1] - Page number to fetch (1-indexed)
 * @returns {Promise<{$: CheerioAPI, collection: object}>}
 *
 * @example
 *   const { $, collection } = await extractPagesWithOutcome(path, 3);
 *   // collection.failedPage === 3 when page 3 is rejected upstream
 */
const extractPagesWithOutcome = async (url, page = 1) => {
  try {
    // NOTE: Extract path from full URL if needed (e.g., "https://anikototv.to/filter" -> "/filter")
    let path = url;
    if (url.startsWith("http")) {
      try {
        const urlObj = new URL(url);
        path = urlObj.pathname + urlObj.search;
      } catch (e) {
        // NOTE: If URL parsing fails, try regex fallback
        const match = url.match(/https?:\/\/[^/]+(\/.*)/);
        if (match) path = match[1];
      }
    }

    const separator = path.includes("?") ? "&" : "?";
    const fullPath = page > 1 ? `${path}${separator}page=${page}` : path;
    const result = await fetchWithMirror(fullPath);
    const $ = cheerio.load(result.data);
    const collection = { ...result.collection, page, failedPage: null };
    return { $, collection };
  } catch (error) {
    // NOTE: Stamp the page that failed onto the outcome carried by the error
    if (error.collection) {
      error.collection.page = page;
      error.collection.failedPage = page;
    }
    throw error;
  }
};

export { extractPages, extractPagesWithOutcome };
// ══════════════════════════════════════════════════════════════ END: extractPages.helper.js
