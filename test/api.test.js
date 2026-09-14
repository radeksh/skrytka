import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UUID_V4_RE } from '../server/constants.js';
import { ALLOWED_IP, DENIED_IP, VALID_BODY, buildTestApp, getNote, postCreate } from './helpers.js';

const SOME_UUID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

test('create returns 201 with id and expiry', async (t) => {
  const { app, clock } = await buildTestApp();
  t.after(() => app.close());
  const res = await postCreate(app);
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.id, UUID_V4_RE);
  assert.equal(body.burnAfterRead, true);
  assert.equal(body.expiresAt, new Date(clock.t + 3_600_000).toISOString());
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('read returns the stored ciphertext and burns the note', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  const { id } = (await postCreate(app)).json();

  const first = await getNote(app, id);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), {
    ciphertext: VALID_BODY.ciphertext,
    iv: VALID_BODY.iv,
    burnAfterRead: true,
    expiresAt: first.json().expiresAt
  });
  assert.equal(first.headers['cache-control'], 'no-store');

  const second = await getNote(app, id);
  assert.equal(second.statusCode, 404);
  assert.deepEqual(second.json(), { error: 'not_found' });
  assert.equal(app.db.countNotes(), 0);
});

test('concurrent reads of a burn note yield exactly one success', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  const { id } = (await postCreate(app)).json();
  const results = await Promise.all([getNote(app, id), getNote(app, id), getNote(app, id)]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 404, 404]);
});

test('multi read notes stay available and count reads', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  const { id } = (await postCreate(app, { ...VALID_BODY, burnAfterRead: false })).json();
  assert.equal((await getNote(app, id)).statusCode, 200);
  const second = await getNote(app, id);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().burnAfterRead, false);
  const row = app.db.raw.prepare('SELECT read_count, last_read_at FROM notes WHERE id = ?').get(id);
  assert.equal(row.read_count, 2);
  assert.equal(row.last_read_at, app.now());
});

test('expired notes are not served and get cleaned up', async (t) => {
  const { app, clock } = await buildTestApp();
  t.after(() => app.close());
  const { id } = (await postCreate(app, { ...VALID_BODY, burnAfterRead: false })).json();
  clock.t += 3_600_001;
  assert.equal((await getNote(app, id)).statusCode, 404);
  assert.equal(app.db.countNotes(), 1);
  assert.equal(app.db.deleteExpired(clock.t), 1);
  assert.equal(app.db.countNotes(), 0);
});

test('each ttl option is honoured', async (t) => {
  const { app, clock } = await buildTestApp();
  t.after(() => app.close());
  const expected = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
  for (const [ttl, ms] of Object.entries(expected)) {
    const res = await postCreate(app, { ...VALID_BODY, ttl });
    assert.equal(res.statusCode, 201, ttl);
    assert.equal(res.json().expiresAt, new Date(clock.t + ms).toISOString(), ttl);
  }
});

test('allowlist disabled by default: anyone may create', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  assert.equal((await postCreate(app, VALID_BODY, { remoteAddress: DENIED_IP })).statusCode, 201);
  const page = await app.inject({ method: 'GET', url: '/create', remoteAddress: DENIED_IP });
  assert.equal(page.statusCode, 200);
});

test('allowlist enabled: foreign ip gets 403 on create paths only', async (t) => {
  const { app } = await buildTestApp({ CREATE_ALLOWED_CIDRS: '10.0.0.0/8' });
  t.after(() => app.close());
  const denied = await postCreate(app, VALID_BODY, { remoteAddress: DENIED_IP });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), { error: 'forbidden' });
  assert.equal((await app.inject({ method: 'GET', url: '/create', remoteAddress: DENIED_IP })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/${SOME_UUID}`, remoteAddress: DENIED_IP })).statusCode, 200);
  assert.equal((await postCreate(app, VALID_BODY, { remoteAddress: ALLOWED_IP })).statusCode, 201);
});

test('x-forwarded-for is ignored without TRUST_PROXY', async (t) => {
  const { app } = await buildTestApp({ CREATE_ALLOWED_CIDRS: '10.0.0.0/8' });
  t.after(() => app.close());
  const res = await postCreate(app, VALID_BODY, { remoteAddress: DENIED_IP, headers: { 'x-forwarded-for': ALLOWED_IP } });
  assert.equal(res.statusCode, 403);
});

test('x-forwarded-for is honoured only from trusted proxies', async (t) => {
  const { app } = await buildTestApp({ CREATE_ALLOWED_CIDRS: '10.0.0.0/8', TRUST_PROXY: '127.0.0.1/32' });
  t.after(() => app.close());
  const viaProxy = await postCreate(app, VALID_BODY, { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ALLOWED_IP } });
  assert.equal(viaProxy.statusCode, 201);
  const spoofed = await postCreate(app, VALID_BODY, { remoteAddress: DENIED_IP, headers: { 'x-forwarded-for': ALLOWED_IP } });
  assert.equal(spoofed.statusCode, 403);
  const proxyDenied = await postCreate(app, VALID_BODY, { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': DENIED_IP } });
  assert.equal(proxyDenied.statusCode, 403);
});

test('size limits: schema 400 and body 413', async (t) => {
  const { app, config } = await buildTestApp({ MAX_NOTE_BYTES: '1024' });
  t.after(() => app.close());
  const tooLongCiphertext = await postCreate(app, { ...VALID_BODY, ciphertext: 'A'.repeat(config.maxCiphertextB64Length + 1) });
  assert.equal(tooLongCiphertext.statusCode, 400);
  assert.deepEqual(tooLongCiphertext.json(), { error: 'bad_request' });
  const hugeBody = await postCreate(app, { ...VALID_BODY, ciphertext: 'A'.repeat(config.bodyLimit + 10) });
  assert.equal(hugeBody.statusCode, 413);
  assert.deepEqual(hugeBody.json(), { error: 'payload_too_large' });
  const maxOk = await postCreate(app, { ...VALID_BODY, ciphertext: 'A'.repeat(config.maxCiphertextB64Length) });
  assert.equal(maxOk.statusCode, 201);
});

test('validation rejects malformed payloads', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  const cases = [
    { ...VALID_BODY, iv: 'A'.repeat(15) },
    { ...VALID_BODY, ciphertext: 'A'.repeat(43) + '+' },
    { ...VALID_BODY, ciphertext: 'A'.repeat(21) },
    { ...VALID_BODY, ttl: '2h' },
    { ...VALID_BODY, burnAfterRead: 'true' },
    { ...VALID_BODY, extra: 1 },
    { ciphertext: VALID_BODY.ciphertext, iv: VALID_BODY.iv, ttl: '1h' }
  ];
  for (const body of cases) {
    const res = await postCreate(app, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.deepEqual(res.json(), { error: 'bad_request' });
  }
  const invalidJson = await app.inject({ method: 'POST', url: '/api/create', headers: { 'content-type': 'application/json' }, payload: '{bad' });
  assert.equal(invalidJson.statusCode, 400);
  const wrongType = await app.inject({ method: 'POST', url: '/api/create', headers: { 'content-type': 'text/plain' }, payload: 'x' });
  assert.equal(wrongType.statusCode, 415);
  assert.deepEqual(wrongType.json(), { error: 'unsupported_media_type' });
});

test('unknown ids and paths return uniform 404', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  for (const url of ['/api/notes/not-a-uuid', `/api/notes/${SOME_UUID}`, '/nie-uuid', '/api/other']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.json(), { error: 'not_found' }, url);
  }
});

test('note shell is static and does not touch the database', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  const { id } = (await postCreate(app)).json();
  const res = await app.inject({ method: 'GET', url: `/${id}` });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /Ktoś zostawił Ci wiadomość/);
  assert.equal(app.db.countNotes(), 1);
  const missing = await app.inject({ method: 'GET', url: `/${SOME_UUID}` });
  assert.equal(missing.statusCode, 200);
});

test('root redirects to create and healthz responds', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, '/create');
  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true });
});

test('security headers are present, assets are cacheable', async (t) => {
  const { app } = await buildTestApp();
  t.after(() => app.close());
  for (const url of ['/create', `/${SOME_UUID}`, `/api/notes/${SOME_UUID}`]) {
    const res = await app.inject({ method: 'GET', url });
    assert.match(res.headers['content-security-policy'], /default-src 'none'/, url);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/, url);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', url);
    assert.equal(res.headers['x-frame-options'], 'DENY', url);
    assert.equal(res.headers['cache-control'], 'no-store', url);
  }
  const asset = await app.inject({ method: 'GET', url: '/assets/app.css' });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['cache-control'], /max-age=3600/);
  assert.match(asset.headers['content-security-policy'], /default-src 'none'/);
});
