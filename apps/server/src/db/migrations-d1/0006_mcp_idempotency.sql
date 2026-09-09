CREATE TABLE IF NOT EXISTS mail0_mcp_idempotency (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, idempotency_key, operation),
  FOREIGN KEY (user_id) REFERENCES mail0_user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mail0_mcp_idempotency_created_at_idx
  ON mail0_mcp_idempotency(created_at);
