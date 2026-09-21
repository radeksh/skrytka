import { B64URL_RE, IV_B64URL_LENGTH, MIN_CIPHERTEXT_B64URL_LENGTH, TTL_OPTIONS } from './constants.js';

export function isValidCreateMeta(body, maxCiphertextB64Length) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  if (Object.keys(body).length !== 4) return false;
  const { ciphertext, iv, ttl, burnAfterRead } = body;
  if (typeof ciphertext !== 'string' || ciphertext.length < MIN_CIPHERTEXT_B64URL_LENGTH || ciphertext.length > maxCiphertextB64Length || !B64URL_RE.test(ciphertext)) return false;
  if (typeof iv !== 'string' || iv.length !== IV_B64URL_LENGTH || !B64URL_RE.test(iv)) return false;
  if (typeof ttl !== 'string' || !Object.hasOwn(TTL_OPTIONS, ttl)) return false;
  if (typeof burnAfterRead !== 'boolean') return false;
  return true;
}

export function parseFrameHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, false);
}

export function fileLengthBounds(maxUploadBytes, overhead) {
  return { min: overhead, max: maxUploadBytes + overhead };
}
