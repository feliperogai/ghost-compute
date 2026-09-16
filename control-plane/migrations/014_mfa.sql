-- Two-step verification (TOTP, RFC 6238). The secret is stored encrypted (AES-256-GCM,
-- key derived from WORKER_TOKEN_SECRET); a pending secret has no enabled_at yet. The
-- last accepted 30-second step makes every code usable once.
ALTER TABLE users
  ADD COLUMN totp_secret     bytea,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step  bigint;
