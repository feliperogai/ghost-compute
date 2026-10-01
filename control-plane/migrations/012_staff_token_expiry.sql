-- Every API token now expires (staff: STAFF_TOKEN_TTL_DAYS, default 90). Tokens issued
-- before that had none: give them the default lifetime from now, so nobody is locked
-- out by the upgrade and the holders have time to mint the next one.
UPDATE api_tokens SET expires_at = now() + interval '90 days' WHERE expires_at IS NULL AND revoked_at IS NULL;
