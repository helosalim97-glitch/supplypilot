import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import { TenantGuard } from '../src/auth/tenant.guard';
import { configureApp } from '../src/http/configure-app';
import { InventoryController } from '../src/inventory/inventory.controller';
import {
  toStockBalance,
  type NewMovement,
  type StockBalanceRow,
} from '../src/inventory/inventory.models';
import {
  InsufficientStockError,
  InventoryRepository,
  StockOverflowError,
} from '../src/inventory/inventory.repository';
import { parseBalanceQuery } from '../src/inventory/inventory.validation';

const ORG = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const SKU = '9a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const WAREHOUSE = '7c2d3e4f-5a6b-4c7d-8e9f-000000000001';
const EVENT = '5e6f7a8b-9c0d-4e1f-8a2b-000000000001';
const USER = '1d2e3f4a-5b6c-4d7e-8f9a-000000000001';

const TOKENS: Record<string, { userId: string; role: 'viewer' | 'buyer' | 'manager' }> = {
  'viewer-token-0123456789': { userId: 'u-viewer', role: 'viewer' },
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

function balanceRow(overrides: Partial<StockBalanceRow> = {}): StockBalanceRow {
  return {
    sku_id: SKU,
    sku_code: 'SKU-0001',
    sku_name: 'Corrugated box, small',
    unit: 'each',
    warehouse_id: WAREHOUSE,
    warehouse_code: 'WH-01',
    warehouse_name: 'Main warehouse',
    on_hand: 40,
    reorder_point: 25,
    event_count: 3,
    last_event_id: EVENT,
    last_occurred_at: new Date('2026-11-19T08:30:00Z'),
    updated_at: new Date('2026-11-19T09:00:00Z'),
    ...overrides,
  };
}

const issue: NewMovement = {
  skuId: SKU,
  warehouseId: WAREHOUSE,
  type: 'issue',
  quantityDelta: -50,
  reason: null,
  reference: 'ORDER-77',
  correctsEventId: null,
  occurredAt: null,
};

describe('parseBalanceQuery', () => {
  const fieldsOf = (query: unknown): string[] => {
    try {
      parseBalanceQuery(query);
      return [];
    } catch (error) {
      return (error as { details: { field: string }[] }).details.map((d) => d.field);
    }
  };

  it('defaults to the first 100 balances with no filters', () => {
    expect(parseBalanceQuery({})).toEqual({ skuId: null, warehouseId: null, limit: 100, offset: 0 });
  });

  it('reads filters and paging from strings', () => {
    expect(
      parseBalanceQuery({ skuId: SKU.toUpperCase(), warehouseId: WAREHOUSE, limit: '20', offset: '40' }),
    ).toEqual({ skuId: SKU, warehouseId: WAREHOUSE, limit: 20, offset: 40 });
  });

  it('lists every invalid parameter', () => {
    expect(
      fieldsOf({ sku: SKU, skuId: 'nope', warehouseId: [WAREHOUSE], limit: '501', offset: '-1' }),
    ).toEqual(['sku', 'skuId', 'warehouseId', 'limit', 'offset']);
    expect(fieldsOf({ limit: '0' })).toEqual(['limit']);
    expect(fieldsOf({ limit: '2.5' })).toEqual(['limit']);
  });
});

describe('toStockBalance', () => {
  it('flags balances at or below the reorder point', () => {
    expect(toStockBalance(balanceRow()).atOrBelowReorderPoint).toBe(false);
    expect(toStockBalance(balanceRow({ on_hand: 25 })).atOrBelowReorderPoint).toBe(true);
  });

  it('exposes camelCase fields and ISO timestamps', () => {
    expect(toStockBalance(balanceRow())).toEqual({
      skuId: SKU,
      skuCode: 'SKU-0001',
      skuName: 'Corrugated box, small',
      unit: 'each',
      warehouseId: WAREHOUSE,
      warehouseCode: 'WH-01',
      warehouseName: 'Main warehouse',
      onHand: 40,
      reorderPoint: 25,
      atOrBelowReorderPoint: false,
      eventCount: 3,
      lastEventId: EVENT,
      lastMovementAt: '2026-11-19T08:30:00.000Z',
      updatedAt: '2026-11-19T09:00:00.000Z',
    });
  });
});

describe('InventoryRepository balances', () => {
  type Result = unknown[] | Error;
  function fakePool(...results: Result[]) {
    const queue = [...results];
    return {
      query: jest.fn(async (_sql: string, _params?: unknown[]) => {
        const next = queue.shift() ?? [];
        if (next instanceof Error) throw next;
        return { rows: next };
      }),
    };
  }
  const repoWith = (pool: ReturnType<typeof fakePool>) =>
    new InventoryRepository(pool as unknown as Pick<Pool, 'query'>);
  const pgError = (code: string, constraint?: string) =>
    Object.assign(new Error('database error'), { code, constraint });

  it('lists active balances of the organization and detects another page', async () => {
    const pool = fakePool([balanceRow(), balanceRow({ warehouse_code: 'WH-02' })]);
    const result = await repoWith(pool).listBalances(ORG, {
      skuId: SKU,
      warehouseId: null,
      limit: 1,
      offset: 0,
    });

    expect(result.hasMore).toBe(true);
    expect(result.balances).toHaveLength(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/b\.organization_id = \$1/);
    expect(sql).toMatch(/s\.archived_at IS NULL AND w\.archived_at IS NULL/);
    expect(sql).toMatch(/ORDER BY s\.code, w\.code/);
    expect(params).toEqual([ORG, SKU, null, 2, 0]);
  });

  it('turns the negative-stock check into InsufficientStockError with the on-hand quantity', async () => {
    const pool = fakePool(pgError('23514', 'stock_balances_on_hand_non_negative'), [{ on_hand: 40 }]);
    const error = await repoWith(pool)
      .recordMovement(ORG, USER, 'key-00000001', issue)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientStockError);
    expect(error).toMatchObject({ onHand: 40, quantityDelta: -50 });
    expect(pool.query.mock.calls[1][1]).toEqual([ORG, SKU, WAREHOUSE]);
  });

  it('reports zero on hand when the SKU was never stocked in the warehouse', async () => {
    const pool = fakePool(pgError('23514', 'stock_balances_on_hand_non_negative'), []);
    await expect(
      repoWith(pool).recordMovement(ORG, USER, 'key-00000001', issue),
    ).rejects.toMatchObject({ onHand: 0 });
  });

  it('maps an on-hand overflow and passes other database errors through', async () => {
    await expect(
      repoWith(fakePool(pgError('22003'))).recordMovement(ORG, USER, 'key-00000001', issue),
    ).rejects.toBeInstanceOf(StockOverflowError);

    const other = pgError('23514', 'inventory_events_delta_sign');
    await expect(
      repoWith(fakePool(other)).recordMovement(ORG, USER, 'key-00000001', issue),
    ).rejects.toBe(other);
  });
});

describe('inventory endpoints', () => {
  let app: INestApplication;
  let inventory: { listBalances: jest.Mock; recordMovement: jest.Mock };

  beforeEach(async () => {
    inventory = { listBalances: jest.fn(), recordMovement: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [
        TenantGuard,
        { provide: AuthRepository, useValue: fakeAuthRepository() },
        { provide: InventoryRepository, useValue: inventory },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (token: string, query = '') =>
    request(app.getHttpServer())
      .get(`/v1/organizations/${ORG}/inventory${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('lets a viewer read balances with paging info', async () => {
    inventory.listBalances.mockResolvedValue({
      balances: [toStockBalance(balanceRow())],
      hasMore: false,
    });

    const res = await get('viewer-token-0123456789', `?warehouseId=${WAREHOUSE}&limit=10`).expect(200);

    expect(res.body.data[0]).toMatchObject({ skuCode: 'SKU-0001', onHand: 40 });
    expect(res.body.page).toEqual({
      skuId: null,
      warehouseId: WAREHOUSE,
      limit: 10,
      offset: 0,
      hasMore: false,
    });
    expect(inventory.listBalances).toHaveBeenCalledWith(ORG, {
      skuId: null,
      warehouseId: WAREHOUSE,
      limit: 10,
      offset: 0,
    });
  });

  it('returns 422 for bad query parameters without touching the database', async () => {
    const res = await get('viewer-token-0123456789', '?limit=1000').expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'limit', message: 'must be a whole number from 1 to 500' },
    ]);
    expect(inventory.listBalances).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers', async () => {
    await get('unknown-token-0123456789').expect(401);
    expect(inventory.listBalances).not.toHaveBeenCalled();
  });

  it('returns 409 insufficient_stock when an issue exceeds on-hand stock', async () => {
    inventory.recordMovement.mockRejectedValue(new InsufficientStockError(40, -50));

    const res = await request(app.getHttpServer())
      .post(`/v1/organizations/${ORG}/inventory/movements`)
      .set('Authorization', 'Bearer manager-token-0123456789')
      .set('Idempotency-Key', 'order-77-line-1')
      .send({ skuId: SKU, warehouseId: WAREHOUSE, type: 'issue', quantity: 50 })
      .expect(409);

    expect(res.body.error.code).toBe('insufficient_stock');
    expect(res.body.error.details).toEqual([
      { field: 'quantity', message: 'would take on-hand stock below zero (on hand: 40)' },
    ]);
  });
});

describe('0005_stock_balances migration', () => {
  let sql: string;

  beforeAll(async () => {
    sql = await readFile(join(__dirname, '..', 'migrations', '0005_stock_balances.sql'), 'utf8');
  });

  it('keeps one non-negative balance per SKU and warehouse', () => {
    expect(sql).toContain('PRIMARY KEY (organization_id, sku_id, warehouse_id)');
    expect(sql).toMatch(/CONSTRAINT stock_balances_on_hand_non_negative CHECK \(on_hand >= 0\)/);
  });

  it('updates balances from every inserted event', () => {
    expect(sql).toMatch(/AFTER INSERT ON inventory_events\s+FOR EACH ROW/);
    expect(sql).toMatch(/ON CONFLICT \(organization_id, sku_id, warehouse_id\) DO UPDATE/);
    expect(sql).toMatch(/on_hand\s+= b\.on_hand \+ EXCLUDED\.on_hand/);
  });

  it('backfills existing events and exposes a drift view', () => {
    expect(sql).toMatch(/INSERT INTO stock_balances[\s\S]+FROM inventory_events/);
    expect(sql).toContain('CREATE VIEW stock_balance_drift');
  });
});
