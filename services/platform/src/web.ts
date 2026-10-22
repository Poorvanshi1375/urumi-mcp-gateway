// Serves the dashboard build (services/dashboard → /app/public in the image) with SPA fallback,
// so deep links such as /invite/<token> load the app. API, MCP and probe routes are never shadowed.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

const NOT_SPA = /^\/(api|mcp|healthz|readyz|\.well-known)(\/|$|\?)/;

export async function registerWeb(app: FastifyInstance, dir = process.env.DASHBOARD_DIR ?? path.resolve('public')) {
  // Baseline browser hardening for every response.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    // The dashboard loads only its own scripts, styles and fonts and talks only to this origin.
    // (Inline style attributes are allowed: React sets styles through the DOM, not markup.)
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  });
  if (!existsSync(path.join(dir, 'index.html'))) {
    app.log.warn({ dir }, 'dashboard build not found; serving API and MCP only');
    return;
  }
  await app.register(fastifyStatic, {
    root: dir,
    wildcard: false,
    // Vite emits content-hashed assets: cache them forever; never cache index.html.
    setHeaders: (res, file) => res.header('cache-control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !NOT_SPA.test(req.url) && (req.headers.accept ?? '').includes('text/html')) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
}
