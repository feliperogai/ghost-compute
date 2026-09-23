import type { DbClient } from './db/pool.js';

export interface AuditEntry {
  actorType: 'user' | 'worker' | 'system';
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export async function audit(db: DbClient, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.actorType, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.details ?? {}],
  );
}
