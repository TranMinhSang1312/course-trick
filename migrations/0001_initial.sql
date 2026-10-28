PRAGMA foreign_keys = ON;

CREATE TABLE orders (
  order_code INTEGER PRIMARY KEY,
  buyer_email TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'VND',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED')),
  payment_link_id TEXT UNIQUE,
  payment_reference TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE INDEX idx_orders_email ON orders (buyer_email);
CREATE INDEX idx_orders_status ON orders (status);

CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  order_code INTEGER NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (order_code) REFERENCES orders(order_code)
);

CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  license_key_hash TEXT NOT NULL UNIQUE,
  order_code INTEGER NOT NULL UNIQUE,
  buyer_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'PRO',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  max_activations INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (order_code) REFERENCES orders(order_code)
);

CREATE TABLE license_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT NOT NULL,
  installation_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (license_id, installation_hash),
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE INDEX idx_activations_license ON license_activations (license_id);

