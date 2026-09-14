import { parseCidrList } from './allowlist.js';
import { GCM_TAG_BYTES } from '../shared/constants.js';

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

  return Object.freeze({
    port: readInt(env, 'PORT', 3000, { min: 1, max: 65_535 }),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || './data/skrytka.db',
    createAllowedCidrs: readCidrs(env, 'CREATE_ALLOWED_CIDRS'),
    trustProxy: readCidrs(env, 'TRUST_PROXY'),
    maxNoteBytes,
    maxCiphertextB64Length,
    bodyLimit: maxCiphertextB64Length + 1024,
    cleanupIntervalMs: readInt(env, 'CLEANUP_INTERVAL_MS', 60_000, { min: 1000, max: 86_400_000 }),
    logLevel
  });
}
