/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — spotlight.extractor.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Extracts spotlight/featured anime items from the homepage.
 *   Scrapes the "hottest" carousel section for trending anime.
 *
 * @exports
 *   extractSpotlight
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import * as cheerio from "cheerio";
import { URLS } from "../configs/dataUrl.js";
import { fetchWithMirror } from "../helper/mirror.helper.js";

// ══════════════════════════════════════════════════════════════
// SPOTLIGHT EXTRACTION
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Extract featured/spotlight anime from homepage ----
/**
 * Fetches and parses the spotlight carousel from the homepage.
 * Returns an array of featured anime with metadata like poster, title,
 * rating, quality, and episode counts.
 *
 * @returns {Promise<Array<Object>>} Array of spotlight anime objects
 * @returns {string} return.slug - URL slug for the anime
 * @returns {string} return.poster - Poster image URL
 * @returns {string} return.title - English title
 * @returns {string} return.japaneseTitle - Japanese title
 * @returns {string} return.description - Short description
 * @returns {string} return.rating - Anime rating
 * @returns {string} return.quality - Video quality (e.g., HD)
 * @returns {number} return.sub - Subbed episode count
 * @returns {number} return.dub - Dubbed episode count
 * @returns {string} return.date - Release date
 *
 * @example
 *   const spotlights = await extractSpotlight();
 *   console.log(spotlights[0].title);
 */
const extractSpotlight = async () => {
  try {
    const { data } = await fetchWithMirror("/home");
    const $ = cheerio.load(data);

    const spotlights = [];

    // NOTE: Dual selector — new layout (2026-10): #hotest .swiper-slide with
    // .cover img, h2.ak-title, .ak-desc, .ak-detail spans, a.btn.btn-primary.
    // Old layout: .swiper-slide.item with a.play, .image div[style], h2.title,
    // .desc, i.rating/i.quality/i.sub/i.dub/i.date. Both remain supported.
    $("#hotest .swiper-slide").each((i, el) => {
      const watchHref = $(el).find("a.play, a.btn.btn-primary").attr("href") || "";
      const slug = watchHref.split("/watch/").pop() || "";
      const poster =
        $(el).find(".cover img").attr("src") ||
        $(el).find(".image div").attr("style")?.match(/url\(['"]?(.+?)['"]?\)/)?.[1] ||
        "";
      const titleEl = $(el).find("h2.ak-title.d-title, h2.title.d-title").first();
      const title = titleEl.text().trim() || "";
      const japaneseTitle = titleEl.attr("data-jp") || "";
      const description = $(el).find(".ak-desc, .desc").text().trim() || "";
      // NOTE: New layout packs type/date/rating into .ak-detail span.it list
      const detailItems = $(el)
        .find(".ak-detail span.it")
        .map((_, s) => $(s).text().trim())
        .get();
      const rating =
        $(el).find("i.rating").text().trim() ||
        detailItems.find((t) => /^\d{1,2}\.\d+$/.test(t)) ||
        "";
      const quality = $(el).find("i.quality").text().trim() || "";
      const sub = parseInt($(el).find("i.sub").text().trim()) || 0;
      const dub = parseInt($(el).find("i.dub").text().trim()) || 0;
      const date =
        $(el).find("i.date").text().trim() ||
        (detailItems.length > 1 ? detailItems[1] : "");
      const type = detailItems[0] || "";

      if (slug) {
        spotlights.push({
          slug,
          poster,
          title,
          japaneseTitle,
          description,
          rating,
          quality,
          sub,
          dub,
          date,
          type
        });
      }
    });

    return spotlights;
  } catch (error) {
    throw error;
  }
};

export { extractSpotlight };

// ══════════════════════════════════════════════════════════════ END: spotlight.extractor.js
