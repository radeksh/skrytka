import { randomUUID } from 'node:crypto';
import {
  FILE_OVERHEAD_BYTES,
  FILE_TOKEN_RE,
  FRAME_HEADER_BYTES,
  FRAME_META_MAX_BYTES,
  NOTE_FRAME_CONTENT_TYPE,
  TTL_OPTIONS,
  UUID_V4_RE
} from '../../shared/constants.js';
import { isValidCreateMeta, parseFrameHeader } from '../../shared/validate.js';

const NOT_FOUND = { error: 'not_found' };

class FrameError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function readFrameHeader(stream) {
  let buffer = Buffer.alloc(0);
  const iterator = stream[Symbol.asyncIterator]();
  let metaLength = null;
  for (;;) {
    if (metaLength === null && buffer.length >= FRAME_HEADER_BYTES) {
      metaLength = parseFrameHeader(buffer.subarray(0, FRAME_HEADER_BYTES));
      if (metaLength === 0 || metaLength > FRAME_META_MAX_BYTES) throw new FrameError(400, 'bad_request');
    }
    if (metaLength !== null && buffer.length >= FRAME_HEADER_BYTES + metaLength) break;
    const { value, done } = await iterator.next();
    if (done) throw new FrameError(400, 'bad_request');
    buffer = Buffer.concat([buffer, value]);
  }
  const metaBytes = buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + metaLength);
  const leftover = buffer.subarray(FRAME_HEADER_BYTES + metaLength);
  let meta;
  try {
    meta = JSON.parse(metaBytes.toString('utf8'));
  } catch {
    throw new FrameError(400, 'bad_request');
  }
  const rest = (async function* () {
    if (leftover.length) yield leftover;
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) return;
      yield value;
    }
  })();
  return { meta, metaLength, rest };
}

export async function notesRoutes(app, { db, files, config, allowlistHook }) {
  const preHandler = allowlistHook ? [allowlistHook] : [];

  function storeNote(meta, extra = {}) {
    const id = randomUUID();
    const createdAt = app.now();
    const expiresAt = createdAt + TTL_OPTIONS[meta.ttl];
    db.insertNote({ id, ciphertext: meta.ciphertext, iv: meta.iv, burnAfterRead: meta.burnAfterRead, createdAt, expiresAt, ...extra });
    return { id, expiresAt: new Date(expiresAt).toISOString(), burnAfterRead: meta.burnAfterRead };
  }

  app.post('/api/create', { preHandler }, async (request, reply) => {
    const contentType = request.headers['content-type'] ?? '';

    if (contentType.startsWith('application/json')) {
      if (!isValidCreateMeta(request.body, config.maxCiphertextB64Length)) return reply.code(400).send({ error: 'bad_request' });
      return reply.code(201).send(storeNote(request.body));
    }

    if (!contentType.startsWith(NOTE_FRAME_CONTENT_TYPE)) return reply.code(415).send({ error: 'unsupported_media_type' });
    if (config.maxUploadBytes === 0) return reply.code(415).send({ error: 'uploads_disabled' });

    const contentLength = Number(request.headers['content-length']);
    if (!Number.isInteger(contentLength) || contentLength <= 0) return reply.code(411).send({ error: 'length_required' });
    if (contentLength > config.uploadBodyLimit) return reply.code(413).send({ error: 'payload_too_large' });

    let frame;
    try {
      frame = await readFrameHeader(request.body);
    } catch (err) {
      if (err instanceof FrameError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
    if (!isValidCreateMeta(frame.meta, config.maxCiphertextB64Length)) return reply.code(400).send({ error: 'bad_request' });

    const fileLength = contentLength - FRAME_HEADER_BYTES - frame.metaLength;
    if (fileLength < FILE_OVERHEAD_BYTES) return reply.code(400).send({ error: 'bad_request' });
    if (fileLength > config.maxUploadBytes + FILE_OVERHEAD_BYTES) return reply.code(413).send({ error: 'payload_too_large' });
    if (db.usedFileBytes() + fileLength > config.fileQuotaBytes) return reply.code(507).send({ error: 'storage_full' });

    const fileKey = randomUUID();
    try {
      await files.writeFrom(fileKey, frame.rest, fileLength);
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ error: 'bad_request' });
      throw err;
    }
    return reply.code(201).send(storeNote(frame.meta, { fileKey, fileSize: fileLength }));
  });

  app.get('/api/notes/:id/info', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_V4_RE.test(id)) return reply.code(404).send(NOT_FOUND);
    const info = db.getNoteInfo(id, app.now());
    if (!info) return reply.code(404).send(NOT_FOUND);
    return reply.send({
      burnAfterRead: info.burnAfterRead,
      expiresAt: new Date(info.expiresAt).toISOString(),
      hasFile: info.fileSize !== null,
      fileSize: info.fileSize
    });
  });

  app.get('/api/notes/:id', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_V4_RE.test(id)) return reply.code(404).send(NOT_FOUND);
    const note = db.consumeNote(id, app.now());
    if (!note) return reply.code(404).send(NOT_FOUND);
    return reply.send({
      ciphertext: note.ciphertext,
      iv: note.iv,
      burnAfterRead: note.burnAfterRead,
      expiresAt: new Date(note.expiresAt).toISOString(),
      file: note.fileKey ? { size: note.fileSize, token: note.fileToken } : null
    });
  });

  app.get('/api/notes/:id/file/:token', async (request, reply) => {
    const { id, token } = request.params;
    if (!UUID_V4_RE.test(id) || !FILE_TOKEN_RE.test(token)) return reply.code(404).send(NOT_FOUND);
    const grant = db.useFileToken(token, id, app.now());
    if (!grant) return reply.code(404).send(NOT_FOUND);
    const size = await files.size(grant.fileKey);
    if (size === null) return reply.code(404).send(NOT_FOUND);
    const stream = files.stream(grant.fileKey);
    if (grant.burn) {
      reply.raw.once('finish', () => {
        files.remove(grant.fileKey).catch((err) => request.log.warn({ err }, 'file removal failed'));
      });
    }
    return reply
      .type('application/octet-stream')
      .header('Content-Length', size)
      .header('Content-Disposition', 'attachment')
      .send(stream);
  });
}
