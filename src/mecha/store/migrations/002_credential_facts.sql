-- 002: facts reported by APIs (admin/management enrichment, active probes, the key itself)
-- that must survive later passive checks. JSON (CredentialFacts); never contains a secret.
ALTER TABLE credentials ADD COLUMN facts TEXT NOT NULL DEFAULT '{}';
