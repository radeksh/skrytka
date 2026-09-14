import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createAllowlistHook } from './allowlist.js';
import { registerSecurityHeaders } from './securityHeaders.js';
import { startCleanup } from './cleanup.js';
import { notesRoutes } from './routes/notes.js';
import { pageRoutes } from './routes/pages.js';

const assetsDir = fileURLToPath(new URL('../public/assets/', import.meta.url));

export async function buildApp(config, { now = Date.now } = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy.length ? config.trustProxy.map((c) => `${c[0].toString()}/${c[1]}`) : false,
    bodyLimit: config.bodyLimit,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } }
  });

  const db = openDatabase(config.dbPath);
  app.decorate('db', db);
  app.decorate('now', now);

  registerSecurityHeaders(app);
  app.removeContentTypeParser('text/plain');

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler((err, request, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'bad_request' });
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) return reply.code(413).send({ error: 'payload_too_large' });
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 415) return reply.code(415).send({ error: 'unsupported_media_type' });
    if (err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.statusCode === 400) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  await app.register(fastifyStatic, {
    root: assetsDir,
    prefix: '/assets/',
    wildcard: false,
    index: false,
    list: false,
    cacheControl: true,
    maxAge: '1h',
    etag: true
  });

  const allowlistHook = createAllowlistHook(config.createAllowedCidrs, app.log);
  if (!allowlistHook) app.log.info('application level allowlist disabled, relying on the proxy layer');

  await app.register(notesRoutes, { db, config, allowlistHook });
  await app.register(pageRoutes, { allowlistHook });

  const stopCleanup = startCleanup({ db, intervalMs: config.cleanupIntervalMs, now, log: app.log });
  app.addHook('onClose', async () => {
    stopCleanup();
    db.close();
  });

  return app;
}
