import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBase64Url, toBase64Url } from '../public/assets/base64url.js';
import { DecryptError, decryptText, encryptText, generateRawKey, isValidKeyString } from '../public/assets/crypto.js';

test('base64url round trip without padding characters', () => {
  for (const len of [0, 1, 2, 3, 12, 16, 32, 70000]) {
    const bytes = Uint8Array.from({ length: len }, () => Math.floor(Math.random() * 256));
    const encoded = toBase64Url(bytes);
    assert.match(encoded, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(fromBase64Url(encoded), bytes);
  }
  assert.throws(() => fromBase64Url('abc+'), /invalid base64url/);
});

test('key is 32 bytes and encodes to 43 chars', () => {
  const key = generateRawKey();
  assert.equal(key.length, 32);
  const encoded = toBase64Url(key);
  assert.equal(encoded.length, 43);
  assert.equal(isValidKeyString(encoded), true);
  assert.equal(isValidKeyString(encoded.slice(1)), false);
  assert.equal(isValidKeyString(encoded + '='), false);
});

test('encrypt and decrypt round trip', async () => {
  const key = generateRawKey();
  const text = 'hasło: Zażółć gęślą jaźń\nlinia 2';
  const payload = await encryptText(text, key);
  assert.equal(payload.iv.length, 16);
  assert.match(payload.ciphertext, /^[A-Za-z0-9_-]+$/);
  assert.equal(await decryptText(payload, key), text);
});

test('wrong key or tampered ciphertext fails with DecryptError', async () => {
  const key = generateRawKey();
  const payload = await encryptText('secret', key);
  await assert.rejects(decryptText(payload, generateRawKey()), DecryptError);
  const tampered = { ...payload, ciphertext: (payload.ciphertext[0] === 'A' ? 'B' : 'A') + payload.ciphertext.slice(1) };
  await assert.rejects(decryptText(tampered, key), DecryptError);
  await assert.rejects(decryptText({ iv: 'not base64+', ciphertext: payload.ciphertext }, key), DecryptError);
});
