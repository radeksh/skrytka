import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.dbPath, './data/skrytka.db');
  assert.deepEqual(c.createAllowedCidrs, []);
  assert.deepEqual(c.trustProxy, []);
  assert.equal(c.maxNoteBytes, 65536);
  assert.equal(c.maxCiphertextB64Length, Math.ceil(((65536 + 16) * 4) / 3));
  assert.equal(c.bodyLimit, c.maxCiphertextB64Length + 1024);
  assert.equal(c.cleanupIntervalMs, 60000);
  assert.equal(c.logLevel, 'info');
});

test('parses cidr lists', () => {
  const c = loadConfig({ CREATE_ALLOWED_CIDRS: '10.0.0.0/8, 192.168.1.5', TRUST_PROXY: '127.0.0.1/32,::1/128' });
  assert.equal(c.createAllowedCidrs.length, 2);
  assert.equal(c.createAllowedCidrs[1][1], 32);
  assert.equal(c.trustProxy.length, 2);
});

test('rejects boolean TRUST_PROXY', () => {
  assert.throws(() => loadConfig({ TRUST_PROXY: 'true' }), /boolean/);
});

test('rejects invalid values', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ CREATE_ALLOWED_CIDRS: '10.0.0.0/99' }), /invalid CIDR/);
  assert.throws(() => loadConfig({ LOG_LEVEL: 'loud' }), /LOG_LEVEL/);
  assert.throws(() => loadConfig({ MAX_NOTE_BYTES: '10' }), /MAX_NOTE_BYTES/);
});
