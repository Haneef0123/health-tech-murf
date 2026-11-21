import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { authConfig } from './config.js';

// Hash first so the comparison is constant-time even when the lengths differ.
const same = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/**
 * HTTP Basic Auth for the test page and /api/*. Enabled when BASIC_AUTH_PASS is set.
 * On Render (RENDER is set) it refuses to start without a password, so /api is never public by accident.
 * shortcut: one shared password, no lockout or rate limit; replace with real auth before real use.
 */
export function basicAuth(): RequestHandler {
  const { BASIC_AUTH_USER, BASIC_AUTH_PASS } = authConfig();
  if (!BASIC_AUTH_PASS) {
    if (process.env.RENDER) throw new Error('BASIC_AUTH_PASS is required when deployed: refusing to expose /api without a login');
    return (_req, _res, next) => next(); // local dev: no login
  }
  return (req, res, next) => {
    const m = /^Basic (.+)$/.exec(req.header('authorization') ?? '');
    const [user = '', ...rest] = m ? Buffer.from(m[1], 'base64').toString().split(':') : [];
    if (m && same(user, BASIC_AUTH_USER) && same(rest.join(':'), BASIC_AUTH_PASS)) return next();
    res.set('WWW-Authenticate', 'Basic realm="check-in"').status(401).send('Authentication required');
  };
}
