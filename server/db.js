import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { FILE_TOKEN_TTL_MS } from '../shared/constants.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id              TEXT    PRIMARY KEY,
  ciphertext      TEXT    NOT NULL,
  iv              TEXT    NOT NULL,
  burn_after_read INTEGER NOT NULL CHECK (burn_after_read IN (0, 1)),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  read_count      INTEGER NOT NULL DEFAULT 0,
  last_read_at    INTEGER,
  file_key        TEXT,
  file_size       INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS notes_expires_at_idx ON notes (expires_at);
CREATE TABLE IF NOT EXISTS file_tokens (
  token      TEXT    PRIMARY KEY,
  note_id    TEXT    NOT NULL,
  file_key   TEXT    NOT NULL,
  burn       INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS file_tokens_expires_at_idx ON file_tokens (expires_at);
`;

function ensureColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name));
  if (!columns.has('file_key')) db.exec('ALTER TABLE notes ADD COLUMN file_key TEXT');
  if (!columns.has('file_size')) db.exec('ALTER TABLE notes ADD COLUMN file_size INTEGER');
}

function toNote(row, burnAfterRead) {
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    burnAfterRead,
    expiresAt: row.expires_at,
    fileKey: row.file_key ?? null,
    fileSize: row.file_size ?? null
  };
}

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  ensureColumns(db);

  const insertStmt = db.prepare(`
    INSERT INTO notes (id, ciphertext, iv, burn_after_read, created_at, expires_at, file_key, file_size)
    VALUES (@id, @ciphertext, @iv, @burnAfterRead, @createdAt, @expiresAt, @fileKey, @fileSize)
  `);
  const infoStmt = db.prepare('SELECT burn_after_read, expires_at, file_size FROM notes WHERE id = ? AND expires_at > ?');
  const burnStmt = db.prepare(`
    DELETE FROM notes
    WHERE id = ? AND burn_after_read = 1 AND expires_at > ?
    RETURNING ciphertext, iv, expires_at, file_key, file_size
  `);
  const readStmt = db.prepare(`
    UPDATE notes
    SET read_count = read_count + 1, last_read_at = ?
    WHERE id = ? AND burn_after_read = 0 AND expires_at > ?
    RETURNING ciphertext, iv, expires_at, file_key, file_size
  `);
  const insertTokenStmt = db.prepare(`
    INSERT INTO file_tokens (token, note_id, file_key, burn, expires_at) VALUES (?, ?, ?, ?, ?)
  `);
  const useTokenStmt = db.prepare(`
    UPDATE file_tokens SET used = 1
    WHERE token = ? AND note_id = ? AND used = 0 AND expires_at > ?
    RETURNING file_key, burn
  `);
  const usedBytesStmt = db.prepare('SELECT COALESCE(SUM(file_size), 0) AS used FROM notes');
  const expiredNotesStmt = db.prepare('SELECT id, file_key FROM notes WHERE expires_at <= ?');
  const deleteExpiredNotesStmt = db.prepare('DELETE FROM notes WHERE expires_at <= ?');
  const expiredTokensStmt = db.prepare('SELECT token, file_key FROM file_tokens WHERE expires_at <= ?');
  const deleteExpiredTokensStmt = db.prepare('DELETE FROM file_tokens WHERE expires_at <= ?');
  const fileReferencedStmt = db.prepare('SELECT 1 FROM notes WHERE file_key = ? LIMIT 1');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM notes');

  const consumeTx = db.transaction((id, now) => {
    const burned = burnStmt.get(id, now);
    const row = burned ?? readStmt.get(now, id, now);
    if (!row) return null;
    const note = toNote(row, Boolean(burned));
    if (note.fileKey) {
      note.fileToken = randomUUID();
      insertTokenStmt.run(note.fileToken, id, note.fileKey, note.burnAfterRead ? 1 : 0, now + FILE_TOKEN_TTL_MS);
    }
    return note;
  });

  const sweepTx = db.transaction((now) => {
    const orphanKeys = new Set();
    for (const row of expiredNotesStmt.all(now)) if (row.file_key) orphanKeys.add(row.file_key);
    const deletedNotes = deleteExpiredNotesStmt.run(now).changes;
    const tokenKeys = expiredTokensStmt.all(now).map((r) => r.file_key);
    deleteExpiredTokensStmt.run(now);
    for (const key of tokenKeys) if (!fileReferencedStmt.get(key)) orphanKeys.add(key);
    return { deletedNotes, orphanKeys: [...orphanKeys] };
  });

  return {
    insertNote({ id, ciphertext, iv, burnAfterRead, createdAt, expiresAt, fileKey = null, fileSize = null }) {
      insertStmt.run({ id, ciphertext, iv, burnAfterRead: burnAfterRead ? 1 : 0, createdAt, expiresAt, fileKey, fileSize });
    },
    getNoteInfo(id, now) {
      const row = infoStmt.get(id, now);
      if (!row) return null;
      return { burnAfterRead: row.burn_after_read === 1, expiresAt: row.expires_at, fileSize: row.file_size ?? null };
    },
    consumeNote(id, now) {
      return consumeTx(id, now);
    },
    useFileToken(token, noteId, now) {
      const row = useTokenStmt.get(token, noteId, now);
      return row ? { fileKey: row.file_key, burn: row.burn === 1 } : null;
    },
    usedFileBytes() {
      return usedBytesStmt.get().used;
    },
    sweepExpired(now) {
      return sweepTx(now);
    },
    deleteExpired(now) {
      return sweepTx(now).deletedNotes;
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
