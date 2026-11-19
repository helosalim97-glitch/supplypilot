import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import { TenantGuard } from '../src/auth/tenant.guard';
import { configureApp } from '../src/http/configure-app';
import { ImportsController } from '../src/imports/imports.controller';
import type { ImportBatchRow, ImportRow } from '../src/imports/imports.models';
import { ImportsRepository } from '../src/imports/imports.repository';
import { parseNewImport } from '../src/imports/imports.validation';

const ORG = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const SKU = '9a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const WAREHOUSE = '7c2d3e4f-5a6b-4c7d-8e9f-000000000001';
const BATCH = '3c4d5e6f-7a8b-4c9d-8e0f-000000000001';
const USER = '1d2e3f4a-5b6c-4d7e-8f9a-000000000001';

const TOKENS: Record<string, { userId: string; role: 'viewer' | 'buyer' | 'manager' }> = {
  'viewer-token-0123456789': { userId: 'u-viewer', role: 'viewer' },
  'buyer-token-0123456789': { userId: 'u-buyer', role: 'buyer' },
  'manager-token-0123456789': { userId: USER, role: 'manager' },
};

function fakeAuthRepository() {
  return {
    findUserIdByToken: jest.fn(async (token: string) => TOKENS[token]?.userId ?? null),
    findRole: jest.fn(async (userId: string, organizationId: string) => {
      const entry = Object.values(TOKENS).find((t) => t.userId === userId);
      return entry && organizationId === ORG ? entry.role : null;
    }),
    listMemberships: jest.fn(async () => []),
  };
}

const CONTENT = [
  'SKU,Warehouse,Type,Qty,Reference',
  'SKU-001,MAIN,receipt,24,PO-1001',
  'SKU-001,MAIN,issue,0,SO-77',
  'SKU-404,MAIN,issue,2,SO-78',
].join('\n');

const batchRow: ImportBatchRow = {
  id: BATCH,
  organization_id: ORG,
  kind: 'stock_movements',
  file_name: 'november-moves.csv',
  file_sha256: createHash('sha256').update(CONTENT).digest('hex'),
  delimiter: ',',
  columns: ['SKU', 'Warehouse', 'Type', 'Qty', 'Reference'],
  column_mapping: {
    skuCode: 'SKU',
    warehouseCode: 'Warehouse',
    type: 'Type',
    quantity: 'Qty',
    reason: null,
    reference: 'Reference',
    occurredAt: null,
  },
  default_type: null,
  status: 'previewed',
  row_count: 3,
  valid_count: 1,
  created_by: USER,
  created_at: new Date('2026-11-19T09:00:00.000Z'),
};

describe('parseNewImport', () => {
  const fieldsOf = (body: unknown): string[] => {
    try {
      parseNewImport(body);
      return [];
    } catch (error) {
      return (error as { details: { field: string }[] }).details.map((d) => d.field);
    }
  };

  it('accepts a file with optional mapping and default type', () => {
    expect(
      parseNewImport({
        fileName: ' moves.csv ',
        content: CONTENT,
        mapping: { reason: null, reference: 'Reference' },
        defaultType: 'receipt',
      }),
    ).toEqual({
      fileName: 'moves.csv',
      content: CONTENT,
      mapping: { reason: null, reference: 'Reference' },
      defaultType: 'receipt',
    });
  });

  it('lists every invalid field', () => {
    expect(
      fieldsOf({
        fileName: '',
        content: '  ',
        mapping: { sku: 'SKU', quantity: 3 },
        defaultType: 'correction',
        extra: true,
      }),
    ).toEqual(['extra', 'fileName', 'content', 'mapping.sku', 'mapping.quantity', 'defaultType']);
    expect(fieldsOf([])).toEqual(['body']);
    expect(fieldsOf({ fileName: 'a.csv', content: 'x', mapping: ['SKU'] })).toEqual(['mapping']);
  });
});

describe('ImportsRepository', () => {
  function fakePool(...results: unknown[][]) {
    const queue = [...results];
    return {
      query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: queue.shift() ?? [] })),
    };
  }
  const repoWith = (pool: ReturnType<typeof fakePool>) =>
    new ImportsRepository(pool as unknown as Pick<Pool, 'query'>);

  it('looks up active codes of the organization only', async () => {
    const pool = fakePool([
      { kind: 'sku', id: SKU, code: 'SKU-001' },
      { kind: 'warehouse', id: WAREHOUSE, code: 'Main' },
    ]);
    const codes = await repoWith(pool).findCatalogCodes(ORG, ['sku-001'], ['main']);
    expect(codes.skus.get('sku-001')).toBe(SKU);
    expect(codes.warehouses.get('main')).toBe(WAREHOUSE);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql.match(/organization_id = \$1 AND archived_at IS NULL/g)).toHaveLength(2);
    expect(params).toEqual([ORG, ['sku-001'], ['main']]);
  });

  it('stores the batch and its rows in one statement', async () => {
    const valid: ImportRow = {
      rowNumber: 2,
      status: 'valid',
      cells: ['SKU-001', 'MAIN', 'receipt', '24', 'PO-1001'],
      values: { skuCode: 'SKU-001', quantity: '24' },
      movement: {
        skuId: SKU,
        warehouseId: WAREHOUSE,
        type: 'receipt',
        quantityDelta: 24,
        reason: null,
        reference: 'PO-1001',
        occurredAt: null,
      },
      errors: [],
    };
    const invalid: ImportRow = {
      ...valid,
      rowNumber: 3,
      status: 'invalid',
      movement: null,
      errors: [{ field: 'quantity', message: 'must be a whole number from 1 to 2147483647' }],
    };
    const pool = fakePool([{ ...batchRow, row_count: 2 }]);
    const batch = await repoWith(pool).createBatch(ORG, USER, {
      fileName: 'november-moves.csv',
      fileSha256: batchRow.file_sha256,
      delimiter: ',',
      columns: batchRow.columns,
      mapping: batchRow.column_mapping,
      defaultType: null,
      rows: [valid, invalid],
    });

    expect(batch).toMatchObject({ id: BATCH, rowCount: 2, validCount: 1, invalidCount: 1 });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO import_batches[\s\S]*INSERT INTO import_rows/);
    expect(params?.[0]).toBe(ORG);
    expect(params?.[7]).toBe(2);
    expect(params?.[8]).toBe(1);
    expect(params?.[9]).toBe(USER);
    const rows = JSON.parse(params?.[10] as string);
    expect(rows[0]).toMatchObject({ row_number: 2, sku_id: SKU, quantity_delta: 24, errors: [] });
    expect(rows[1]).toMatchObject({ row_number: 3, sku_id: null, quantity_delta: null });
  });

  it('filters rows by status and fetches one extra row to detect another page', async () => {
    const pool = fakePool([]);
    await repoWith(pool).listRows(ORG, BATCH, { status: 'invalid', limit: 50, offset: 100 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE organization_id = \$1 AND batch_id = \$2/);
    expect(params).toEqual([ORG, BATCH, 'invalid', 51, 100]);
  });
});

describe('imports API', () => {
  let app: INestApplication;
  let imports: {
    findCatalogCodes: jest.Mock;
    createBatch: jest.Mock;
    findBatch: jest.Mock;
    listRows: jest.Mock;
  };

  beforeEach(async () => {
    imports = {
      findCatalogCodes: jest.fn(async () => ({
        skus: new Map([['sku-001', SKU]]),
        warehouses: new Map([['main', WAREHOUSE]]),
      })),
      createBatch: jest.fn(async () => ({ id: BATCH, rowCount: 3, validCount: 1 })),
      findBatch: jest.fn(),
      listRows: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ImportsController],
      providers: [
        TenantGuard,
        { provide: AuthRepository, useValue: fakeAuthRepository() },
        { provide: ImportsRepository, useValue: imports },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const upload = (token: string, payload: unknown) =>
    request(app.getHttpServer())
      .post(`/v1/organizations/${ORG}/imports`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload as object);

  it('stores a preview with per-row errors and returns 201', async () => {
    const res = await upload('manager-token-0123456789', {
      fileName: 'november-moves.csv',
      content: CONTENT,
    }).expect(201);

    expect(imports.findCatalogCodes).toHaveBeenCalledWith(ORG, ['sku-001', 'sku-404'], ['main']);
    const [org, user, draft] = imports.createBatch.mock.calls[0];
    expect([org, user]).toEqual([ORG, USER]);
    expect(draft).toMatchObject({
      fileName: 'november-moves.csv',
      fileSha256: batchRow.file_sha256,
      delimiter: ',',
      columns: batchRow.columns,
      mapping: batchRow.column_mapping,
      defaultType: null,
    });
    expect(res.body.data.rows.map((r: ImportRow) => [r.rowNumber, r.status])).toEqual([
      [2, 'valid'],
      [3, 'invalid'],
      [4, 'invalid'],
    ]);
    expect(res.body.data.rows[0].movement).toMatchObject({ skuId: SKU, quantityDelta: 24 });
    expect(res.body.data.rows[2].errors).toEqual([
      { field: 'skuCode', message: '"SKU-404" is not an active SKU code in this organization' },
    ]);
    expect(res.body.page).toEqual({ status: null, limit: 50, offset: 0, hasMore: false });
  });

  it('returns 422 and stores nothing when the file cannot be read', async () => {
    const res = await upload('manager-token-0123456789', {
      fileName: 'broken.csv',
      content: 'SKU,Warehouse,Qty\n"SKU-001,MAIN,4\n',
    }).expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'content', message: 'row 2: has a quoted cell that is never closed' },
    ]);
    expect(imports.createBatch).not.toHaveBeenCalled();
  });

  it('returns 422 for a header without data rows', async () => {
    const res = await upload('manager-token-0123456789', {
      fileName: 'empty.csv',
      content: 'SKU,Warehouse,Qty\n',
    }).expect(422);
    expect(res.body.error.details[0]).toEqual({
      field: 'content',
      message: 'has a header but no data rows',
    });
  });

  it('returns 422 when a required column cannot be mapped', async () => {
    const res = await upload('manager-token-0123456789', {
      fileName: 'moves.csv',
      content: 'Item,Bin,Count\nSKU-001,A1,4\n',
    }).expect(422);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual([
      'mapping.warehouseCode',
      'mapping.quantity',
    ]);
    expect(imports.findCatalogCodes).not.toHaveBeenCalled();
  });

  it('applies an explicit mapping', async () => {
    await upload('manager-token-0123456789', {
      fileName: 'moves.csv',
      content: 'Item,Bin,Count\nSKU-001,MAIN,4\n',
      mapping: { warehouseCode: 'Bin', quantity: 'Count' },
      defaultType: 'receipt',
    }).expect(201);
    const draft = imports.createBatch.mock.calls[0][2];
    expect(draft.mapping).toMatchObject({ skuCode: 'Item', warehouseCode: 'Bin', quantity: 'Count' });
    expect(draft.rows[0].movement).toMatchObject({ type: 'receipt', quantityDelta: 4 });
  });

  it.each(['viewer', 'buyer'])('does not let a %s upload imports', async (role) => {
    await upload(`${role}-token-0123456789`, { fileName: 'a.csv', content: CONTENT }).expect(403);
    expect(imports.createBatch).not.toHaveBeenCalled();
  });

  it('shows a stored batch with a page of rows to any member', async () => {
    imports.findBatch.mockResolvedValue({ id: BATCH, rowCount: 3 });
    imports.listRows.mockResolvedValue({ rows: [{ rowNumber: 3 }], hasMore: true });
    const res = await request(app.getHttpServer())
      .get(`/v1/organizations/${ORG}/imports/${BATCH}?status=invalid&limit=1`)
      .set('Authorization', 'Bearer viewer-token-0123456789')
      .expect(200);
    expect(imports.findBatch).toHaveBeenCalledWith(ORG, BATCH);
    expect(imports.listRows).toHaveBeenCalledWith(ORG, BATCH, {
      status: 'invalid',
      limit: 1,
      offset: 0,
    });
    expect(res.body).toEqual({
      data: { id: BATCH, rowCount: 3, rows: [{ rowNumber: 3 }] },
      page: { status: 'invalid', limit: 1, offset: 0, hasMore: true },
    });
  });

  it('returns 404 for an unknown or malformed import id', async () => {
    imports.findBatch.mockResolvedValue(null);
    for (const id of [BATCH, 'not-a-uuid']) {
      const res = await request(app.getHttpServer())
        .get(`/v1/organizations/${ORG}/imports/${id}`)
        .set('Authorization', 'Bearer viewer-token-0123456789')
        .expect(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect(imports.findBatch).toHaveBeenCalledTimes(1);
  });

  it('returns 422 for invalid row filters', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/organizations/${ORG}/imports/${BATCH}?status=pending&limit=0`)
      .set('Authorization', 'Bearer viewer-token-0123456789')
      .expect(422);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual([
      'status',
      'limit',
    ]);
  });
});

describe('0006_import_batches migration', () => {
  let sql: string;

  beforeAll(async () => {
    sql = await readFile(join(__dirname, '..', 'migrations', '0006_import_batches.sql'), 'utf8');
  });

  it('keeps rows and their references inside the organization', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, batch_id\)\s+REFERENCES import_batches \(organization_id, id\)/,
    );
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, sku_id\)\s+REFERENCES skus \(organization_id, id\)/);
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, warehouse_id\)\s+REFERENCES warehouses \(organization_id, id\)/,
    );
  });

  it('only allows importable movement types and complete movements on valid rows', () => {
    expect(sql).toContain("event_type IN ('receipt', 'issue', 'adjustment')");
    expect(sql).toContain('CONSTRAINT import_rows_movement_complete');
  });
});
