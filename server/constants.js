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
