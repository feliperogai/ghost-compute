import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser } from '../auth/plugin.js';
import { uuidParam } from '../modules/schemas.js';
import { DashboardService, RANGES } from './dashboard.js';

const range = z.object({ range: z.enum(Object.keys(RANGES) as [keyof typeof RANGES]).default('24h') });

/** Read-only API for the admin dashboard (viewer role and up). */
export const dashboardRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new DashboardService(ctx);
    const viewer = requireUser(ctx, 'viewer');
    app.get('/v1/dashboard/overview', { onRequest: viewer }, async () => svc.overview());
    app.get('/v1/dashboard/history', { onRequest: viewer, schema: { querystring: range } }, async (req) =>
      svc.history(req.query.range),
    );
    app.get('/v1/dashboard/workers', { onRequest: viewer }, async () => svc.workers());
    app.get(
      '/v1/dashboard/workers/:id',
      { onRequest: viewer, schema: { params: uuidParam, querystring: range } },
      async (req) => svc.worker(req.params.id, req.query.range),
    );
    app.get(
      '/v1/dashboard/errors',
      {
        onRequest: viewer,
        schema: {
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(500).default(100),
            kind: z.enum(['api', 'attempt', 'calibration']).optional(),
            workerId: z.uuid().optional(),
          }),
        },
      },
      async (req) => svc.errors(req.query),
    );
  };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serves the built dashboard (dashboard/dist) at /dashboard/ when present. Static files
 * only; the page talks to the API with the operator's own token.
 */
export async function serveDashboard(app: FastifyInstance, dir = process.env.DASHBOARD_DIR) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(
    dir ?? [path.resolve(here, '../../../dashboard/dist'), path.resolve(here, '../../../../dashboard/dist')].find((d) => existsSync(d)) ?? '',
  );
  if (!root || !existsSync(path.join(root, 'index.html'))) return;
  const send = (file: string, reply: import('fastify').FastifyReply) =>
    reply
      .header('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
      .header('cache-control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      )
      .send(readFileSync(file));
  app.get('/dashboard', async (_req, reply) => reply.redirect('/dashboard/'));
  app.get('/dashboard/*', async (req, reply) => {
    const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
    const file = path.resolve(root, rel);
    // Never outside the build directory; unknown paths are client-side routes.
    if (file.startsWith(root + path.sep) && existsSync(file) && statSync(file).isFile()) return send(file, reply);
    return send(path.join(root, 'index.html'), reply);
  });
}
