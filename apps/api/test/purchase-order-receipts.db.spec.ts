/**
 * Receiving against real PostgreSQL: receipts, the ledger events they write,
 * stock balances, the order's status, the over-receipt CHECK from migration
 * 0011 and idempotent retries.
 *
 * Skipped unless TEST_DATABASE_URL is set; migrates into a throwaway schema
 * (see inventory-ledger.db.spec.ts).
 */
import { join } from 'node:path';
import { Pool } from 'pg';
import type { Role } from '../src/auth/roles';
import { IdempotencyConflictError } from '../src/inventory/inventory.repository';
import { runMigrations } from '../src/migrations/runner';
import type { NewReceipt, PurchaseOrder } from '../src/purchasing/purchasing.models';
import { PurchasingRepository } from '../src/purchasing/purchasing.repository';
import { OverReceiptError, PurchaseOrderNotReceivableError } from '../src/purchasing/receiving';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

describeDb('receiving purchase orders on PostgreSQL', () => {
  const schema = `receiving_test_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let repo: PurchasingRepository;
  let organizationId: string;
  const users: Record<'buyer' | 'manager', string> = { buyer: '', manager: '' };
  let supplierId: string;
  let warehouseId: string;
  const skus: Record<'box' | 'tape', string> = { box: '', tape: '' };
  let keySeq = 0;
  const nextKey = () => `delivery-${process.pid}-${++keySeq}`;

  async function insertId(sql: string, values: unknown[]): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(sql, values);
    return rows[0].id;
  }

  const act = (orderId: string, action: 'submit' | 'approve', as: 'buyer' | 'manager') =>
    repo.transition(organizationId, orderId, {
      action,
      actorId: users[as],
      actorRole: as as Role,
      reason: null,
    });

  /** An approved order: 400 boxes and 24 rolls of tape. */
  async function approvedOrder(): Promise<PurchaseOrder> {
    const draft = await repo.createOrder(organizationId, users.buyer, {
      supplierId,
      warehouseId,
      expectedOn: null,
      notes: null,
      lines: [
        { skuId: skus.box, quantity: 400, unitCostCents: null },
        { skuId: skus.tape, quantity: 24, unitCostCents: 225 },
      ],
    });
    await act(draft.id, 'submit', 'buyer');
    return (await act(draft.id, 'approve', 'manager')) as PurchaseOrder;
  }

  const receive = (order: PurchaseOrder, input: Partial<NewReceipt>, key = nextKey()) =>
    repo.receive(organizationId, order.id, users.buyer, key, {
      lines: [],
      reference: null,
      notes: null,
      receivedAt: null,
      ...input,
    });

  async function onHand(skuId: string): Promise<number> {
    const { rows } = await pool.query<{ on_hand: number }>(
      `SELECT on_hand FROM stock_balances
        WHERE organization_id = $1 AND sku_id = $2 AND warehouse_id = $3`,
      [organizationId, skuId, warehouseId],
    );
    return rows[0]?.on_hand ?? 0;
  }

  async function count(table: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations(pool, join(__dirname, '..', 'migrations'));
    repo = new PurchasingRepository(pool);

    organizationId = await insertId(
      `INSERT INTO organizations (slug, name) VALUES ('north-trading', 'North Trading') RETURNING id`,
      [],
    );
    for (const role of ['buyer', 'manager'] as const) {
      users[role] = await insertId(
        'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
        [`${role}@north.example.test`, `Synthetic ${role}`],
      );
      await pool.query(
        'INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)',
        [organizationId, users[role], role],
      );
    }
    supplierId = await insertId(
      `INSERT INTO suppliers (organization_id, code, name)
       VALUES ($1, 'ACME', 'Acme Packaging') RETURNING id`,
      [organizationId],
    );
    warehouseId = await insertId(
      `INSERT INTO warehouses (organization_id, code, name)
       VALUES ($1, 'WH1', 'Main warehouse') RETURNING id`,
      [organizationId],
    );
    skus.box = await insertId(
      `INSERT INTO skus (organization_id, code, name, unit, unit_cost_cents)
       VALUES ($1, 'BOX-S', 'Corrugated box, small', 'each', 85) RETURNING id`,
      [organizationId],
    );
    skus.tape = await insertId(
      `INSERT INTO skus (organization_id, code, name, unit, unit_cost_cents)
       VALUES ($1, 'TAPE-48', 'Packing tape 48 mm', 'roll', 210) RETURNING id`,
      [organizationId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('receives a partial shipment, then the rest, and books both into stock', async () => {
    const order = await approvedOrder();
    const [box, tape] = order.lines;
    const boxesBefore = await onHand(skus.box);
    const tapeBefore = await onHand(skus.tape);

    const first = await receive(order, {
      lines: [{ lineId: box.id, quantity: 250 }],
      reference: 'DN-7781',
      receivedAt: '2026-11-24T08:15:00.000Z',
    });
    expect(first?.replayed).toBe(false);
    expect(first?.order).toMatchObject({ status: 'partially_received', totalUnitsReceived: 250 });
    expect(first?.order.lines.map((l) => [l.quantityReceived, l.quantityOutstanding])).toEqual([
      [250, 150],
      [0, 24],
    ]);
    expect(first?.receipt).toMatchObject({
      reference: 'DN-7781',
      receivedBy: users.buyer,
      receivedAt: '2026-11-24T08:15:00.000Z',
      lines: [{ purchaseOrderLineId: box.id, lineNumber: 1, skuCode: 'BOX-S', quantity: 250 }],
    });
    expect(await onHand(skus.box)).toBe(boxesBefore + 250);

    const event = await pool.query(
      `SELECT event_type, quantity_delta, reference, warehouse_id, occurred_at
         FROM inventory_events WHERE organization_id = $1 AND id = $2`,
      [organizationId, first?.receipt.lines[0].inventoryEventId],
    );
    expect(event.rows[0]).toMatchObject({
      event_type: 'receipt',
      quantity_delta: 250,
      reference: order.number,
      warehouse_id: warehouseId,
      occurred_at: new Date('2026-11-24T08:15:00.000Z'),
    });

    const second = await receive(order, {
      lines: [
        { lineId: tape.id, quantity: 24 },
        { lineId: box.id, quantity: 150 },
      ],
    });
    expect(second?.order).toMatchObject({ status: 'received', totalUnitsReceived: 424 });
    expect(await onHand(skus.box)).toBe(boxesBefore + 400);
    expect(await onHand(skus.tape)).toBe(tapeBefore + 24);

    const receipts = await repo.listReceipts(organizationId, order.id);
    expect(receipts?.map((r) => r.lines.map((l) => [l.lineNumber, l.quantity]))).toEqual([
      [[1, 250]],
      [
        [1, 150],
        [2, 24],
      ],
    ]);

    const events = await repo.listEvents(organizationId, order.id);
    expect(
      events
        ?.filter((e) => e.action === 'purchase_order.goods_received')
        .map((e) => [e.fromStatus, e.toStatus, e.details.unitsReceived]),
    ).toEqual([
      ['approved', 'partially_received', 250],
      ['partially_received', 'received', 174],
    ]);

    await expect(receive(order, { lines: [{ lineId: box.id, quantity: 1 }] })).rejects.toThrow(
      PurchaseOrderNotReceivableError,
    );
  });

  it('adds stock once for a retried delivery, even when the retries race', async () => {
    const order = await approvedOrder();
    const before = await onHand(skus.box);
    const receiptsBefore = await count('purchase_order_receipts');
    const key = nextKey();
    const input = { lines: [{ lineId: order.lines[0].id, quantity: 100 }] };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => receive(order, input, key)),
    );
    expect(results.filter((r) => !r?.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r?.receipt.id)).size).toBe(1);
    expect(await onHand(skus.box)).toBe(before + 100);
    expect(await count('purchase_order_receipts')).toBe(receiptsBefore + 1);

    // A retry after the order moved on still replays the original receipt.
    await receive(order, {
      lines: [
        { lineId: order.lines[0].id, quantity: 300 },
        { lineId: order.lines[1].id, quantity: 24 },
      ],
    });
    const late = await receive(order, input, key);
    expect(late).toMatchObject({ replayed: true, order: { status: 'received' } });
    expect(await onHand(skus.box)).toBe(before + 400);
  });

  it('refuses a key reused for another delivery or another order', async () => {
    const order = await approvedOrder();
    const other = await approvedOrder();
    const key = nextKey();
    await receive(order, { lines: [{ lineId: order.lines[0].id, quantity: 10 }] }, key);

    await expect(
      receive(order, { lines: [{ lineId: order.lines[0].id, quantity: 11 }] }, key),
    ).rejects.toThrow(IdempotencyConflictError);
    await expect(
      receive(other, { lines: [{ lineId: other.lines[0].id, quantity: 10 }] }, key),
    ).rejects.toThrow(IdempotencyConflictError);
    expect((await repo.findOrder(organizationId, other.id))?.status).toBe('approved');
  });

  it('never receives more than ordered, also when two deliveries race', async () => {
    const order = await approvedOrder();
    const before = await onHand(skus.box);
    const receiptsBefore = await count('purchase_order_receipts');

    await expect(
      receive(order, {
        lines: [
          { lineId: order.lines[0].id, quantity: 10 },
          { lineId: order.lines[1].id, quantity: 25 },
        ],
      }),
    ).rejects.toThrow(OverReceiptError);
    expect(await onHand(skus.box)).toBe(before);
    expect(await count('purchase_order_receipts')).toBe(receiptsBefore);

    const racing = await Promise.allSettled([
      receive(order, { lines: [{ lineId: order.lines[0].id, quantity: 300 }] }),
      receive(order, { lines: [{ lineId: order.lines[0].id, quantity: 300 }] }),
    ]);
    expect(racing.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = racing.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(OverReceiptError);
    expect(rejected.reason).toMatchObject({ outstanding: 100 });
    expect(await onHand(skus.box)).toBe(before + 300);
  });

  it('refuses deliveries before approval', async () => {
    const draft = await repo.createOrder(organizationId, users.buyer, {
      supplierId,
      warehouseId,
      expectedOn: null,
      notes: null,
      lines: [{ skuId: skus.box, quantity: 5, unitCostCents: null }],
    });
    await expect(
      receive(draft, { lines: [{ lineId: draft.lines[0].id, quantity: 5 }] }),
    ).rejects.toThrow(PurchaseOrderNotReceivableError);
    await act(draft.id, 'submit', 'buyer');
    await expect(
      receive(draft, { lines: [{ lineId: draft.lines[0].id, quantity: 5 }] }),
    ).rejects.toThrow(PurchaseOrderNotReceivableError);
  });

  it('backs the rules up in the database', async () => {
    const order = await approvedOrder();
    const done = await receive(order, { lines: [{ lineId: order.lines[1].id, quantity: 4 }] });

    await expect(
      pool.query(
        'UPDATE purchase_order_lines SET quantity_received = quantity_ordered + 1 WHERE id = $1',
        [order.lines[1].id],
      ),
    ).rejects.toMatchObject({ constraint: 'purchase_order_lines_received_within_ordered' });
    await expect(
      pool.query('UPDATE purchase_order_receipts SET reference = $2 WHERE id = $1', [
        done?.receipt.id,
        'DN-edited',
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM purchase_order_receipt_lines WHERE receipt_id = $1', [
        done?.receipt.id,
      ]),
    ).rejects.toThrow(/append-only/);
    // Ordered quantities stay frozen after approval, received totals don't.
    await expect(
      pool.query('UPDATE purchase_order_lines SET quantity_ordered = 30 WHERE id = $1', [
        order.lines[1].id,
      ]),
    ).rejects.toThrow(/only change while the order is a draft/);
  });
});
