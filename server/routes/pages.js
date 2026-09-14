import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UUID_V4_RE } from '../../shared/constants.js';

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));

export async function pageRoutes(app, { allowlistHook }) {
  const createHtml = readFileSync(new URL('create.html', `file://${publicDir}`), 'utf8');
  const noteHtml = readFileSync(new URL('note.html', `file://${publicDir}`), 'utf8');

  app.get('/', async (request, reply) => reply.redirect('/create', 302));

  app.get('/create', { preHandler: allowlistHook ? [allowlistHook] : [] }, async (request, reply) => {
    return reply.type('text/html; charset=utf-8').send(createHtml);
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/:id', async (request, reply) => {
    if (!UUID_V4_RE.test(request.params.id)) return reply.callNotFound();
    return reply.type('text/html; charset=utf-8').send(noteHtml);
  });
}
