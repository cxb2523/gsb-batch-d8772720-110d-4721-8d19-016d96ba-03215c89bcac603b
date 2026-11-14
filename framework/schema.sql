-- ============================================================
-- Universal Research Framework Schema v1
-- ============================================================
-- Design goals:
--   1. Platform-agnostic   — one schema for YouTube / TikTok / XHS / e-commerce, etc.
--   2. Cross-platform SQL  — every table carries a platform column; a single query can
--                            span multiple platforms
--   3. Pluggable dimensions — metadata / comments / transcripts / visual features each
--                            land in a separate table and are collected on demand
--   4. Time-series ready   — the metrics table carries timestamps; multiple snapshots
--                            of the same metric form a time series naturally
--   5. Dirty-row guard     — status column keeps failed/deleted entities out of
--                            main queries (WHERE status='ok')
--
-- The universal 5-table schema: entities / items / metrics / texts / features.
-- A single set of generic columns covers any platform, avoiding hard coupling
-- between collection logic and any one platform.
-- ============================================================


-- ──────────────────────────────────────────────
-- entities — channel / account / seller / author
-- The platform-agnostic "subject". Generalised from the original channels table.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
    platform     TEXT NOT NULL,        -- youtube / tiktok / xhs / bilibili / amazon ...
    entity_id    TEXT NOT NULL,        -- platform-scoped unique identifier (handle / uid / store_id)
    entity_type  TEXT NOT NULL,        -- channel / account / seller / author
    name         TEXT,                 -- display name
    segment      TEXT,                 -- research segment (formerly lang: language/region, freely customisable)
    category     TEXT,                 -- content style / category (formerly vibe)
    profile_json TEXT,                 -- platform-specific fields (description / subs / created_at …)
    status       TEXT DEFAULT 'ok',    -- ok / error / deleted  (dirty-row guard: main queries use WHERE status='ok')
    captured_at  TEXT,                 -- timestamp of this capture
    PRIMARY KEY (platform, entity_id)
);


-- ──────────────────────────────────────────────
-- items — video / post / note / product
-- The platform-agnostic "content unit". Generalised from the original videos table.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
    platform     TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    entity_id    TEXT,                 -- owning entity (channel / account)
    item_type    TEXT NOT NULL,        -- video / post / note / product
    title        TEXT,
    url          TEXT,
    published_at TEXT,
    segment      TEXT,
    category     TEXT,
    meta_json    TEXT,                 -- platform-specific fields (duration / tags / thumbnail_url …)
    status       TEXT DEFAULT 'ok',
    captured_at  TEXT,
    PRIMARY KEY (platform, item_id)
);


-- ──────────────────────────────────────────────
-- metrics — EAV long table with timestamps
-- Stores any numeric metric: views / likes / comments / subscribers …
-- ⭐ EAV payoff: multiple captured_at values for the same (ref_id, metric_name)
--    form a time series — historical snapshots accumulate automatically.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metrics (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT NOT NULL,
    scope        TEXT NOT NULL,        -- entity / item (which object this metric belongs to)
    ref_id       TEXT NOT NULL,        -- references entities.entity_id or items.item_id
    metric_name  TEXT NOT NULL,        -- view_count / like_count / subs / comment_count …
    metric_value REAL,
    captured_at  TEXT NOT NULL         -- required: the time axis for time-series queries
);


-- ──────────────────────────────────────────────
-- texts — comment / transcript / description / title
-- ⭐ Beyond comment_count: the comments section is a rich source of qualitative
--    signals (user JTBD, pain points, etc.). This table stores the actual text.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS texts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT NOT NULL,
    scope        TEXT NOT NULL,        -- entity / item
    ref_id       TEXT NOT NULL,
    text_type    TEXT NOT NULL,        -- comment / transcript / description / title
    author       TEXT,                 -- comment author (anonymize via salted hash for privacy)
    content      TEXT,
    lang         TEXT,
    extra_json   TEXT,                 -- like count / timestamp / reply depth / timecode
    captured_at  TEXT
);


-- ──────────────────────────────────────────────
-- features — AI / ML analysis results
-- ⭐ Multiple analysis angles: thumbnail vision / comment NLP / transcript topics
--    all land here. Generalised from the original thumb_features table
--    (feature_set='thumbnail_vision').
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS features (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT NOT NULL,
    scope        TEXT NOT NULL,
    ref_id       TEXT NOT NULL,
    feature_set  TEXT NOT NULL,        -- thumbnail_vision / comment_nlp / transcript_topic …
    feature_json TEXT,                 -- structured analysis output (JSON)
    source       TEXT,                 -- producer (gpt-vision / gemini / local script)
    analyzed_at  TEXT
);


-- ──────────────────────────────────────────────
-- Indexes: built for the most common access pattern — look up metrics/texts/features
-- by entity or item
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_items_entity   ON items(platform, entity_id);
CREATE INDEX IF NOT EXISTS idx_metrics_ref    ON metrics(platform, scope, ref_id, metric_name);
CREATE INDEX IF NOT EXISTS idx_texts_ref      ON texts(platform, scope, ref_id, text_type);
CREATE INDEX IF NOT EXISTS idx_features_ref   ON features(platform, scope, ref_id, feature_set);
CREATE INDEX IF NOT EXISTS idx_entities_seg   ON entities(platform, segment, category);
CREATE INDEX IF NOT EXISTS idx_items_seg      ON items(platform, segment, category);
