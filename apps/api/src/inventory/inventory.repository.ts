import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { UnknownReferenceError } from '../catalog/catalog.repository';
import { PG_POOL } from '../database/database.module';
import {
  toInventoryEvent,
  type InventoryEventRow,
  type NewMovement,
  type RecordedMovement,
} from './inventory.models';

/** The idempotency key was already used for a different movement. */
export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`Idempotency key "${key}" was already used for a different movement`);
    this.name = 'IdempotencyConflictError';
  }
}

const EVENT_COLUMNS =
  'id, organization_id, sku_id, warehouse_id, event_type, quantity_delta, reason, reference, ' +
  'corrects_event_id, created_by, occurred_at, recorded_at, request_hash';

/**
 * SHA-256 of the normalized movement. Two requests with the same key and the
 * same hash are the same movement (a retry); a different hash is a conflict.
 */
export function movementHash(input: NewMovement): string {
  const canonical = JSON.stringify([
    input.skuId,
    input.warehouseId,
    input.type,
    input.quantityDelta,
    input.reason,
    input.reference,
    input.correctsEventId,
    input.occurredAt,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Append-only access to `inventory_events`. Every query is scoped by
 * organization id. There is deliberately no update or delete method: the
 * table rejects both, and mistakes are fixed with correction events.
 */
@Injectable()
export class InventoryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  /**
   * Records a movement once per idempotency key. The insert only happens when
   * the SKU and warehouse are active records of this organization and, for a
   * correction, the corrected event belongs to the same SKU and warehouse.
   * A concurrent retry with the same key is absorbed by ON CONFLICT.
   */
  async recordMovement(
    organizationId: string,
    userId: string,
    idempotencyKey: string,
    input: NewMovement,
  ): Promise<RecordedMovement> {
    const hash = movementHash(input);
    const { rows } = await this.pool.query<InventoryEventRow>(
      `INSERT INTO inventory_events
         (organization_id, sku_id, warehouse_id, event_type, quantity_delta, reason, reference,
          corrects_event_id, idempotency_key, request_hash, created_by, occurred_at)
       SELECT s.organization_id, s.id, w.id, $4::text, $5::integer, $6::text, $7::text,
              $8::uuid, $9::text, $10::text, $11::uuid, coalesce($12::timestamptz, now())
         FROM skus s
         JOIN warehouses w ON w.organization_id = s.organization_id
        WHERE s.organization_id = $1 AND s.id = $2 AND s.archived_at IS NULL
          AND w.id = $3 AND w.archived_at IS NULL
          AND ($8::uuid IS NULL OR EXISTS (
                SELECT 1 FROM inventory_events c
                 WHERE c.organization_id = $1 AND c.id = $8
                   AND c.sku_id = s.id AND c.warehouse_id = w.id))
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING ${EVENT_COLUMNS}`,
      [
        organizationId,
        input.skuId,
        input.warehouseId,
        input.type,
        input.quantityDelta,
        input.reason,
        input.reference,
        input.correctsEventId,
        idempotencyKey,
        hash,
        userId,
        input.occurredAt,
      ],
    );
    if (rows[0]) return { event: toInventoryEvent(rows[0]), replayed: false };

    const existing = await this.findByIdempotencyKey(organizationId, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== hash) throw new IdempotencyConflictError(idempotencyKey);
      return { event: toInventoryEvent(existing), replayed: true };
    }
    throw await this.missingReference(organizationId, input);
  }

  private async findByIdempotencyKey(
    organizationId: string,
    key: string,
  ): Promise<InventoryEventRow | null> {
    const { rows } = await this.pool.query<InventoryEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM inventory_events
        WHERE organization_id = $1 AND idempotency_key = $2`,
      [organizationId, key],
    );
    return rows[0] ?? null;
  }

  /** Works out which reference made the guarded insert skip, for a precise 422. */
  private async missingReference(
    organizationId: string,
    input: NewMovement,
  ): Promise<UnknownReferenceError> {
    const { rows } = await this.pool.query<{ sku: boolean; warehouse: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM skus WHERE organization_id = $1 AND id = $2
                   AND archived_at IS NULL) AS sku,
         EXISTS (SELECT 1 FROM warehouses WHERE organization_id = $1 AND id = $3
                   AND archived_at IS NULL) AS warehouse`,
      [organizationId, input.skuId, input.warehouseId],
    );
    if (!rows[0]?.sku) return new UnknownReferenceError('skuId');
    if (!rows[0]?.warehouse) return new UnknownReferenceError('warehouseId');
    return new UnknownReferenceError('correctsEventId');
  }
}
