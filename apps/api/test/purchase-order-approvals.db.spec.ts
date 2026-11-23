/**
 * Runs the purchase order approval flow against a real PostgreSQL database,
 * so the status-transition trigger, the four-eyes check constraint and the
 * append-only audit trail from migration 0009 are exercised for real.
 *
 * Skipped unless TEST_DATABASE_URL is set; migrates into a throwaway schema
 * (see inventory-ledger.db.spec.ts).
 */
import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrations/runner';
import type { Role } from '../src/auth/roles';
import { PurchasingRepository } from '../src/purchasing/purchasing.repository';
import {
  InvalidTransitionError,
  SelfDecisionError,
  type PurchaseOrderAction,
} from '../src/purchasing/purchasing.state-machine';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

describeDb('purchase order approvals on PostgreSQL', () => {
  const schema = `purchasing_test_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let repo: PurchasingRepository;
  let organizationId: string;
  const users: Record<'buyer' | 'manager', string> = { buyer: '', manager: '' };
  let supplierId: string;
  let warehouseId: string;
  let skuId: string;

  async function insertId(sql: string, values: unknown[]): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(sql, values);
    return rows[0].id;
  }

  const draft = () =>
    repo.createOrder(organizationId, users.buyer, {
      supplierId,
      warehouseId,
      expectedOn: '2026-12-04',
      notes: null,
      lines: [{ skuId, quantity: 400, unitCostCents: null }],
    });

  const act = (
    orderId: string,
    action: PurchaseOrderAction,
    as: 'buyer' | 'manager',
    reason: string | null = null,
  ) =>
    repo.transition(organizationId, orderId, {
      action,
      actorId: users[as],
      actorRole: as as Role,
      reason,
    });

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
    skuId = await insertId(
      `INSERT INTO skus (organization_id, code, name, unit, unit_cost_cents)
       VALUES ($1, 'BOX-S', 'Corrugated box, small', 'each', 85) RETURNING id`,
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

  it('approves a submitted order and keeps the full trail', async () => {
    const order = await draft();
    await act(order.id, 'submit', 'buyer');
    const approved = await act(order.id, 'approve', 'manager', 'Covers December demand');

    expect(approved).toMatchObject({
      status: 'approved',
      submittedBy: users.buyer,
      decidedBy: users.manager,
      decisionReason: 'Covers December demand',
    });
    expect(approved?.submittedAt).toEqual(expect.any(String));

    const events = await repo.listEvents(organizationId, order.id);
    expect(events?.map((e) => [e.action, e.fromStatus, e.toStatus])).toEqual([
      ['purchase_order.created', null, null],
      ['purchase_order.submitted', 'draft', 'submitted'],
      ['purchase_order.approved', 'submitted', 'approved'],
    ]);
    expect(events?.[2]).toMatchObject({
      actorId: users.manager,
      reason: 'Covers December demand',
      details: { number: order.number, lineCount: 1, totalCents: 34_000 },
    });
  });

  it('reopens a rejected order, clears the old decision and allows edits again', async () => {
    const order = await draft();
    await act(order.id, 'submit', 'buyer');
    await act(order.id, 'reject', 'manager', 'Quantity above forecast');
    const reopened = await act(order.id, 'reopen', 'buyer');
    expect(reopened).toMatchObject({ status: 'draft', submittedBy: null, decidedBy: null });

    await repo.replaceLines(
      organizationId,
      order.id,
      [{ skuId, quantity: 250, unitCostCents: null }],
      users.buyer,
    );
    // The manager who rejected it resubmits; the buyer can now decide on it.
    await act(order.id, 'submit', 'manager');
    await expect(act(order.id, 'approve', 'manager')).rejects.toBeInstanceOf(SelfDecisionError);

    const events = await repo.listEvents(organizationId, order.id);
    expect(events?.map((e) => e.action)).toEqual([
      'purchase_order.created',
      'purchase_order.submitted',
      'purchase_order.rejected',
      'purchase_order.reopened',
      'purchase_order.lines_replaced',
      'purchase_order.submitted',
    ]);
  });

  it('serializes two managers deciding at once: one wins, the other is refused', async () => {
    const order = await draft();
    await act(order.id, 'submit', 'buyer');
    const results = await Promise.allSettled([
      act(order.id, 'approve', 'manager'),
      act(order.id, 'reject', 'manager', 'Too late'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(InvalidTransitionError);

    const events = await repo.listEvents(organizationId, order.id);
    expect(events).toHaveLength(3);
  });

  it('refuses status changes outside the state machine at the database', async () => {
    const order = await draft();
    await expect(
      pool.query(`UPDATE purchase_orders SET status = 'approved' WHERE id = $1`, [order.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query(`UPDATE purchase_orders SET status = 'received' WHERE id = $1`, [order.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('refuses a decision by the submitter at the database', async () => {
    const order = await draft();
    await act(order.id, 'submit', 'buyer');
    await expect(
      pool.query(
        `UPDATE purchase_orders SET status = 'approved', decided_by = submitted_by,
                decided_at = now() WHERE id = $1`,
        [order.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'purchase_orders_no_self_decision' });
  });

  it('keeps the audit trail append-only', async () => {
    const order = await draft();
    await expect(
      pool.query(`UPDATE audit_events SET reason = 'edited' WHERE entity_id = $1`, [order.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query('DELETE FROM audit_events WHERE entity_id = $1', [order.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '55000' });
  });

  it('returns null for unknown orders', async () => {
    const unknown = '6c1f2d3e-0000-4000-8000-0000000000ff';
    expect(await act(unknown, 'submit', 'buyer')).toBeNull();
    expect(await repo.listEvents(organizationId, unknown)).toBeNull();
  });
});
