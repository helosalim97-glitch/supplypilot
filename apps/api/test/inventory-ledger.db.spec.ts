/**
 * Runs the inventory repository against a real PostgreSQL database, so the
 * idempotency key constraint, the balance trigger and the negative-stock
 * check are exercised for real instead of through a fake pool.
 *
 * Skipped unless TEST_DATABASE_URL is set. Each run migrates into its own
 * throwaway schema and drops it afterwards, so it is safe to point at the
 * local development database:
 *
 *   TEST_DATABASE_URL=postgres://supplypilot:supplypilot_local@localhost:5432/supplypilot \
 *     pnpm --filter @supplypilot/api test:db
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import { UnknownReferenceError } from '../src/catalog/catalog.repository';
import type { NewMovement } from '../src/inventory/inventory.models';
import {
  IdempotencyConflictError,
  InsufficientStockError,
  InventoryRepository,
} from '../src/inventory/inventory.repository';
import { runMigrations } from '../src/migrations/runner';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

interface StockItem {
  organizationId: string;
  userId: string;
  skuId: string;
  warehouseId: string;
}

describeDb('inventory ledger on PostgreSQL', () => {
  const schema = `inventory_test_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let repo: InventoryRepository;
  let organizationId: string;
  let userId: string;
  let sequence = 0;

  const nextCode = (prefix: string) => `${prefix}-${String(++sequence).padStart(4, '0')}`;
  const key = () => `test-${randomUUID()}`;

  async function createOrganization(): Promise<{ organizationId: string; userId: string }> {
    const slug = nextCode('org').toLowerCase();
    const org = await pool.query<{ id: string }>(
      'INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id',
      [slug, `Synthetic ${slug}`],
    );
    const user = await pool.query<{ id: string }>(
      'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
      [`${slug}-manager@example.test`, 'Synthetic manager'],
    );
    await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'manager')`,
      [org.rows[0].id, user.rows[0].id],
    );
    return { organizationId: org.rows[0].id, userId: user.rows[0].id };
  }

  /** A fresh SKU and warehouse, so every test starts from an empty balance. */
  async function stockItem(
    owner = { organizationId, userId },
  ): Promise<StockItem> {
    const sku = await pool.query<{ id: string }>(
      `INSERT INTO skus (organization_id, code, name, unit, unit_cost_cents)
       VALUES ($1, $2, 'Corrugated box, small', 'each', 85) RETURNING id`,
      [owner.organizationId, nextCode('SKU')],
    );
    const warehouse = await pool.query<{ id: string }>(
      `INSERT INTO warehouses (organization_id, code, name)
       VALUES ($1, $2, 'Main warehouse') RETURNING id`,
      [owner.organizationId, nextCode('WH')],
    );
    return { ...owner, skuId: sku.rows[0].id, warehouseId: warehouse.rows[0].id };
  }

  function movement(
    item: StockItem,
    type: NewMovement['type'],
    quantityDelta: number,
    extra: Partial<NewMovement> = {},
  ): NewMovement {
    return {
      skuId: item.skuId,
      warehouseId: item.warehouseId,
      type,
      quantityDelta,
      reason: type === 'adjustment' ? 'cycle count' : null,
      reference: null,
      correctsEventId: null,
      occurredAt: null,
      ...extra,
    };
  }

  const record = (item: StockItem, idempotencyKey: string, input: NewMovement) =>
    repo.recordMovement(item.organizationId, item.userId, idempotencyKey, input);

  async function onHand(item: StockItem): Promise<number | null> {
    const { rows } = await pool.query<{ on_hand: number }>(
      `SELECT on_hand FROM stock_balances
        WHERE organization_id = $1 AND sku_id = $2 AND warehouse_id = $3`,
      [item.organizationId, item.skuId, item.warehouseId],
    );
    return rows[0]?.on_hand ?? null;
  }

  async function eventCount(item: StockItem): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory_events
        WHERE organization_id = $1 AND sku_id = $2 AND warehouse_id = $3`,
      [item.organizationId, item.skuId, item.warehouseId],
    );
    return rows[0].count;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations(pool, join(__dirname, '..', 'migrations'));
    repo = new InventoryRepository(pool);
    ({ organizationId, userId } = await createOrganization());
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  describe('idempotent movements', () => {
    it('records a retried request once and replays the original event', async () => {
      const item = await stockItem();
      const receipt = movement(item, 'receipt', 24, { reference: 'PO-1001' });
      const k = key();

      const first = await record(item, k, receipt);
      const retry = await record(item, k, receipt);

      expect(first.replayed).toBe(false);
      expect(retry).toEqual({ replayed: true, event: first.event });
      expect(await eventCount(item)).toBe(1);
      expect(await onHand(item)).toBe(24);
    });

    it('rejects a key reused for a different movement and changes nothing', async () => {
      const item = await stockItem();
      const k = key();
      await record(item, k, movement(item, 'receipt', 24));

      await expect(record(item, k, movement(item, 'receipt', 12))).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
      expect(await eventCount(item)).toBe(1);
      expect(await onHand(item)).toBe(24);
    });

    it('records concurrent retries of the same key exactly once', async () => {
      const item = await stockItem();
      const receipt = movement(item, 'receipt', 10);
      const k = key();

      const results = await Promise.all(
        Array.from({ length: 8 }, () => record(item, k, receipt)),
      );

      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
      expect(await eventCount(item)).toBe(1);
      expect(await onHand(item)).toBe(10);
    });

    it('scopes keys to the organization', async () => {
      const other = await stockItem(await createOrganization());
      const mine = await stockItem();
      const k = key();

      const a = await record(mine, k, movement(mine, 'receipt', 5));
      const b = await record(other, k, movement(other, 'receipt', 7));

      expect(b.replayed).toBe(false);
      expect(b.event.id).not.toBe(a.event.id);
      expect(await onHand(mine)).toBe(5);
      expect(await onHand(other)).toBe(7);
    });

    it('does not record a movement for an SKU of another organization', async () => {
      const other = await stockItem(await createOrganization());
      const mine = await stockItem();
      const input = movement(mine, 'receipt', 5, { skuId: other.skuId });

      await expect(record(mine, key(), input)).rejects.toEqual(
        new UnknownReferenceError('skuId'),
      );
      expect(await eventCount(other)).toBe(0);
    });
  });

  describe('negative-stock rule', () => {
    it('lets an issue take stock exactly to zero', async () => {
      const item = await stockItem();
      await record(item, key(), movement(item, 'receipt', 24));

      await record(item, key(), movement(item, 'issue', -24));

      expect(await onHand(item)).toBe(0);
    });

    it('rejects an issue larger than on-hand stock and records nothing', async () => {
      const item = await stockItem();
      await record(item, key(), movement(item, 'receipt', 24));

      const error = await record(item, key(), movement(item, 'issue', -25)).catch((e) => e);

      expect(error).toBeInstanceOf(InsufficientStockError);
      expect(error).toMatchObject({ onHand: 24, quantityDelta: -25 });
      expect(await eventCount(item)).toBe(1);
      expect(await onHand(item)).toBe(24);
    });

    it('rejects an issue for a SKU never stocked in the warehouse', async () => {
      const item = await stockItem();

      await expect(record(item, key(), movement(item, 'issue', -1))).rejects.toMatchObject({
        name: 'InsufficientStockError',
        onHand: 0,
      });
      expect(await eventCount(item)).toBe(0);
      expect(await onHand(item)).toBeNull();
    });

    it('applies the rule to negative adjustments and corrections', async () => {
      const item = await stockItem();
      const receipt = await record(item, key(), movement(item, 'receipt', 10));
      await record(item, key(), movement(item, 'issue', -4));

      await expect(
        record(item, key(), movement(item, 'adjustment', -7)),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      // Reversing the whole receipt would leave -4 on hand.
      await expect(
        record(
          item,
          key(),
          movement(item, 'correction', -10, { correctsEventId: receipt.event.id }),
        ),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      await record(item, key(), movement(item, 'adjustment', -6));
      expect(await onHand(item)).toBe(0);
    });

    it('does not burn the idempotency key of a rejected movement', async () => {
      const item = await stockItem();
      await record(item, key(), movement(item, 'receipt', 3));
      const k = key();

      await expect(record(item, k, movement(item, 'issue', -5))).rejects.toBeInstanceOf(
        InsufficientStockError,
      );
      const retry = await record(item, k, movement(item, 'issue', -3));

      expect(retry.replayed).toBe(false);
      expect(await onHand(item)).toBe(0);
    });

    it('never lets concurrent issues spend the same stock', async () => {
      const item = await stockItem();
      await record(item, key(), movement(item, 'receipt', 10));

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => record(item, key(), movement(item, 'issue', -3))),
      );

      const rejected = results.filter((r) => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(rejected).toHaveLength(3);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockError);
      }
      expect(await onHand(item)).toBe(1);
      expect(await eventCount(item)).toBe(4);
    });
  });

  describe('ledger integrity', () => {
    it('refuses to update or delete recorded events', async () => {
      const item = await stockItem();
      const { event } = await record(item, key(), movement(item, 'receipt', 2));

      await expect(
        pool.query('UPDATE inventory_events SET quantity_delta = 200 WHERE id = $1', [event.id]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        pool.query('DELETE FROM inventory_events WHERE id = $1', [event.id]),
      ).rejects.toMatchObject({ code: '55000' });
      expect(await onHand(item)).toBe(2);
    });

    it('keeps every balance equal to the sum of its events', async () => {
      const { rows } = await pool.query('SELECT * FROM stock_balance_drift');
      expect(rows).toEqual([]);
    });
  });
});
