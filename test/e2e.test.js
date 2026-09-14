import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBase64Url, toBase64Url } from '../public/assets/base64url.js';
import { decryptText, encryptText, generateRawKey, isValidKeyString } from '../public/assets/crypto.js';
import { buildTestApp, getNote, postCreate } from './helpers.js';

test('full flow: browser encrypt, server store, browser decrypt from url fragment', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());

  const secret = 'login: admin\nhasło: Zażółć-gęślą-jaźń!';
  const rawKey = generateRawKey();
  const { iv, ciphertext } = await encryptText(secret, rawKey);

  const created = await postCreate(app, { ciphertext, iv, ttl: '24h', burnAfterRead: true });
  assert.equal(created.statusCode, 201);
  const { id } = created.json();

  const link = new URL(`https://skrytka.example/${id}#${toBase64Url(rawKey)}`);
  const noteId = link.pathname.replace(/^\/+|\/+$/g, '');
  const fragment = link.hash.replace(/^#/, '');
  assert.equal(noteId, id);
  assert.equal(isValidKeyString(fragment), true);

  const fetched = await getNote(app, noteId);
  assert.equal(fetched.statusCode, 200);
  assert.equal(await decryptText(fetched.json(), fromBase64Url(fragment)), secret);
  assert.equal((await getNote(app, noteId)).statusCode, 404);
});
