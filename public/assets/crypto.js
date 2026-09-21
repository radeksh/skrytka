import { fromBase64Url, toBase64Url } from './base64url.js';

const ALG = 'AES-GCM';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export class DecryptError extends Error {
  constructor() {
    super('decryption failed');
    this.name = 'DecryptError';
  }
}

export function hasWebCrypto() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}

export function isValidKeyString(str) {
  return KEY_RE.test(str);
}

export function generateRawKey() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

function importKey(rawKey, usages) {
  return crypto.subtle.importKey('raw', rawKey, { name: ALG }, false, usages);
}

export async function encryptText(text, rawKey) {
  const key = await importKey(rawKey, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: ALG, iv }, key, new TextEncoder().encode(text));
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

export async function decryptText({ iv, ciphertext }, rawKey) {
  let plaintext;
  try {
    const key = await importKey(rawKey, ['decrypt']);
    plaintext = await crypto.subtle.decrypt({ name: ALG, iv: fromBase64Url(iv) }, key, fromBase64Url(ciphertext));
  } catch {
    throw new DecryptError();
  }
  return new TextDecoder().decode(plaintext);
}

export async function encryptBytes(bytes, rawKey) {
  const key = await importKey(rawKey, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: ALG, iv }, key, bytes));
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, IV_BYTES);
  return out;
}

export async function decryptBytes(bytes, rawKey) {
  if (bytes.byteLength < IV_BYTES + 16) throw new DecryptError();
  try {
    const key = await importKey(rawKey, ['decrypt']);
    const iv = bytes.subarray(0, IV_BYTES);
    return await crypto.subtle.decrypt({ name: ALG, iv }, key, bytes.subarray(IV_BYTES));
  } catch {
    throw new DecryptError();
  }
}
