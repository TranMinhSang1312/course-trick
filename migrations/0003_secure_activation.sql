ALTER TABLE licenses ADD COLUMN claimed_at TEXT;

ALTER TABLE license_activations ADD COLUMN refresh_token_hash TEXT;
ALTER TABLE license_activations ADD COLUMN last_refresh_at TEXT;
ALTER TABLE license_activations ADD COLUMN revoked_at TEXT;

CREATE UNIQUE INDEX idx_activations_refresh_token_hash
  ON license_activations (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;
