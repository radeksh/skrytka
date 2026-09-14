import { SECURITY_HEADERS, cacheControlFor } from '../shared/securityHeaders.js';

export function registerSecurityHeaders(app) {
  app.addHook('onSend', async (request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    reply.header('Cache-Control', cacheControlFor(request.url));
  });
}
