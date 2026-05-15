import type { Context } from 'hono';
import { DEFAULT_PROVIDERS } from '../endpoints.js';

/** GET /health — liveness + the insured slugs this proxy serves. */
export function healthRoute(c: Context): Response {
  return c.json({
    status: 'ok',
    version: 'v1',
    endpoints: Object.keys(DEFAULT_PROVIDERS),
  });
}
