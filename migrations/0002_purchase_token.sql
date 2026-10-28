ALTER TABLE orders ADD COLUMN claim_token_hash TEXT;
CREATE UNIQUE INDEX idx_orders_claim_token_hash ON orders (claim_token_hash);

