import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { SkuRow, SupplierRow } from '../src/catalog/catalog.models';
import {
  CatalogRepository,
  DuplicateCodeError,
  UnknownReferenceError,
} from '../src/catalog/catalog.repository';

const ORG = '6f1c2a52-6a0e-4b8e-9a51-0c6a1f6c0001';
const SUPPLIER_ID = '0b9a7c1e-3d2f-4e5a-8b6c-7d8e9f000001';
const CREATED = new Date('2026-01-05T08:00:00.000Z');

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

function fakePool(result: unknown[] | Error = []) {
  return {
    query: jest.fn(async (_sql: string, _params?: unknown[]) => {
      if (result instanceof Error) throw result;
      return { rows: result };
    }),
  };
}

/** The fake only implements the query shape the repository uses. */
const repoWith = (pool: ReturnType<typeof fakePool>) =>
  new CatalogRepository(pool as unknown as Pick<Pool, 'query'>);

const supplierRow: SupplierRow = {
  id: SUPPLIER_ID,
  organization_id: ORG,
  code: 'ACME',
  name: 'Acme Sample Supply',
  contact_email: null,
  archived_at: null,
  created_at: CREATED,
  updated_at: CREATED,
};

const skuRow: SkuRow = {
  id: '9a1b2c3d-4e5f-4a6b-8c7d-000000000001',
  organization_id: ORG,
  code: 'NORTH-SKU001',
  name: 'Sample widget',
  unit: 'each',
  unit_cost_cents: 1250,
  reorder_point: 20,
  preferred_supplier_id: SUPPLIER_ID,
  archived_at: null,
  created_at: CREATED,
  updated_at: CREATED,
};

describe('CatalogRepository', () => {
  it('scopes every read by organization id', async () => {
    const pool = fakePool();
    const repo = repoWith(pool);
    await repo.listSuppliers(ORG);
    await repo.listWarehouses(ORG);
    await repo.listSkus(ORG);
    await repo.findSupplier(ORG, SUPPLIER_ID);
    await repo.findWarehouse(ORG, SUPPLIER_ID);
    await repo.findSku(ORG, SUPPLIER_ID);

    expect(pool.query).toHaveBeenCalledTimes(6);
    for (const [sql, params] of pool.query.mock.calls) {
      expect(sql).toMatch(/WHERE organization_id = \$1/);
      expect(params?.[0]).toBe(ORG);
    }
  });

  it('hides archived records from lists', async () => {
    const pool = fakePool();
    const repo = repoWith(pool);
    await repo.listSkus(ORG);
    expect(pool.query.mock.calls[0][0]).toMatch(/archived_at IS NULL/);
  });

  it('maps rows to camelCase records with ISO timestamps', async () => {
    const repo = repoWith(fakePool([skuRow]));
    const [sku] = await repo.listSkus(ORG);
    expect(sku).toEqual({
      id: skuRow.id,
      organizationId: ORG,
      code: 'NORTH-SKU001',
      name: 'Sample widget',
      unit: 'each',
      unitCostCents: 1250,
      reorderPoint: 20,
      preferredSupplierId: SUPPLIER_ID,
      archivedAt: null,
      createdAt: '2026-01-05T08:00:00.000Z',
      updatedAt: '2026-01-05T08:00:00.000Z',
    });
  });

  it('returns null when a record is not in the organization', async () => {
    const repo = repoWith(fakePool([]));
    await expect(repo.findSupplier(ORG, SUPPLIER_ID)).resolves.toBeNull();
  });

  it('inserts with the organization id and optional fields defaulted', async () => {
    const pool = fakePool([skuRow]);
    const repo = repoWith(pool);
    await repo.createSku(ORG, { code: 'NORTH-SKU001', name: 'Sample widget', unit: 'each', unitCostCents: 1250 });
    expect(pool.query.mock.calls[0][1]).toEqual([ORG, 'NORTH-SKU001', 'Sample widget', 'each', 1250, 0, null]);
  });

  it('creates a supplier and returns the stored record', async () => {
    const repo = repoWith(fakePool([supplierRow]));
    const supplier = await repo.createSupplier(ORG, { code: 'ACME', name: 'Acme Sample Supply' });
    expect(supplier).toMatchObject({ id: SUPPLIER_ID, code: 'ACME', contactEmail: null });
  });

  it('turns a unique violation into DuplicateCodeError', async () => {
    const repo = repoWith(fakePool(pgError('23505')));
    await expect(repo.createWarehouse(ORG, { code: 'MAIN', name: 'Main' })).rejects.toEqual(
      new DuplicateCodeError('warehouse', 'MAIN'),
    );
  });

  it('turns a foreign key violation into UnknownReferenceError', async () => {
    const repo = repoWith(fakePool(pgError('23503')));
    const attempt = repo.createSku(ORG, {
      code: 'X1',
      name: 'X',
      unit: 'each',
      unitCostCents: 1,
      preferredSupplierId: SUPPLIER_ID,
    });
    await expect(attempt).rejects.toBeInstanceOf(UnknownReferenceError);
  });

  it('rethrows other database errors unchanged', async () => {
    const failure = pgError('57P01');
    const repo = repoWith(fakePool(failure));
    await expect(repo.createSupplier(ORG, { code: 'A', name: 'A' })).rejects.toBe(failure);
  });
});

describe('0003_catalog migration', () => {
  let sql: string;

  beforeAll(async () => {
    sql = await readFile(join(__dirname, '..', 'migrations', '0003_catalog.sql'), 'utf8');
  });

  it.each(['suppliers', 'warehouses', 'skus'])('gives %s a tenant column and per-tenant unique code', (table) => {
    const body = sql.split(`CREATE TABLE ${table} (`)[1]?.split(');')[0] ?? '';
    expect(body).toMatch(/organization_id\s+uuid\s+NOT NULL REFERENCES organizations/);
    expect(body).toContain('UNIQUE (organization_id, code)');
    expect(sql).toContain(`CREATE TRIGGER ${table}_set_updated_at`);
  });

  it('keeps the preferred supplier in the same organization', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, preferred_supplier_id\)\s+REFERENCES suppliers \(organization_id, id\)/,
    );
  });
});
