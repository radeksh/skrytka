import { loadConfig } from '../server/config.js';
import { buildApp } from '../server/app.js';

export const VALID_BODY = Object.freeze({
  ciphertext: 'A'.repeat(44),
  iv: 'A'.repeat(16),
  ttl: '1h',
  burnAfterRead: true
});

export const ALLOWED_IP = '10.1.2.3';
export const DENIED_IP = '203.0.113.7';

export async function buildTestApp(overrides = {}) {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const config = loadConfig({
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    ...overrides
  });
  const app = await buildApp(config, { now: () => clock.t });
  await app.ready();
  return { app, clock, config };
}

export function postCreate(app, body = VALID_BODY, { remoteAddress = ALLOWED_IP, headers = {} } = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/create',
    remoteAddress,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body
  });
}

export function getNote(app, id) {
  return app.inject({ method: 'GET', url: `/api/notes/${id}` });
}
