-- 003: where a stored key was also found in plaintext (mecha scan). The locations are a
-- map of the user's plaintext keys, so they are encrypted with the store key (AES-GCM,
-- associated data "exposure:<credential id>"), never stored in clear. Only for keys that
-- Mecha manages; deleting the credential deletes them.
CREATE TABLE exposures (
    credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
    blob BLOB NOT NULL,
    updated_at TEXT NOT NULL
);
