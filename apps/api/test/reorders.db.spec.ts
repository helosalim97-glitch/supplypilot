/**
 * Runs reorder runs and decisions against a real PostgreSQL database, so the
 * constraints and the guard trigger from migration 0012, the one-open-proposal
 * index and the row locks are exercised for real.
 *
 * Skipped unless TEST_DATABASE_URL is set; migrates into a throwaway schema
 * (see inventory-ledger.db.spec.ts).
 */
import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrations/runner';
import { PurchasingRepository } from '../src/purchasing/purchasing.repository';
import type { ReorderCandidate, WorkerCandidates } from '../src/reorders/reorders.models';
import {
  ProposalNotPendingError,
  ProposalOutdatedError,
  ReordersRepository,
} from '../src/reorders/reorders.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

describeDb('reorder proposals on PostgreSQL', () => {
  const schema = `reorders_test_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let repo: ReordersRepository;
  let purchasing: PurchasingRepository;
  let organizationId: string;
  let otherOrganizationId: string;
  let manager: string;
  let otherManager: string;
  let supplierId: string;
  let warehouseId: string;
  const skus: string[] = [];

  async function insertId(sql: string, values: unknown[]): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(sql, values);
    return rows[0].id;
  }

  const candidate = (sku: string, overrides: Partial<ReorderCandidate> = {}): ReorderCandidate => ({
    skuId: sku,
    warehouseId,
    supplierId,
    suggestedQty: 51,
    onHand: 10,
    onOrder: 0,
    reorderPoint: 28,
    safetyStock: 2,
    orderUpTo: 61,
    warnings: [],
    digest: 'a'.repeat(64),
    evidence: { meanDailyDemand: 4, leadTimeDays: 6.4 },
    ...overrides,
  });

  const run = (candidates: ReorderCandidate[], calculatedAt = new Date().toISOString()): WorkerCandidates => ({
    calculatedAt,
    parameters: { demandWindowDays: 90 },
    candidates,
    skipped: [],
  });

  const pending = async (sku: string) =>
    (await repo.list(organizationId, { status: 'pending', skuId: sku, warehouseId: null, limit: 10, offset: 0 }))
      .proposals;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
    await runMigrations(pool, join(__dirname, '..', 'migrations'));
    purchasing = new PurchasingRepository(pool);
    repo = new ReordersRepository(pool, purchasing);

    organizationId = await insertId(
      `INSERT INTO organizations (slug, name) VALUES ('north-trading', 'North Trading') RETURNING id`,
      [],
    );
    otherOrganizationId = await insertId(
      `INSERT INTO organizations (slug, name) VALUES ('south-trading', 'South Trading') RETURNING id`,
      [],
    );
    manager = await insertId(
      `INSERT INTO users (email, display_name) VALUES ('manager@north.example.test', 'Synthetic manager') RETURNING id`,
      [],
    );
    otherManager = await insertId(
      `INSERT INTO users (email, display_name) VALUES ('manager@south.example.test', 'Synthetic manager') RETURNING id`,
      [],
    );
    supplierId = await insertId(
      `INSERT INTO suppliers (organization_id, code, name) VALUES ($1, 'ACME', 'Acme Packaging') RETURNING id`,
      [organizationId],
    );
    warehouseId = await insertId(
      `INSERT INTO warehouses (organization_id, code, name) VALUES ($1, 'WH1', 'Main warehouse') RETURNING id`,
      [organizationId],
    );
    for (let i = 1; i <= 8; i += 1) {
      skus.push(
        await insertId(
          `INSERT INTO skus (organization_id, code, name, unit, unit_cost_cents, preferred_supplier_id)
           VALUES ($1, $2, $3, 'each', 85, $4) RETURNING id`,
          [organizationId, `BOX-${i}`, `Synthetic box ${i}`, supplierId],
        ),
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('keeps unchanged proposals, replaces changed ones and retires ones no longer needed', async () => {
    const [a, b] = skus;
    let result = await repo.applyRun(organizationId, manager, run([candidate(a), candidate(b)]));
    expect(result).toMatchObject({ created: 2, unchanged: 0, superseded: 0 });
    const [first] = await pending(a);
    expect(first).toMatchObject({ skuCode: 'BOX-1', warehouseCode: 'WH1', supplierCode: 'ACME', suggestedQty: 51 });

    // Same digest for a; b changed.
    result = await repo.applyRun(organizationId, manager, run([candidate(a), candidate(b, { digest: 'b'.repeat(64), suggestedQty: 70 })]));
    expect(result).toMatchObject({ created: 1, unchanged: 1, superseded: 1 });
    expect((await pending(a))[0].id).toBe(first.id);
    expect((await pending(b)).map((p) => p.suggestedQty)).toEqual([70]);

    // Neither recommended any more.
    result = await repo.applyRun(organizationId, manager, run([]));
    expect(result).toMatchObject({ created: 0, unchanged: 0, superseded: 2 });
    expect(await pending(a)).toEqual([]);
    const retired = await repo.find(organizationId, first.id);
    expect(retired).toMatchObject({ status: 'superseded', supersededAt: expect.any(String) });

    const { rows } = await pool.query(
      `SELECT action, details->>'why' AS why FROM audit_events
        WHERE entity_type = 'reorder_proposal' AND entity_id = $1 ORDER BY occurred_at, id`,
      [first.id],
    );
    expect(rows).toEqual([
      { action: 'reorder_proposal.created', why: null },
      { action: 'reorder_proposal.superseded', why: 'no_longer_recommended' },
    ]);
  });

  it('approving raises a draft order in the same transaction, and only once', async () => {
    const sku = skus[2];
    await repo.applyRun(organizationId, manager, run([candidate(sku)]));
    const [open] = await pending(sku);

    const decided = await repo.decide(organizationId, open.id, manager, {
      decision: 'approve',
      reason: null,
      quantity: 60,
      expectedOn: '2026-12-10',
    });
    expect(decided?.proposal).toMatchObject({
      status: 'approved',
      approvedQty: 60,
      decidedBy: manager,
      purchaseOrderId: decided?.purchaseOrder?.id,
      purchaseOrderNumber: decided?.purchaseOrder?.number,
    });
    // A draft: it still needs submit and approval before anything is ordered.
    expect(decided?.purchaseOrder).toMatchObject({
      status: 'draft',
      supplierId,
      warehouseId,
      expectedOn: '2026-12-10',
      lines: [expect.objectContaining({ skuId: sku, quantityOrdered: 60, unitCostCents: 85 })],
    });

    await expect(
      repo.decide(organizationId, open.id, manager, { decision: 'reject', reason: 'Too late', quantity: null, expectedOn: null }),
    ).rejects.toBeInstanceOf(ProposalNotPendingError);

    const events = await purchasing.listEvents(organizationId, decided!.purchaseOrder!.id);
    expect(events?.[0]).toMatchObject({ action: 'purchase_order.created', details: { reorderProposalId: open.id } });
  });

  it('lets exactly one of two concurrent decisions win', async () => {
    const sku = skus[3];
    await repo.applyRun(organizationId, manager, run([candidate(sku)]));
    const [open] = await pending(sku);
    const results = await Promise.allSettled([
      repo.decide(organizationId, open.id, manager, { decision: 'approve', reason: null, quantity: null, expectedOn: null }),
      repo.decide(organizationId, open.id, manager, { decision: 'reject', reason: 'Overstock', quantity: null, expectedOn: null }),
      repo.decide(organizationId, open.id, manager, { decision: 'approve', reason: null, quantity: null, expectedOn: null }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ProposalNotPendingError);
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM purchase_order_lines WHERE organization_id = $1 AND sku_id = $2`,
      [organizationId, sku],
    );
    const proposalNow = await repo.find(organizationId, open.id);
    expect(rows[0].n).toBe(proposalNow?.status === 'approved' ? 1 : 0);
  });

  it('serializes concurrent runs so a pair never has two open proposals', async () => {
    const sku = skus[4];
    const results = await Promise.all(
      ['1', '2', '3', '4'].map((d) =>
        repo.applyRun(organizationId, manager, run([candidate(sku, { digest: d.repeat(64) })])),
      ),
    );
    expect(results.every((r) => r.created === 1)).toBe(true);
    expect(await pending(sku)).toHaveLength(1);
  });

  it('skips pairs approved while the worker was calculating and archived SKUs', async () => {
    const [approvedSku, archivedSku] = [skus[5], skus[6]];
    const before = new Date(Date.now() - 1000).toISOString();
    await repo.applyRun(organizationId, manager, run([candidate(approvedSku)]));
    const [open] = await pending(approvedSku);
    await repo.decide(organizationId, open.id, manager, { decision: 'approve', reason: null, quantity: null, expectedOn: null });
    await pool.query('UPDATE skus SET archived_at = now() WHERE id = $1', [archivedSku]);

    const result = await repo.applyRun(
      organizationId,
      manager,
      run([candidate(approvedSku, { digest: 'd'.repeat(64) }), candidate(archivedSku)], before),
    );
    expect(result.created).toBe(0);
    expect(result.skipped.map((s) => [s.skuId, s.reason])).toEqual([
      [approvedSku, 'changed_during_run'],
      [archivedSku, 'changed_during_run'],
    ]);
  });

  it('refuses to approve when the supplier was archived since the run', async () => {
    const sku = skus[7];
    const spare = await insertId(
      `INSERT INTO suppliers (organization_id, code, name) VALUES ($1, 'SPARE', 'Spare supplier') RETURNING id`,
      [organizationId],
    );
    await repo.applyRun(organizationId, manager, run([candidate(sku, { supplierId: spare })]));
    const [open] = await pending(sku);
    await pool.query('UPDATE suppliers SET archived_at = now() WHERE id = $1', [spare]);
    await expect(
      repo.decide(organizationId, open.id, manager, { decision: 'approve', reason: null, quantity: null, expectedOn: null }),
    ).rejects.toBeInstanceOf(ProposalOutdatedError);
    expect((await repo.find(organizationId, open.id))?.status).toBe('pending');

    const rejected = await repo.decide(organizationId, open.id, manager, {
      decision: 'reject',
      reason: 'Supplier retired',
      quantity: null,
      expectedOn: null,
    });
    expect(rejected?.proposal).toMatchObject({ status: 'rejected', decisionReason: 'Supplier retired', purchaseOrderId: null });
  });

  it('keeps tenants apart', async () => {
    const [mine] = (await repo.list(organizationId, { status: null, skuId: null, warehouseId: null, limit: 1, offset: 0 }))
      .proposals;
    expect(await repo.find(otherOrganizationId, mine.id)).toBeNull();
    expect(
      await repo.decide(otherOrganizationId, mine.id, otherManager, { decision: 'approve', reason: null, quantity: null, expectedOn: null }),
    ).toBeNull();
    // Another tenant's SKU is never turned into a proposal.
    await expect(repo.applyRun(otherOrganizationId, otherManager, run([candidate(skus[0])]))).resolves.toMatchObject({
      created: 0,
    });
  });

  it('never edits or deletes a proposal outside the allowed status change', async () => {
    const [decided] = (await repo.list(organizationId, { status: 'approved', skuId: null, warehouseId: null, limit: 1, offset: 0 }))
      .proposals;
    await expect(
      pool.query(`UPDATE reorder_proposals SET status = 'rejected', decision_reason = 'x' WHERE id = $1`, [decided.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('DELETE FROM reorder_proposals WHERE id = $1', [decided.id])).rejects.toMatchObject({
      code: '55000',
    });

    await repo.applyRun(organizationId, manager, run([candidate(skus[0], { digest: 'e'.repeat(64) })]));
    const [open] = await pending(skus[0]);
    await expect(
      pool.query('UPDATE reorder_proposals SET suggested_qty = 999 WHERE id = $1', [open.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query(`UPDATE reorder_proposals SET status = 'approved' WHERE id = $1`, [open.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
