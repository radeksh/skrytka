import { dirname, join } from 'node:path';
import { parseCidrList } from './allowlist.js';
import { FILE_OVERHEAD_BYTES, FRAME_HEADER_BYTES, FRAME_META_MAX_BYTES, GCM_TAG_BYTES } from '../shared/constants.js';

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function readInt(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function readCidrs(env, name) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return [];
  if (raw === 'true' || raw === 'false') {
    throw new Error(`${name} must be a comma separated list of CIDRs, not a boolean`);
  }
  try {
    return parseCidrList(raw);
  } catch (err) {
    throw new Error(`${name}: ${err.message}`);
  }
}

export function loadConfig(env = process.env) {
  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.has(logLevel)) throw new Error(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);

  const maxNoteBytes = readInt(env, 'MAX_NOTE_BYTES', 65_536, { min: 64, max: 8_388_608 });
  const maxCiphertextB64Length = Math.ceil(((maxNoteBytes + GCM_TAG_BYTES) * 4) / 3);
  const maxUploadBytes = readInt(env, 'MAX_UPLOAD_BYTES', 10_485_760, { min: 0, max: 1_073_741_824 });
  const dbPath = env.DB_PATH || './data/skrytka.db';
  const filesDir = env.FILES_DIR || (dbPath === ':memory:' ? join(process.cwd(), 'data', 'files') : join(dirname(dbPath), 'files'));

  return Object.freeze({
    port: readInt(env, 'PORT', 3000, { min: 1, max: 65_535 }),
    host: env.HOST || '0.0.0.0',
    dbPath,
    filesDir,
    createAllowedCidrs: readCidrs(env, 'CREATE_ALLOWED_CIDRS'),
    trustProxy: readCidrs(env, 'TRUST_PROXY'),
    maxNoteBytes,
    maxCiphertextB64Length,
    bodyLimit: maxCiphertextB64Length + 1024,
    maxUploadBytes,
    uploadBodyLimit: FRAME_HEADER_BYTES + FRAME_META_MAX_BYTES + maxUploadBytes + FILE_OVERHEAD_BYTES,
    fileQuotaBytes: readInt(env, 'FILE_QUOTA_BYTES', 5_368_709_120, { min: 0, max: 1_099_511_627_776 }),
    cleanupIntervalMs: readInt(env, 'CLEANUP_INTERVAL_MS', 60_000, { min: 1000, max: 86_400_000 }),
    logLevel
  });
}
