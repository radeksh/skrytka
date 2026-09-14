import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseCidrList } from '../server/allowlist.js';

test('parseCidrList normalises bare addresses', () => {
  const list = parseCidrList('10.0.0.1, 2001:db8::1, 192.168.0.0/16');
  assert.equal(list.length, 3);
  assert.equal(list[0][1], 32);
  assert.equal(list[1][1], 128);
  assert.equal(list[2][1], 16);
});

test('parseCidrList rejects garbage', () => {
  assert.throws(() => parseCidrList('10.0.0.0/8,not-an-ip'), /invalid CIDR "not-an-ip"/);
  assert.throws(() => parseCidrList('10.0.0.0/33'), /invalid CIDR/);
});

test('isAllowed matches ipv4 ranges', () => {
  const cidrs = parseCidrList('10.0.0.0/8');
  assert.equal(isAllowed('10.20.30.40', cidrs), true);
  assert.equal(isAllowed('11.0.0.1', cidrs), false);
});

test('isAllowed handles ipv4 mapped ipv6', () => {
  const cidrs = parseCidrList('10.0.0.0/8');
  assert.equal(isAllowed('::ffff:10.0.0.5', cidrs), true);
  assert.equal(isAllowed('::ffff:11.0.0.5', cidrs), false);
});

test('isAllowed handles ipv6 ranges and kind mismatch', () => {
  const cidrs = parseCidrList('2001:db8::/32');
  assert.equal(isAllowed('2001:db8:1::1', cidrs), true);
  assert.equal(isAllowed('2001:db9::1', cidrs), false);
  assert.equal(isAllowed('10.0.0.1', cidrs), false);
});

test('isAllowed is false for garbage and empty lists', () => {
  assert.equal(isAllowed('garbage', parseCidrList('0.0.0.0/0')), false);
  assert.equal(isAllowed(undefined, parseCidrList('0.0.0.0/0')), false);
  assert.equal(isAllowed('10.0.0.1', []), false);
});
