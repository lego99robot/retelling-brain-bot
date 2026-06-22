ALTER TABLE telegram_processed_updates ADD COLUMN status TEXT NOT NULL DEFAULT 'done';

ALTER TABLE telegram_processed_updates ADD COLUMN updated_at TEXT;

UPDATE telegram_processed_updates
SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_processed_updates_status_updated
  ON telegram_processed_updates(status, updated_at);