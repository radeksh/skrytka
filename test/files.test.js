import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { FILE_TOKEN_TTL_MS, NOTE_FRAME_CONTENT_TYPE } from '../shared/constants.js';
import { ALLOWED_IP, VALID_BODY, buildTestApp, getNote } from './helpers.js';

function frame(meta, fileBytes) {
  const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(metaBytes.length, 0);
  return Buffer.concat([header, metaBytes, fileBytes]);
}

function randomFile(size) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function postFrame(app, body) {
  return app.inject({
    method: 'POST',
    url: '/api/create',
    remoteAddress: ALLOWED_IP,
    headers: { 'content-type': NOTE_FRAME_CONTENT_TYPE },
    payload: body
  });
}

function download(app, id, token) {
  return app.inject({ method: 'GET', url: `/api/notes/${id}/file/${token}` });
}

const storedFiles = (dir) => readdirSync(dir).filter((f) => !f.endsWith('.tmp'));

test('create with file, info, consume, single-use download and burn', async (t) => {
  const { app, filesDir } = await buildTestApp();
  t.after(() => app.close());
  const fileBytes = randomFile(5000);

  const created = await postFrame(app, frame(VALID_BODY, fileBytes));
  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json();
  assert.equal(storedFiles(filesDir).length, 1);

  const info = await app.inject({ method: 'GET', url: `/api/notes/${id}/info` });
  assert.deepEqual({ hasFile: info.json().hasFile, fileSize: info.json().fileSize }, { hasFile: true, fileSize: 5000 });

  const consumed = await getNote(app, id);
  assert.equal(consumed.statusCode, 200);
  const { file } = consumed.json();
  assert.equal(file.size, 5000);
  assert.match(file.token, /^[0-9a-f-]{36}$/);

  const wrongNote = await download(app, '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', file.token);
  assert.equal(wrongNote.statusCode, 404);

  const first = await download(app, id, file.token);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['content-type'], 'application/octet-stream');
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.ok(Buffer.from(first.rawPayload).equals(fileBytes));

  const second = await download(app, id, file.token);
  assert.equal(second.statusCode, 404);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(storedFiles(filesDir).length, 0, 'burned file removed from disk');
  assert.equal(app.db.countNotes(), 0);
});

test('multi read note keeps the file and issues a token per read', async (t) => {
  const { app, clock, filesDir } = await buildTestApp();
  t.after(() => app.close());
  const fileBytes = randomFile(1234);
  const { id } = (await postFrame(app, frame({ ...VALID_BODY, burnAfterRead: false }, fileBytes))).json();

  const a = (await getNote(app, id)).json().file.token;
  const b = (await getNote(app, id)).json().file.token;
  assert.notEqual(a, b);
  assert.equal((await download(app, id, a)).statusCode, 200);
  assert.equal((await download(app, id, b)).statusCode, 200);
  assert.equal(storedFiles(filesDir).length, 1, 'file kept for multi read note');

  const c = (await getNote(app, id)).json().file.token;
  clock.t += FILE_TOKEN_TTL_MS + 1;
  assert.equal((await download(app, id, c)).statusCode, 404, 'expired token');

  clock.t += 3_600_000;
  app.db.sweepExpired(clock.t);
  await app.inject({ method: 'GET', url: '/healthz' });
  const { orphanKeys } = app.db.sweepExpired(clock.t);
  assert.deepEqual(orphanKeys, []);
});

test('cleanup removes files of expired notes', async (t) => {
  const { app, clock, filesDir } = await buildTestApp();
  t.after(() => app.close());
  await postFrame(app, frame({ ...VALID_BODY, burnAfterRead: false }, randomFile(100)));
  await postFrame(app, frame({ ...VALID_BODY, ttl: '24h' }, randomFile(100)));
  assert.equal(storedFiles(filesDir).length, 2);
  clock.t += 3_600_001;
  const sweep = app.db.sweepExpired(clock.t);
  assert.equal(sweep.deletedNotes, 1);
  assert.equal(sweep.orphanKeys.length, 1);
  for (const key of sweep.orphanKeys) await app.files.remove(key);
  assert.equal(storedFiles(filesDir).length, 1);
  assert.equal(existsSync(`${filesDir}/${sweep.orphanKeys[0]}`), false);
});

test('upload limits: too large, quota, malformed frame, disabled', async (t) => {
  const { app, filesDir } = await buildTestApp({ MAX_UPLOAD_BYTES: '1000', FILE_QUOTA_BYTES: '1500' });
  t.after(() => app.close());

  const tooLarge = await postFrame(app, frame(VALID_BODY, randomFile(1029)));
  assert.equal(tooLarge.statusCode, 413);
  assert.deepEqual(tooLarge.json(), { error: 'payload_too_large' });

  const tooSmall = await postFrame(app, frame(VALID_BODY, randomFile(27)));
  assert.equal(tooSmall.statusCode, 400);

  const ok = await postFrame(app, frame(VALID_BODY, randomFile(1000)));
  assert.equal(ok.statusCode, 201);
  const quota = await postFrame(app, frame(VALID_BODY, randomFile(600)));
  assert.equal(quota.statusCode, 507);
  assert.deepEqual(quota.json(), { error: 'storage_full' });
  assert.equal(storedFiles(filesDir).length, 1);

  const badMeta = await postFrame(app, frame({ ...VALID_BODY, ttl: '2h' }, randomFile(100)));
  assert.equal(badMeta.statusCode, 400);

  const header = Buffer.alloc(4);
  header.writeUInt32BE(999_999, 0);
  const truncated = await postFrame(app, Buffer.concat([header, Buffer.from('{}')]));
  assert.equal(truncated.statusCode, 400);

  const notJson = await postFrame(app, frame('not an object', randomFile(100)));
  assert.equal(notJson.statusCode, 400);
  assert.equal(storedFiles(filesDir).length, 1, 'no partial files left behind');

  const other = await buildTestApp({ MAX_UPLOAD_BYTES: '0' });
  t.after(() => other.app.close());
  const disabled = await postFrame(other.app, frame(VALID_BODY, randomFile(100)));
  assert.equal(disabled.statusCode, 415);
});

test('json create path still works and is limited', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/api/create', headers: { 'content-type': 'application/json' }, payload: VALID_BODY });
  assert.equal(res.statusCode, 201);
  const wrongType = await app.inject({ method: 'POST', url: '/api/create', headers: { 'content-type': 'application/octet-stream' }, payload: 'x' });
  assert.equal(wrongType.statusCode, 415);
});
