import { randomUUID } from 'node:crypto';
import { B64URL_PATTERN, IV_B64URL_LENGTH, MIN_CIPHERTEXT_B64URL_LENGTH, TTL_OPTIONS, UUID_V4_RE } from '../../shared/constants.js';

export async function notesRoutes(app, { db, config, allowlistHook }) {
  const createSchema = {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['ciphertext', 'iv', 'ttl', 'burnAfterRead'],
      properties: {
        ciphertext: {
          type: 'string',
          minLength: MIN_CIPHERTEXT_B64URL_LENGTH,
          maxLength: config.maxCiphertextB64Length,
          pattern: B64URL_PATTERN
        },
        iv: { type: 'string', minLength: IV_B64URL_LENGTH, maxLength: IV_B64URL_LENGTH, pattern: B64URL_PATTERN },
        ttl: { type: 'string', enum: Object.keys(TTL_OPTIONS) },
        burnAfterRead: { type: 'boolean' }
      }
    }
  };

  app.post('/api/create', { schema: createSchema, preHandler: allowlistHook ? [allowlistHook] : [] }, async (request, reply) => {
    const { ciphertext, iv, ttl, burnAfterRead } = request.body;
    const id = randomUUID();
    const createdAt = app.now();
    const expiresAt = createdAt + TTL_OPTIONS[ttl];
    db.insertNote({ id, ciphertext, iv, burnAfterRead, createdAt, expiresAt });
    return reply.code(201).send({ id, expiresAt: new Date(expiresAt).toISOString(), burnAfterRead });
  });

  app.get('/api/notes/:id/info', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_V4_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const info = db.getNoteInfo(id, app.now());
    if (!info) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ burnAfterRead: info.burnAfterRead, expiresAt: new Date(info.expiresAt).toISOString() });
  });

  app.get('/api/notes/:id', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_V4_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const note = db.consumeNote(id, app.now());
    if (!note) return reply.code(404).send({ error: 'not_found' });
    return reply.send({
      ciphertext: note.ciphertext,
      iv: note.iv,
      burnAfterRead: note.burnAfterRead,
      expiresAt: new Date(note.expiresAt).toISOString()
    });
  });
}
