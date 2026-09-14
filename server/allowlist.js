import ipaddr from 'ipaddr.js';

export function parseCidrList(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const withMask = entry.includes('/') ? entry : `${entry}/${ipaddr.IPv6.isValid(entry) && !ipaddr.IPv4.isValid(entry) ? 128 : 32}`;
      try {
        return ipaddr.parseCIDR(withMask);
      } catch {
        throw new Error(`invalid CIDR "${entry}"`);
      }
    });
}

export function cidrToString(cidr) {
  return `${cidr[0].toString()}/${cidr[1]}`;
}

export function isAllowed(ip, cidrs) {
  if (!cidrs.length || typeof ip !== 'string') return false;
  let addr;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }
  return cidrs.some(([range, bits]) => addr.kind() === range.kind() && addr.match(range, bits));
}

export function createAllowlistHook(cidrs, log) {
  if (!cidrs.length) return null;
  return async function allowlistHook(request, reply) {
    if (!isAllowed(request.ip, cidrs)) {
      log.warn({ ip: request.ip, url: request.url }, 'create denied by allowlist');
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
