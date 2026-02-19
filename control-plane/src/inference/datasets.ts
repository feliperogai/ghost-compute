// Datasets: images uploaded by an owner, immutable once sealed.
import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { Role } from '../auth/plugin.js';
import { MAX_DATASET_BYTES, MAX_DATASET_IMAGES, MAX_IMAGE_BYTES } from './schemas.js';

export interface Actor {
  userId: string;
  role: Role;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toDto(r: Record<string, any>) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    status: r.status,
    imageCount: r.image_count,
    totalBytes: Number(r.total_bytes),
    createdAt: iso(r.created_at),
    sealedAt: iso(r.sealed_at),
  };
}

/** Content sniffing: the declared type must match the bytes. Only PNG and JPEG. */
export function sniff(data: Buffer): 'image/png' | 'image/jpeg' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return null;
}

export class DatasetService {
  constructor(private readonly ctx: AppContext) {}

  async create(name: string, ownerId: string) {
    const { rows } = await this.ctx.db.query(`INSERT INTO datasets (owner_id, name) VALUES ($1, $2) RETURNING *`, [
      ownerId,
      name,
    ]);
    return toDto(rows[0]);
  }

  async get(id: string, actor: Actor) {
    const { rows } = await this.ctx.db.query(`SELECT * FROM datasets WHERE id = $1`, [id]);
    const d = rows[0];
    if (!d || (d.owner_id !== actor.userId && actor.role !== 'admin')) throw notFound('Dataset');
    return toDto(d);
  }

  async list(ownerId: string) {
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM datasets WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [ownerId],
    );
    return { items: rows.map(toDto) };
  }

  async addImage(id: string, actor: Actor, declared: string, data: Buffer, name: string | null) {
    if (data.length === 0) throw badRequest('Empty image');
    if (data.length > MAX_IMAGE_BYTES) throw new AppError(413, 'TOO_LARGE', `Images are limited to ${MAX_IMAGE_BYTES} bytes`);
    const kind = sniff(data);
    if (!kind || kind !== declared) throw new AppError(415, 'UNSUPPORTED_MEDIA', 'Only PNG and JPEG images, with a matching content type');
    const sha256 = createHash('sha256').update(data).digest('hex');
    return withTx(this.ctx.db, async (c) => {
      const d = (await c.query(`SELECT * FROM datasets WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!d || d.owner_id !== actor.userId) throw notFound('Dataset');
      if (d.status !== 'OPEN') throw conflict('Dataset is sealed');
      if (d.image_count >= MAX_DATASET_IMAGES) throw conflict(`Datasets hold at most ${MAX_DATASET_IMAGES} images`);
      if (Number(d.total_bytes) + data.length > MAX_DATASET_BYTES) throw conflict('Dataset size limit reached');
      const index: number = d.image_count;
      await c.query(
        `INSERT INTO dataset_images (dataset_id, idx, name, content_type, size, sha256, data) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, index, name, kind, data.length, sha256, data],
      );
      await c.query(`UPDATE datasets SET image_count = image_count + 1, total_bytes = total_bytes + $2 WHERE id = $1`, [
        id,
        data.length,
      ]);
      return { index, name, contentType: kind, size: data.length, sha256 };
    });
  }

  async seal(id: string, actor: Actor) {
    const { rows } = await this.ctx.db.query(
      `UPDATE datasets SET status = 'SEALED', sealed_at = now()
        WHERE id = $1 AND owner_id = $2 AND status = 'OPEN' AND image_count > 0 RETURNING *`,
      [id, actor.userId],
    );
    if (rows[0]) return toDto(rows[0]);
    const d = await this.get(id, actor);
    if (d.ownerId !== actor.userId) throw forbidden('Only the owner can seal a dataset');
    if (d.status === 'SEALED') throw conflict('Dataset is already sealed');
    throw conflict('Dataset has no images');
  }
}
