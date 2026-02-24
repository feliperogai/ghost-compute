import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, requireWorker, userId, workerId } from '../auth/plugin.js';
import { uuidParam } from '../modules/schemas.js';
import { CalibrationService } from './service.js';

const MAX_TRANSFER = 32 * 1024 * 1024;

/** Worker side of the calibration: latency, bandwidth, report. */
export const calibrationWorkerRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new CalibrationService(ctx);
    app.addHook('onRequest', requireWorker(ctx));
    // Upload payload only: raw bytes, bounded.
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_TRANSFER }, (_r, body, done) =>
      done(null, body),
    );

    app.get('/v1/worker/calibration/ping', async () => ({ serverTime: new Date().toISOString() }));

    app.get('/v1/worker/calibration/:id/download', { schema: { params: uuidParam } }, async (req, reply) =>
      reply
        .header('content-type', 'application/octet-stream')
        .header('cache-control', 'no-store')
        .send(await svc.download(workerId(req), req.params.id)),
    );

    app.post(
      '/v1/worker/calibration/:id/upload',
      {
        bodyLimit: MAX_TRANSFER,
        schema: { params: uuidParam },
        // Timed from the first byte of the request to the end of the body.
        onRequest: async (req) => {
          (req as { t0?: bigint }).t0 = process.hrtime.bigint();
        },
      },
      async (req) => {
        const t0 = (req as { t0?: bigint }).t0 ?? process.hrtime.bigint();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        return svc.upload(workerId(req), req.params.id, body, ms);
      },
    );

    app.post(
      '/v1/worker/calibration/:id/report',
      { bodyLimit: 256 * 1024, schema: { params: uuidParam, body: z.unknown() } },
      async (req) => {
        const r = await svc.report(workerId(req), req.params.id, req.body);
        return { status: r.status, issues: r.issues, scores: r.profile.scores };
      },
    );
  };

/** Operator side: read profiles, force a new calibration. */
export const performanceRoutes =
  (ctx: AppContext): FastifyPluginAsyncZod =>
  async (app) => {
    const svc = new CalibrationService(ctx);
    app.get('/v1/workers/:id/profile', { onRequest: requireUser(ctx, 'viewer'), schema: { params: uuidParam } }, async (req) =>
      svc.profile(req.params.id),
    );
    app.post(
      '/v1/workers/:id/calibrate',
      { onRequest: requireUser(ctx, 'admin'), schema: { params: uuidParam } },
      async (req, reply) => {
        await svc.profile(req.params.id); // 404 for unknown workers
        const r = await svc.request(req.params.id, `requested by ${userId(req)}`);
        return reply.status(202).send({ calibrationId: r.id, deadline: r.deadline });
      },
    );
  };
