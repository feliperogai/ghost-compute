import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { bearer, isStaff, resolveUserToken, resolveWorkerToken, type Principal } from '../auth/plugin.js';
import { JobLifecycle } from '../jobs/lifecycle.js';
import type { PlatformEvent } from './bus.js';

export const WS_CLOSE = {
  UNAUTHORIZED: 4001,
  REVOKED: 4003,
  AUTH_TIMEOUT: 4008,
  POLICY: 1008,
} as const;

const AUTH_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 30_000;
const MAX_MSGS_PER_10S = 100;

const inbound = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(2000) }),
  z.object({
    type: z.literal('subscribe'),
    /** Event type prefixes, e.g. ["job.", "worker."]. Empty = everything. */
    types: z.array(z.string().max(50)).max(20).default([]),
    jobId: z.uuid().optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);

async function resolve(ctx: AppContext, token: string): Promise<Principal | null> {
  return token.startsWith('v1.') ? resolveWorkerToken(ctx, token) : resolveUserToken(ctx, token);
}

/**
 * GET /v1/ws
 * Auth: `Authorization: Bearer <token>` header, or first message {type:"auth", token}
 * (browsers cannot set headers on WebSocket). Tokens are never read from the URL.
 *  - users   receive platform events ({type:"event", event}); may narrow with "subscribe".
 *  - workers receive job assignments, assignment cancellations and revocation notices.
 */
export function registerWebSocket(app: FastifyInstance, ctx: AppContext) {
  const jobs = new JobLifecycle(ctx);

  app.get('/v1/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const log = req.log.child({ ws: true });
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    let principal: Principal | null = null;
    let cleanup: (() => void) | null = null;
    let filter: { types: string[]; jobId?: string | undefined } = { types: [] };
    let alive = true;
    let msgCount = 0;

    const authTimer = setTimeout(() => {
      if (!principal) socket.close(WS_CLOSE.AUTH_TIMEOUT, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    const rateTimer = setInterval(() => (msgCount = 0), 10_000);
    const pingTimer = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_INTERVAL_MS);
    socket.on('pong', () => (alive = true));

    const onAuthenticated = async (p: Principal) => {
      principal = p;
      clearTimeout(authTimer);
      if (p.kind === 'user' && !isStaff(p.role)) {
        // The event stream is platform-wide: public accounts follow their jobs over REST.
        socket.close(WS_CLOSE.REVOKED, 'forbidden');
        return;
      }
      if (p.kind === 'user') {
        log.info({ userId: p.userId }, 'ws user connected');
        cleanup = ctx.bus.onBroadcast((event: PlatformEvent) => {
          if (filter.types.length && !filter.types.some((t) => event.type.startsWith(t))) return;
          if (filter.jobId && event.data.jobId !== filter.jobId) return;
          send({ type: 'event', event });
        });
        send({ type: 'ready', principal: { kind: 'user', id: p.userId, role: p.role } });
      } else {
        log.info({ workerId: p.workerId }, 'ws worker connected');
        cleanup = ctx.bus.onWorker(p.workerId, (msg) => {
          send(msg);
          if (msg.type === 'worker.revoked') socket.close(WS_CLOSE.REVOKED, 'revoked');
        });
        send({ type: 'ready', principal: { kind: 'worker', id: p.workerId } });
        // Replay assignments made while disconnected.
        for (const assignment of await jobs.pendingFor(p.workerId)) send({ type: 'job.assigned', assignment });
      }
    };

    socket.on('message', async (raw: Buffer) => {
      if (++msgCount > MAX_MSGS_PER_10S) return socket.close(WS_CLOSE.POLICY, 'rate limit');
      let parsed: z.infer<typeof inbound>;
      try {
        parsed = inbound.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        return send({ type: 'error', code: 'BAD_MESSAGE', message: 'Invalid message' });
      }
      try {
        switch (parsed.type) {
          case 'auth': {
            if (principal) return send({ type: 'error', code: 'ALREADY_AUTHENTICATED', message: 'Already authenticated' });
            const p = await resolve(ctx, parsed.token);
            if (!p) return socket.close(WS_CLOSE.UNAUTHORIZED, 'unauthorized');
            return await onAuthenticated(p);
          }
          case 'subscribe':
            if (principal?.kind !== 'user')
              return send({ type: 'error', code: 'FORBIDDEN', message: 'Only users can subscribe' });
            filter = { types: parsed.types, jobId: parsed.jobId };
            return send({ type: 'subscribed', ...filter });
          case 'ping':
            return send({ type: 'pong' });
        }
      } catch (err) {
        log.error({ err }, 'ws message handling failed');
        send({ type: 'error', code: 'INTERNAL', message: 'Internal error' });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(rateTimer);
      clearInterval(pingTimer);
      cleanup?.();
      if (principal) log.info({ principal: principal.kind }, 'ws disconnected');
    });

    const headerToken = bearer(req);
    if (headerToken) {
      resolve(ctx, headerToken)
        .then((p) => (p ? onAuthenticated(p) : socket.close(WS_CLOSE.UNAUTHORIZED, 'unauthorized')))
        .catch((err) => {
          log.error({ err }, 'ws auth failed');
          socket.close(1011, 'internal error');
        });
    }
  });
}
