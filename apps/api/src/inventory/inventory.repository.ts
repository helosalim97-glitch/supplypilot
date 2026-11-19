import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { UnknownReferenceError } from '../catalog/catalog.repository';
import { PG_POOL } from '../database/database.module';
import {
  toInventoryEvent,
  toStockBalance,
  type BalanceQuery,
  type InventoryEventRow,
  type NewMovement,
  type RecordedMovement,
  type StockBalance,
  type StockBalanceRow,
} from './inventory.models';

/** The idempotency key was already used for a different movement. */
export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`Idempotency key "${key}" was already used for a different movement`);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * The movement would take on-hand stock below zero (negative-stock rule,
 * `stock_balances_on_hand_non_negative`). Nothing was recorded.
 */
export class InsufficientStockError extends Error {
  constructor(
    readonly onHand: number,
    readonly quantityDelta: number,
  ) {
    super(`Movement of ${quantityDelta} would take on-hand stock of ${onHand} below zero`);
    this.name = 'InsufficientStockError';
  }
}

/** The movement would push on-hand stock past the largest storable quantity. */
export class StockOverflowError extends Error {
  constructor() {
    super('Movement would push on-hand stock past the largest storable quantity');
    this.name = 'StockOverflowError';
  }
}

const NEGATIVE_STOCK_CONSTRAINT = 'stock_balances_on_hand_non_negative';
/** PostgreSQL SQLSTATE codes raised by the balance trigger. */
const CHECK_VIOLATION = '23514';
const NUMERIC_VALUE_OUT_OF_RANGE = '22003';

function pgError(error: unknown): { code?: string; constraint?: string } {
  return typeof error === 'object' && error !== null
    ? (error as { code?: string; constraint?: string })
    : {};
}

const EVENT_COLUMNS =
  'id, organization_id, sku_id, warehouse_id, event_type, quantity_delta, reason, reference, ' +
  'corrects_event_id, created_by, occurred_at, recorded_at, request_hash';

/**
 * Appends one event, but only for active records of the organization and, for
 * a correction, an event of the same SKU and warehouse. A key that already
 * exists makes it a no-op (ON CONFLICT), which the caller turns into a replay.
 */
const INSERT_EVENT_SQL = `INSERT INTO inventory_events
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
   RETURNING ${EVENT_COLUMNS}`;

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
 * Append-only access to `inventory_events`, plus reads of the `stock_balances`
 * projection the database keeps in step with it. Every query is scoped by
 * organization id. There is deliberately no update or delete method: the
 * ledger rejects both, and mistakes are fixed with correction events.
 */
@Injectable()
export class InventoryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  /**
   * Records a movement once per idempotency key. The insert only happens when
   * the SKU and warehouse are active records of this organization and, for a
   * correction, the corrected event belongs to the same SKU and warehouse.
   * A concurrent retry with the same key is absorbed by ON CONFLICT. A
   * movement that would take stock below zero throws InsufficientStockError.
   */
  async recordMovement(
    organizationId: string,
    userId: string,
    idempotencyKey: string,
    input: NewMovement,
  ): Promise<RecordedMovement> {
    const hash = movementHash(input);
    const rows = await this.insertEvent(organizationId, input, () =>
      this.pool.query<InventoryEventRow>(INSERT_EVENT_SQL, [
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
      ]),
    );
    if (rows[0]) return { event: toInventoryEvent(rows[0]), replayed: false };

    const existing = await this.findByIdempotencyKey(organizationId, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== hash) throw new IdempotencyConflictError(idempotencyKey);
      return { event: toInventoryEvent(existing), replayed: true };
    }
    throw await this.missingReference(organizationId, input);
  }

  /**
   * Current balances with SKU and warehouse details, ordered by SKU code then
   * warehouse code. Archived SKUs and warehouses are left out. Fetches one row
   * more than `limit` to tell whether another page exists.
   */
  async listBalances(
    organizationId: string,
    query: BalanceQuery,
  ): Promise<{ balances: StockBalance[]; hasMore: boolean }> {
    const { rows } = await this.pool.query<StockBalanceRow>(
      `SELECT b.sku_id, s.code AS sku_code, s.name AS sku_name, s.unit,
              b.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              b.on_hand, s.reorder_point, b.event_count, b.last_event_id,
              b.last_occurred_at, b.updated_at
         FROM stock_balances b
         JOIN skus s ON s.organization_id = b.organization_id AND s.id = b.sku_id
         JOIN warehouses w ON w.organization_id = b.organization_id AND w.id = b.warehouse_id
        WHERE b.organization_id = $1
          AND s.archived_at IS NULL AND w.archived_at IS NULL
          AND ($2::uuid IS NULL OR b.sku_id = $2)
          AND ($3::uuid IS NULL OR b.warehouse_id = $3)
        ORDER BY s.code, w.code
        LIMIT $4 OFFSET $5`,
      [organizationId, query.skuId, query.warehouseId, query.limit + 1, query.offset],
    );
    return {
      balances: rows.slice(0, query.limit).map(toStockBalance),
      hasMore: rows.length > query.limit,
    };
  }

  /**
   * Runs the event INSERT. The balance trigger fires inside it, so a movement
   * that breaks the negative-stock rule fails here and leaves no event behind.
   */
  private async insertEvent<T>(
    organizationId: string,
    input: NewMovement,
    insert: () => Promise<{ rows: T[] }>,
  ): Promise<T[]> {
    try {
      return (await insert()).rows;
    } catch (error) {
      const { code, constraint } = pgError(error);
      if (code === CHECK_VIOLATION && constraint === NEGATIVE_STOCK_CONSTRAINT) {
        const onHand = await this.onHand(organizationId, input);
        throw new InsufficientStockError(onHand, input.quantityDelta);
      }
      if (code === NUMERIC_VALUE_OUT_OF_RANGE) throw new StockOverflowError();
      throw error;
    }
  }

  private async onHand(organizationId: string, input: NewMovement): Promise<number> {
    const { rows } = await this.pool.query<{ on_hand: number }>(
      `SELECT on_hand FROM stock_balances
        WHERE organization_id = $1 AND sku_id = $2 AND warehouse_id = $3`,
      [organizationId, input.skuId, input.warehouseId],
    );
    return rows[0]?.on_hand ?? 0;
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
