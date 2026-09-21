import {
  FILE_OVERHEAD_BYTES,
  FILE_TOKEN_RE,
  FILE_TOKEN_TTL_MS,
  FRAME_HEADER_BYTES,
  FRAME_META_MAX_BYTES,
  GCM_TAG_BYTES,
  NOTE_FRAME_CONTENT_TYPE,
  TTL_OPTIONS,
  UUID_V4_RE
} from '../shared/constants.js';
import { SECURITY_HEADERS, cacheControlFor } from '../shared/securityHeaders.js';
import { isValidCreateMeta, parseFrameHeader } from '../shared/validate.js';

const DEFAULT_MAX_NOTE_BYTES = 65_536;
const DEFAULT_MAX_UPLOAD_BYTES = 10_485_760;
const DEFAULT_FILE_QUOTA_BYTES = 5_368_709_120;
const NOT_FOUND = { error: 'not_found' };

function limits(env) {
  const maxNoteBytes = Number.parseInt(env.MAX_NOTE_BYTES ?? '', 10) || DEFAULT_MAX_NOTE_BYTES;
  const maxCiphertextB64Length = Math.ceil(((maxNoteBytes + GCM_TAG_BYTES) * 4) / 3);
  const maxUploadRaw = Number.parseInt(env.MAX_UPLOAD_BYTES ?? '', 10);
  const maxUploadBytes = Number.isNaN(maxUploadRaw) ? DEFAULT_MAX_UPLOAD_BYTES : maxUploadRaw;
  const quotaRaw = Number.parseInt(env.FILE_QUOTA_BYTES ?? '', 10);
  return {
    maxCiphertextB64Length,
    bodyLimit: maxCiphertextB64Length + 1024,
    maxUploadBytes,
    uploadBodyLimit: FRAME_HEADER_BYTES + FRAME_META_MAX_BYTES + maxUploadBytes + FILE_OVERHEAD_BYTES,
    fileQuotaBytes: Number.isNaN(quotaRaw) ? DEFAULT_FILE_QUOTA_BYTES : quotaRaw
  };
}

function finalize(response, pathname) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set('Cache-Control', cacheControlFor(pathname));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function clientKey(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

async function rateLimited(limiter, request) {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key: clientKey(request) });
  return !success;
}

async function readBodyLimited(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

async function readFrameHeader(body) {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let metaLength = null;
  for (;;) {
    if (metaLength === null && buffer.byteLength >= FRAME_HEADER_BYTES) {
      metaLength = parseFrameHeader(buffer.subarray(0, FRAME_HEADER_BYTES));
      if (metaLength === 0 || metaLength > FRAME_META_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
    }
    if (metaLength !== null && buffer.byteLength >= FRAME_HEADER_BYTES + metaLength) break;
    const { value, done } = await reader.read();
    if (done) return null;
    buffer = concat(buffer, value);
  }
  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + metaLength)));
  } catch {
    await reader.cancel();
    return null;
  }
  return { meta, metaLength, leftover: buffer.subarray(FRAME_HEADER_BYTES + metaLength), reader };
}

async function storeNote(env, meta, extra = {}) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + TTL_OPTIONS[meta.ttl];
  await env.DB.prepare(
    'INSERT INTO notes (id, ciphertext, iv, burn_after_read, created_at, expires_at, file_key, file_size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  )
    .bind(id, meta.ciphertext, meta.iv, meta.burnAfterRead ? 1 : 0, createdAt, expiresAt, extra.fileKey ?? null, extra.fileSize ?? null)
    .run();
  return json(201, { id, expiresAt: new Date(expiresAt).toISOString(), burnAfterRead: meta.burnAfterRead });
}

async function createNote(request, env) {
  if (await rateLimited(env.CREATE_LIMITER, request)) return json(429, { error: 'too_many_requests' });
  const contentType = request.headers.get('Content-Type') ?? '';
  const cfg = limits(env);

  if (/^application\/json\b/i.test(contentType)) {
    const raw = await readBodyLimited(request, cfg.bodyLimit);
    if (raw === null) return json(413, { error: 'payload_too_large' });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'bad_request' });
    }
    if (!isValidCreateMeta(body, cfg.maxCiphertextB64Length)) return json(400, { error: 'bad_request' });
    return storeNote(env, body);
  }

  if (!contentType.startsWith(NOTE_FRAME_CONTENT_TYPE)) return json(415, { error: 'unsupported_media_type' });
  if (!env.FILES || cfg.maxUploadBytes === 0) return json(415, { error: 'uploads_disabled' });

  const contentLength = Number(request.headers.get('Content-Length'));
  if (!Number.isInteger(contentLength) || contentLength <= 0) return json(411, { error: 'length_required' });
  if (contentLength > cfg.uploadBodyLimit) return json(413, { error: 'payload_too_large' });
  if (!request.body) return json(400, { error: 'bad_request' });

  const frame = await readFrameHeader(request.body);
  if (!frame) return json(400, { error: 'bad_request' });
  if (!isValidCreateMeta(frame.meta, cfg.maxCiphertextB64Length)) {
    await frame.reader.cancel();
    return json(400, { error: 'bad_request' });
  }

  const fileLength = contentLength - FRAME_HEADER_BYTES - frame.metaLength;
  if (fileLength < FILE_OVERHEAD_BYTES) {
    await frame.reader.cancel();
    return json(400, { error: 'bad_request' });
  }
  if (fileLength > cfg.maxUploadBytes + FILE_OVERHEAD_BYTES) {
    await frame.reader.cancel();
    return json(413, { error: 'payload_too_large' });
  }

  const usage = await env.DB.prepare('SELECT COALESCE(SUM(file_size), 0) AS used FROM notes').first();
  if ((usage?.used ?? 0) + fileLength > cfg.fileQuotaBytes) {
    await frame.reader.cancel();
    return json(507, { error: 'storage_full' });
  }

  const fileKey = crypto.randomUUID();
  const { readable, writable } = new FixedLengthStream(fileLength);
  const pump = (async () => {
    const writer = writable.getWriter();
    try {
      if (frame.leftover.byteLength) await writer.write(frame.leftover);
      for (;;) {
        const { value, done } = await frame.reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    }
  })();

  try {
    await Promise.all([env.FILES.put(fileKey, readable), pump]);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'upload failed', detail: err.message }));
    await env.FILES.delete(fileKey).catch(() => {});
    return json(400, { error: 'bad_request' });
  }
  return storeNote(env, frame.meta, { fileKey, fileSize: fileLength });
}

async function noteInfo(request, env, id) {
  if (!UUID_V4_RE.test(id)) return json(404, NOT_FOUND);
  if (await rateLimited(env.READ_LIMITER, request)) return json(429, { error: 'too_many_requests' });
  const row = await env.DB.prepare('SELECT burn_after_read, expires_at, file_size FROM notes WHERE id = ?1 AND expires_at > ?2')
    .bind(id, Date.now())
    .first();
  if (!row) return json(404, NOT_FOUND);
  return json(200, {
    burnAfterRead: row.burn_after_read === 1,
    expiresAt: new Date(row.expires_at).toISOString(),
    hasFile: row.file_size !== null,
    fileSize: row.file_size
  });
}

async function readNote(request, env, id) {
  if (!UUID_V4_RE.test(id)) return json(404, NOT_FOUND);
  if (await rateLimited(env.READ_LIMITER, request)) return json(429, { error: 'too_many_requests' });

  const now = Date.now();
  const burned = await env.DB.prepare(
    'DELETE FROM notes WHERE id = ?1 AND burn_after_read = 1 AND expires_at > ?2 RETURNING ciphertext, iv, expires_at, file_key, file_size'
  )
    .bind(id, now)
    .first();
  const row = burned
    ? { ...burned, burnAfterRead: true }
    : await env.DB.prepare(
        'UPDATE notes SET read_count = read_count + 1, last_read_at = ?1 WHERE id = ?2 AND burn_after_read = 0 AND expires_at > ?1 RETURNING ciphertext, iv, expires_at, file_key, file_size'
      )
        .bind(now, id)
        .first()
        .then((r) => (r ? { ...r, burnAfterRead: false } : null));

  if (!row) return json(404, NOT_FOUND);

  let file = null;
  if (row.file_key) {
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO file_tokens (token, note_id, file_key, burn, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(token, id, row.file_key, row.burnAfterRead ? 1 : 0, now + FILE_TOKEN_TTL_MS)
      .run();
    file = { size: row.file_size, token };
  }

  return json(200, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    burnAfterRead: row.burnAfterRead,
    expiresAt: new Date(row.expires_at).toISOString(),
    file
  });
}

async function downloadFile(request, env, id, token) {
  if (!UUID_V4_RE.test(id) || !FILE_TOKEN_RE.test(token)) return json(404, NOT_FOUND);
  if (!env.FILES) return json(404, NOT_FOUND);
  const grant = await env.DB.prepare(
    'UPDATE file_tokens SET used = 1 WHERE token = ?1 AND note_id = ?2 AND used = 0 AND expires_at > ?3 RETURNING file_key'
  )
    .bind(token, id, Date.now())
    .first();
  if (!grant) return json(404, NOT_FOUND);
  const object = await env.FILES.get(grant.file_key);
  if (!object) return json(404, NOT_FOUND);
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Content-Disposition': 'attachment'
    }
  });
}

function servePage(env, url, file) {
  return env.ASSETS.fetch(new URL(file, url.origin));
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method === 'HEAD' ? 'GET' : request.method;

  if (path.startsWith('/assets/')) {
    if (method !== 'GET') return json(404, NOT_FOUND);
    return env.ASSETS.fetch(request);
  }
  if (path === '/' && method === 'GET') return Response.redirect(new URL('/create', url.origin).toString(), 302);
  if (path === '/create' && method === 'GET') return servePage(env, url, '/create.html');
  if (path === '/healthz' && method === 'GET') return json(200, { ok: true });
  if (path === '/api/create' && method === 'POST') return createNote(request, env);

  const fileMatch = path.match(/^\/api\/notes\/([^/]+)\/file\/([^/]+)$/);
  if (fileMatch && method === 'GET') return downloadFile(request, env, fileMatch[1], fileMatch[2]);

  const infoMatch = path.match(/^\/api\/notes\/([^/]+)\/info$/);
  if (infoMatch && method === 'GET') return noteInfo(request, env, infoMatch[1]);

  const apiMatch = path.match(/^\/api\/notes\/([^/]+)$/);
  if (apiMatch && method === 'GET') return readNote(request, env, apiMatch[1]);

  const pageMatch = path.match(/^\/([^/]+)\/?$/);
  if (pageMatch && method === 'GET' && UUID_V4_RE.test(pageMatch[1])) return servePage(env, url, '/note.html');

  return json(404, NOT_FOUND);
}

async function sweepExpired(env) {
  const now = Date.now();
  const orphanKeys = new Set();

  const expiredNotes = await env.DB.prepare('SELECT file_key FROM notes WHERE expires_at <= ?1 AND file_key IS NOT NULL').bind(now).all();
  for (const row of expiredNotes.results ?? []) orphanKeys.add(row.file_key);
  const deletedNotes = (await env.DB.prepare('DELETE FROM notes WHERE expires_at <= ?1').bind(now).run()).meta?.changes ?? 0;

  const expiredTokens = await env.DB.prepare('SELECT DISTINCT file_key FROM file_tokens WHERE expires_at <= ?1').bind(now).all();
  await env.DB.prepare('DELETE FROM file_tokens WHERE expires_at <= ?1').bind(now).run();
  for (const row of expiredTokens.results ?? []) {
    const stillReferenced = await env.DB.prepare('SELECT 1 FROM notes WHERE file_key = ?1 LIMIT 1').bind(row.file_key).first();
    if (!stillReferenced) orphanKeys.add(row.file_key);
  }

  const keys = [...orphanKeys];
  if (keys.length && env.FILES) await env.FILES.delete(keys);
  if (deletedNotes || keys.length) console.log(JSON.stringify({ level: 'info', message: 'expired data removed', deletedNotes, deletedFiles: keys.length }));
}

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    try {
      return finalize(await route(request, env), pathname);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', message: err.message, path: pathname }));
      return finalize(json(500, { error: 'internal' }), pathname);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sweepExpired(env));
  }
};
