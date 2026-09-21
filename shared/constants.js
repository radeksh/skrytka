export const TTL_OPTIONS = Object.freeze({
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000
});

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const B64URL_PATTERN = '^[A-Za-z0-9_-]+$';
export const B64URL_RE = new RegExp(B64URL_PATTERN);

export const GCM_TAG_BYTES = 16;
export const IV_B64URL_LENGTH = 16;
export const KEY_B64URL_LENGTH = 43;
export const MIN_CIPHERTEXT_B64URL_LENGTH = 22;

export const ENVELOPE_VERSION = 1;
export const FILE_IV_BYTES = 12;
export const FILE_OVERHEAD_BYTES = FILE_IV_BYTES + GCM_TAG_BYTES;
export const FRAME_HEADER_BYTES = 4;
export const FRAME_META_MAX_BYTES = 262_144;
export const NOTE_FRAME_CONTENT_TYPE = 'application/x-skrytka-note';
export const FILE_TOKEN_TTL_MS = 600_000;
export const FILE_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
