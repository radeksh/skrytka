import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id              TEXT    PRIMARY KEY,
  ciphertext      TEXT    NOT NULL,
  iv              TEXT    NOT NULL,
  burn_after_read INTEGER NOT NULL CHECK (burn_after_read IN (0, 1)),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  read_count      INTEGER NOT NULL DEFAULT 0,
  last_read_at    INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS notes_expires_at_idx ON notes (expires_at);
`;

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(`
    INSERT INTO notes (id, ciphertext, iv, burn_after_read, created_at, expires_at)
    VALUES (@id, @ciphertext, @iv, @burnAfterRead, @createdAt, @expiresAt)
  `);
  const burnStmt = db.prepare(`
    DELETE FROM notes
    WHERE id = ? AND burn_after_read = 1 AND expires_at > ?
    RETURNING ciphertext, iv, expires_at
  `);
  const readStmt = db.prepare(`
    UPDATE notes
    SET read_count = read_count + 1, last_read_at = ?
    WHERE id = ? AND burn_after_read = 0 AND expires_at > ?
    RETURNING ciphertext, iv, expires_at
  `);
  const infoStmt = db.prepare('SELECT burn_after_read, expires_at FROM notes WHERE id = ? AND expires_at > ?');
  const deleteExpiredStmt = db.prepare('DELETE FROM notes WHERE expires_at <= ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM notes');

  const consumeTx = db.transaction((id, now) => {
    const burned = burnStmt.get(id, now);
    if (burned) return { ...burned, burnAfterRead: true };
    const read = readStmt.get(now, id, now);
    if (read) return { ...read, burnAfterRead: false };
    return null;
  });

  return {
    insertNote({ id, ciphertext, iv, burnAfterRead, createdAt, expiresAt }) {
      insertStmt.run({ id, ciphertext, iv, burnAfterRead: burnAfterRead ? 1 : 0, createdAt, expiresAt });
    },
    getNoteInfo(id, now) {
      const row = infoStmt.get(id, now);
      if (!row) return null;
      return { burnAfterRead: row.burn_after_read === 1, expiresAt: row.expires_at };
    },
    consumeNote(id, now) {
      const row = consumeTx(id, now);
      if (!row) return null;
      return { ciphertext: row.ciphertext, iv: row.iv, burnAfterRead: row.burnAfterRead, expiresAt: row.expires_at };
    },
    deleteExpired(now) {
      return deleteExpiredStmt.run(now).changes;
    },
    countNotes() {
      return countStmt.get().n;
    },
    checkpoint() {
      db.pragma('wal_checkpoint(TRUNCATE)');
    },
    close() {
      db.close();
    },
    raw: db
  };
}
