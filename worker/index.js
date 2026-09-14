import {
  B64URL_RE,
  GCM_TAG_BYTES,
  IV_B64URL_LENGTH,
  MIN_CIPHERTEXT_B64URL_LENGTH,
  TTL_OPTIONS,
  UUID_V4_RE
} from '../shared/constants.js';
import { SECURITY_HEADERS, cacheControlFor } from '../shared/securityHeaders.js';

const DEFAULT_MAX_NOTE_BYTES = 65_536;
const NOT_FOUND = { error: 'not_found' };

function limits(env) {
  const maxNoteBytes = Number.parseInt(env.MAX_NOTE_BYTES ?? '', 10) || DEFAULT_MAX_NOTE_BYTES;
  const maxCiphertextB64Length = Math.ceil(((maxNoteBytes + GCM_TAG_BYTES) * 4) / 3);
  return { maxCiphertextB64Length, bodyLimit: maxCiphertextB64Length + 1024 };
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

function validateCreate(body, maxCiphertextB64Length) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== 4) return false;
  const { ciphertext, iv, ttl, burnAfterRead } = body;
  if (typeof ciphertext !== 'string' || ciphertext.length < MIN_CIPHERTEXT_B64URL_LENGTH || ciphertext.length > maxCiphertextB64Length || !B64URL_RE.test(ciphertext)) return false;
  if (typeof iv !== 'string' || iv.length !== IV_B64URL_LENGTH || !B64URL_RE.test(iv)) return false;
  if (typeof ttl !== 'string' || !Object.hasOwn(TTL_OPTIONS, ttl)) return false;
  if (typeof burnAfterRead !== 'boolean') return false;
  return true;
}

async function createNote(request, env) {
  if (await rateLimited(env.CREATE_LIMITER, request)) return json(429, { error: 'too_many_requests' });
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(contentType)) return json(415, { error: 'unsupported_media_type' });

  const { maxCiphertextB64Length, bodyLimit } = limits(env);
  const raw = await readBodyLimited(request, bodyLimit);
  if (raw === null) return json(413, { error: 'payload_too_large' });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'bad_request' });
  }
  if (!validateCreate(body, maxCiphertextB64Length)) return json(400, { error: 'bad_request' });

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + TTL_OPTIONS[body.ttl];
  await env.DB.prepare(
    'INSERT INTO notes (id, ciphertext, iv, burn_after_read, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  )
    .bind(id, body.ciphertext, body.iv, body.burnAfterRead ? 1 : 0, createdAt, expiresAt)
    .run();

  return json(201, { id, expiresAt: new Date(expiresAt).toISOString(), burnAfterRead: body.burnAfterRead });
}

async function noteInfo(request, env, id) {
  if (!UUID_V4_RE.test(id)) return json(404, NOT_FOUND);
  if (await rateLimited(env.READ_LIMITER, request)) return json(429, { error: 'too_many_requests' });
  const row = await env.DB.prepare('SELECT burn_after_read, expires_at FROM notes WHERE id = ?1 AND expires_at > ?2')
    .bind(id, Date.now())
    .first();
  if (!row) return json(404, NOT_FOUND);
  return json(200, { burnAfterRead: row.burn_after_read === 1, expiresAt: new Date(row.expires_at).toISOString() });
}

async function readNote(request, env, id) {
  if (!UUID_V4_RE.test(id)) return json(404, NOT_FOUND);
  if (await rateLimited(env.READ_LIMITER, request)) return json(429, { error: 'too_many_requests' });

  const now = Date.now();
  const burned = await env.DB.prepare(
    'DELETE FROM notes WHERE id = ?1 AND burn_after_read = 1 AND expires_at > ?2 RETURNING ciphertext, iv, expires_at'
  )
    .bind(id, now)
    .first();
  const row = burned
    ? { ...burned, burnAfterRead: true }
    : await env.DB.prepare(
        'UPDATE notes SET read_count = read_count + 1, last_read_at = ?1 WHERE id = ?2 AND burn_after_read = 0 AND expires_at > ?1 RETURNING ciphertext, iv, expires_at'
      )
        .bind(now, id)
        .first()
        .then((r) => (r ? { ...r, burnAfterRead: false } : null));

  if (!row) return json(404, NOT_FOUND);
  return json(200, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    burnAfterRead: row.burnAfterRead,
    expiresAt: new Date(row.expires_at).toISOString()
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

  const infoMatch = path.match(/^\/api\/notes\/([^/]+)\/info$/);
  if (infoMatch && method === 'GET') return noteInfo(request, env, infoMatch[1]);

  const apiMatch = path.match(/^\/api\/notes\/([^/]+)$/);
  if (apiMatch && method === 'GET') return readNote(request, env, apiMatch[1]);

  const pageMatch = path.match(/^\/([^/]+)\/?$/);
  if (pageMatch && method === 'GET' && UUID_V4_RE.test(pageMatch[1])) return servePage(env, url, '/note.html');

  return json(404, NOT_FOUND);
}

async function deleteExpired(env) {
  const result = await env.DB.prepare('DELETE FROM notes WHERE expires_at <= ?1').bind(Date.now()).run();
  const deleted = result.meta?.changes ?? 0;
  if (deleted) console.log(JSON.stringify({ level: 'info', message: 'expired notes removed', deleted }));
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
    ctx.waitUntil(deleteExpired(env));
  }
};
