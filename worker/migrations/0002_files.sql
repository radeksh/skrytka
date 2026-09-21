ALTER TABLE notes ADD COLUMN file_key TEXT;
ALTER TABLE notes ADD COLUMN file_size INTEGER;
CREATE TABLE IF NOT EXISTS file_tokens (
  token      TEXT    PRIMARY KEY,
  note_id    TEXT    NOT NULL,
  file_key   TEXT    NOT NULL,
  burn       INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS file_tokens_expires_at_idx ON file_tokens (expires_at);
