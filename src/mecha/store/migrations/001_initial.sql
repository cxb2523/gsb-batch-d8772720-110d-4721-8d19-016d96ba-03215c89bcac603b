-- 001: metadata, credentials and check history.
-- Secrets are stored only as AES-256-GCM ciphertext (secret_ct). Nothing here is plaintext.

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE credentials (
    id                 TEXT PRIMARY KEY,
    label              TEXT NOT NULL,
    provider           TEXT NOT NULL,
    kind               TEXT NOT NULL,
    pattern_id         TEXT,
    redacted           TEXT NOT NULL,
    fingerprint        TEXT NOT NULL UNIQUE,
    secret_ct          BLOB,
    tags               TEXT NOT NULL DEFAULT '[]',
    notes              TEXT,
    linked_path        TEXT,
    parent_id          TEXT REFERENCES credentials(id) ON DELETE SET NULL,
    manual_expires_at  TEXT,
    manual_budget      TEXT,
    active_probe       INTEGER NOT NULL DEFAULT 0,
    token_expires_at   TEXT,
    subscription_until TEXT,
    retiring           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL
);

CREATE TABLE check_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    checked_at    TEXT NOT NULL,
    overall       TEXT NOT NULL,
    payload       TEXT NOT NULL
);

CREATE INDEX check_results_by_credential ON check_results (credential_id, checked_at DESC);
