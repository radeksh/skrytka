CREATE TABLE IF NOT EXISTS notes (
  id              TEXT    PRIMARY KEY,
  ciphertext      TEXT    NOT NULL,
  iv              TEXT    NOT NULL,
  burn_after_read INTEGER NOT NULL CHECK (burn_after_read IN (0, 1)),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  read_count      INTEGER NOT NULL DEFAULT 0,
  last_read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS notes_expires_at_idx ON notes (expires_at);
