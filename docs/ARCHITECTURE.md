# Architecture

## 1. Data flow

```
Xiaohongshu post HTML
  │
  ├─ [Parse layer · pure functions] parse_initial_state → extract_note → note_to_records
  │     ├─ Extracts: note ID / type / tags / cover + metrics (likes / saves / comments / shares)
  │     ├─ Anonymizes: compliance.scrub_user (salted HMAC on user ID + drops sensitive fields)
  │     └─ Produces: Entity / Item / Metric / Text contract objects
  │
  ├─ [Fetch layer] XHSAdapter._fetch_html (exponential backoff + cookie expiry detection) / fetch_note_by_url
  │     └─ Field mappings from framework/config/xhs_selectors.yml
  │
  └─ [Store layer] Store.upsert_entity / upsert_item / add_metric / add_text / add_feature
        └─ Writes to SQLite universal 5-table schema

  [Analysis layer] framework/analysis/xhs_insights.py  ← reads the 5 tables
        collect_rate_ranking / note_type_compare / topic_frequency
```

## 2. Universal 5-table schema (see `framework/schema.sql` for full DDL)

### entities (creators)
`platform` · `entity_id` · `entity_type` (author) · `name` · `segment` · `category` · `profile_json` (platform-specific) · `status` · `captured_at`　**PK=(platform, entity_id)**

### items (posts)
`platform` · `item_id` · `entity_id` (→entities) · `item_type` (note) · `title` · `url` · `published_at` · `segment` · `category` · `meta_json` (note_type / cover / tags) · `status` · `captured_at`　**PK=(platform, item_id)**

### metrics (long table, supports time series)
`id` · `platform` · `scope` (**entity / item**) · `ref_id` · `metric_name` (**like_count / collect_count / comment_count / share_count**) · `metric_value` · `captured_at`

### texts (comments and descriptions)
`id` · `platform` · `scope` · `ref_id` · `text_type` (comment / desc) · `author` (hashed) · `content` · `lang` · `extra_json` · `captured_at`

### features (AI analysis results)
`id` · `platform` · `scope` · `ref_id` · `feature_set` · `feature_json` · `source` · `analyzed_at`

**Relationships**: entities 1──N items; items 1──N metrics / texts / features; metrics can also attach to entities (scope=entity, e.g. creator subscriber count).

## 3. Module responsibilities

| File | Responsibility | Key classes / functions |
|------|---------------|------------------------|
| `compliance.py` | Anonymization + rate control | `scrub_user` / `RateLimiter` (backoff · daily cap · cross-day reset · thread lock) |
| `framework/adapter.py` | Data contracts + adapter abstraction | dataclasses `Entity / Item / Metric / Text` + `SourceAdapter` (`fetch_entity` / `fetch_items`) |
| `framework/schema.sql` | 5-table DDL | entities / items / metrics / texts / features |
| `framework/store.py` | Unified persistence | `Store` (`upsert_*` / `add_*`) |
| `framework/adapters/xhs.py` | Xiaohongshu parse + fetch | Pure-function parse layer: `parse_initial_state` / `extract_note` / `note_to_records` + `XHSAdapter` |
| `framework/config/*.yml` | Field mappings (survives platform changes) | regex / note paths / metrics mappings |
| `framework/analysis/xhs_insights.py` | Targeted analysis over the 5 tables | `collect_rate_ranking` / `note_type_compare` / `topic_frequency` |

## 4. Design principles

- **Translate-store-analyze separation**: adapters translate platform data into contracts; the store writes them; the analysis layer only touches the universal 5-table schema and is fully reusable across platforms.
- **Parse and fetch decoupled**: the parse layer is pure functions with no network I/O, making it straightforward to unit-test with mocks.
- **Config-driven against platform changes**: all field mappings live in `xhs_selectors.yml`; a platform redesign only requires updating the config file.
- **Collect-rate as the primary signal**: on Xiaohongshu, saves measure content value more accurately than likes.
- **Compliance first**: user IDs are salted and hashed; sensitive fields are dropped before storage; `RateLimiter` enforces rate limits to prevent bans.
