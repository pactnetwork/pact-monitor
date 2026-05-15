import { describe, it, expect } from 'vitest';
import { createApp } from '../src/index';

describe('createApp — CORS + health wiring (5.C)', () => {
  const app = createApp();

  it('CORS preflight is answered with permissive origin', async () => {
    const res = await app.request('/v1/og-qwen/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dash.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect([204, 200]).toContain(res.status);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('GET /health works through the app and exposes X-Pact-* via CORS', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'https://dash.example' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; endpoints: string[] };
    expect(body.status).toBe('ok');
    expect(body.endpoints).toContain('og-qwen');
    const expose = res.headers.get('access-control-expose-headers') ?? '';
    expect(expose).toContain('X-Pact-Premium');
    expect(expose).toContain('x-zerog-chat-id');
  });
});
