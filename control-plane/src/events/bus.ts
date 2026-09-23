import { EventEmitter } from 'node:events';
import type { Redis } from '../redis/client.js';

export const BROADCAST_CHANNEL = 'ghost:events';
const WORKER_CHANNEL_PREFIX = 'ghost:worker:';

/** Event visible to dashboard users. */
export interface PlatformEvent {
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

/** Message addressed to a single worker. */
export type WorkerMessage =
  | { type: 'job.assigned'; assignment: Record<string, unknown> }
  | { type: 'assignment.cancel'; assignmentId: string; reason: string }
  | { type: 'worker.revoked'; reason: string };

/**
 * Fan-out through Redis so every control-plane instance sees every event.
 * Local listeners (WebSocket connections) subscribe via on().
 */
export class EventBus {
  private readonly local = new EventEmitter();

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    this.local.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.sub.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
    this.sub.on('pmessage', (_p: string, channel: string, raw: string) => this.dispatch(channel, raw));
    await this.sub.subscribe(BROADCAST_CHANNEL);
    await this.sub.psubscribe(`${WORKER_CHANNEL_PREFIX}*`);
  }

  private dispatch(channel: string, raw: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (channel === BROADCAST_CHANNEL) this.local.emit('broadcast', msg);
    else if (channel.startsWith(WORKER_CHANNEL_PREFIX))
      this.local.emit(`worker:${channel.slice(WORKER_CHANNEL_PREFIX.length)}`, msg);
  }

  async publish(type: string, data: Record<string, unknown>): Promise<void> {
    const event: PlatformEvent = { type, ts: new Date().toISOString(), data };
    await this.pub.publish(BROADCAST_CHANNEL, JSON.stringify(event));
  }

  async sendToWorker(workerId: string, msg: WorkerMessage): Promise<void> {
    await this.pub.publish(WORKER_CHANNEL_PREFIX + workerId, JSON.stringify(msg));
  }

  onBroadcast(fn: (e: PlatformEvent) => void): () => void {
    this.local.on('broadcast', fn);
    return () => this.local.off('broadcast', fn);
  }

  onWorker(workerId: string, fn: (m: WorkerMessage) => void): () => void {
    const key = `worker:${workerId}`;
    this.local.on(key, fn);
    return () => this.local.off(key, fn);
  }
}
