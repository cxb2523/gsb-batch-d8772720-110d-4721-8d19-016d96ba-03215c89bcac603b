/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — embedProviders.config.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Configuration for direct embed providers (Megavid, AniXo, MegaPlay).
 *   These providers expose iframe-ready player URLs keyed by AniList/MAL
 *   IDs — no scraping and no Cloudflare-challenged requests required.
 *   URL patterns verified against aluukill/AniCult's provider registry.
 *
 * @exports
 *   EMBED_PROVIDERS, EMBED_PROVIDER_IDS, DEFAULT_EMBED_COLOR
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

// ══════════════════════════════════════════════════════════════
// PROVIDER DEFINITIONS
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Default accent color applied to provider players ----
const DEFAULT_EMBED_COLOR = "%23e63946";

// ---- FEATURE: Direct embed provider registry ----
/**
 * Each provider builds an iframe-ready URL from external IDs.
 * Builders return null when required IDs are missing.
 *
 * @type {Object<string, {id: string, name: string, origin: string, requires: string[], build: Function}>}
 *
 * @example
 *   EMBED_PROVIDERS.megavid.build({ malId: 21, episode: 1, lang: "sub" });
 *   // "https://megavid.buzz/mal/21/1/sub?color=%23e63946&autoplay=true"
 */
const EMBED_PROVIDERS = {
  megaplay: {
    id: "megaplay",
    name: "MegaPlay",
    origin: "https://megaplay.buzz",
    requires: ["malId | anilistId"],
    build({ malId, anilistId, episode, lang }) {
      const safeLang = lang === "dub" ? "dub" : "sub";
      if (malId) return `https://megaplay.buzz/stream/mal/${malId}/${episode}/${safeLang}`;
      if (anilistId) return `https://megaplay.buzz/stream/ani/${anilistId}/${episode}/${safeLang}`;
      return null;
    },
  },
  anixo: {
    id: "anixo",
    name: "AniXo",
    origin: "https://anixo.buzz",
    requires: ["anilistId"],
    build({ anilistId, episode, lang }) {
      const safeLang = lang === "dub" ? "dub" : "sub";
      if (!anilistId) return null;
      return `https://anixo.buzz/embed/ani/${anilistId}/${episode}/${safeLang}?color=${DEFAULT_EMBED_COLOR}`;
    },
  },
  megavid: {
    id: "megavid",
    name: "Megavid",
    origin: "https://megavid.buzz",
    requires: ["malId | anilistId"],
    build({ malId, anilistId, episode, lang }) {
      const safeLang = lang === "dub" ? "dub" : "sub";
      const idType = malId ? "mal" : "ani";
      const id = malId || anilistId;
      if (!id) return null;
      return `https://megavid.buzz/${idType}/${id}/${episode}/${safeLang}?color=${DEFAULT_EMBED_COLOR}&autoplay=true`;
    },
  },
};

// ---- FEATURE: Provider ID list for validation ----
const EMBED_PROVIDER_IDS = Object.keys(EMBED_PROVIDERS);

export { EMBED_PROVIDERS, EMBED_PROVIDER_IDS, DEFAULT_EMBED_COLOR };
// ══════════════════════════════════════════════════════════════ END: embedProviders.config.js
