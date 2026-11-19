import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import { TenantGuard } from '../src/auth/tenant.guard';
import { UnknownReferenceError } from '../src/catalog/catalog.repository';
import { configureApp } from '../src/http/configure-app';
import { InventoryController } from '../src/inventory/inventory.controller';
import type { InventoryEventRow, NewMovement } from '../src/inventory/inventory.models';
import {
  IdempotencyConflictError,
  InventoryRepository,
  movementHash,
} from '../src/inventory/inventory.repository';
import { parseNewMovement } from '../src/inventory/inventory.validation';

const ORG = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const SKU = '9a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const WAREHOUSE = '7c2d3e4f-5a6b-4c7d-8e9f-000000000001';
const EVENT = '5e6f7a8b-9c0d-4e1f-8a2b-000000000001';
const USER = '1d2e3f4a-5b6c-4d7e-8f9a-000000000001';
const RECORDED = new Date('2026-11-19T09:00:00.000Z');

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

function eventRow(
  input: NewMovement,
  overrides: Partial<InventoryEventRow> = {},
): InventoryEventRow {
  return {
    id: EVENT,
    organization_id: ORG,
    sku_id: input.skuId,
    warehouse_id: input.warehouseId,
    event_type: input.type,
    quantity_delta: input.quantityDelta,
    reason: input.reason,
    reference: input.reference,
    corrects_event_id: input.correctsEventId,
    created_by: USER,
    occurred_at: input.occurredAt ? new Date(input.occurredAt) : RECORDED,
    recorded_at: RECORDED,
    request_hash: movementHash(input),
    ...overrides,
  };
}

const receipt: NewMovement = {
  skuId: SKU,
  warehouseId: WAREHOUSE,
  type: 'receipt',
  quantityDelta: 24,
  reason: null,
  reference: 'PO-1001',
  correctsEventId: null,
  occurredAt: null,
};

describe('parseNewMovement', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  const parse = (body: unknown) => parseNewMovement(body, now);
  const fieldsOf = (body: unknown): string[] => {
    try {
      parse(body);
      return [];
    } catch (error) {
      return (error as { details: { field: string }[] }).details.map((d) => d.field);
    }
  };

  it('turns an issue into a negative delta and trims text', () => {
    const movement = parse({
      skuId: SKU.toUpperCase(),
      warehouseId: WAREHOUSE,
      type: 'issue',
      quantity: 3,
      reference: '  ORDER-77 ',
      occurredAt: '2026-11-19T08:30:00+01:00',
    });
    expect(movement).toEqual({
      skuId: SKU,
      warehouseId: WAREHOUSE,
      type: 'issue',
      quantityDelta: -3,
      reason: null,
      reference: 'ORDER-77',
      correctsEventId: null,
      occurredAt: '2026-11-19T07:30:00.000Z',
    });
  });

  it('keeps the sign of an adjustment and requires a reason', () => {
    const base = { skuId: SKU, warehouseId: WAREHOUSE, type: 'adjustment', quantity: -2 };
    expect(fieldsOf(base)).toEqual(['reason']);
    expect(parse({ ...base, reason: 'cycle count' }).quantityDelta).toBe(-2);
  });

  it('only accepts positive quantities for receipts and issues', () => {
    const base = { skuId: SKU, warehouseId: WAREHOUSE, type: 'receipt' };
    expect(fieldsOf({ ...base, quantity: -5 })).toEqual(['quantity']);
    expect(fieldsOf({ ...base, quantity: 1.5 })).toEqual(['quantity']);
    expect(fieldsOf({ ...base, quantity: '5' })).toEqual(['quantity']);
    expect(fieldsOf({ ...base, quantity: 0, type: 'adjustment', reason: 'count' })).toEqual([
      'quantity',
    ]);
  });

  it('ties correctsEventId to correction movements', () => {
    const base = { skuId: SKU, warehouseId: WAREHOUSE, quantity: -24 };
    expect(fieldsOf({ ...base, type: 'correction' })).toEqual(['correctsEventId']);
    expect(fieldsOf({ ...base, type: 'issue', quantity: 1, correctsEventId: EVENT })).toEqual([
      'correctsEventId',
    ]);
    expect(parse({ ...base, type: 'correction', correctsEventId: EVENT }).correctsEventId).toBe(
      EVENT,
    );
  });

  it('lists every invalid field', () => {
    expect(
      fieldsOf({
        skuId: 'nope',
        warehouseId: 42,
        type: 'transfer',
        quantity: 0,
        reason: '  ',
        occurredAt: '2026-11-19',
        extra: true,
      }),
    ).toEqual(['extra', 'skuId', 'warehouseId', 'type', 'quantity', 'reason', 'occurredAt']);
  });

  it('rejects movements dated in the future', () => {
    const body = { skuId: SKU, warehouseId: WAREHOUSE, type: 'receipt', quantity: 1 };
    expect(fieldsOf({ ...body, occurredAt: '2026-11-19T10:04:00Z' })).toEqual([]);
    expect(fieldsOf({ ...body, occurredAt: '2026-11-19T10:06:00Z' })).toEqual(['occurredAt']);
  });
});

describe('InventoryRepository.recordMovement', () => {
  function fakePool(...results: unknown[][]) {
    const queue = [...results];
    return {
      query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: queue.shift() ?? [] })),
    };
  }
  const repoWith = (pool: ReturnType<typeof fakePool>) =>
    new InventoryRepository(pool as unknown as Pick<Pool, 'query'>);

  it('inserts once, scoped to active records of the organization', async () => {
    const pool = fakePool([eventRow(receipt)]);
    const result = await repoWith(pool).recordMovement(ORG, USER, 'key-00000001', receipt);

    expect(result).toEqual({
      replayed: false,
      event: expect.objectContaining({ id: EVENT, quantityDelta: 24, type: 'receipt' }),
    });
    expect(result.event).not.toHaveProperty('request_hash');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/s\.organization_id = \$1/);
    expect(sql).toMatch(/s\.archived_at IS NULL/);
    expect(sql).toMatch(/w\.archived_at IS NULL/);
    expect(sql).toMatch(/ON CONFLICT \(organization_id, idempotency_key\) DO NOTHING/);
    expect(params?.[0]).toBe(ORG);
    expect(params?.[8]).toBe('key-00000001');
    expect(params?.[9]).toBe(movementHash(receipt));
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('replays the stored event for a retried key with the same body', async () => {
    const pool = fakePool([], [eventRow(receipt)]);
    const result = await repoWith(pool).recordMovement(ORG, USER, 'key-00000001', receipt);
    expect(result.replayed).toBe(true);
    expect(result.event.id).toBe(EVENT);
  });

  it('rejects a key reused for a different movement', async () => {
    const pool = fakePool([], [eventRow({ ...receipt, quantityDelta: 12 })]);
    await expect(
      repoWith(pool).recordMovement(ORG, USER, 'key-00000001', receipt),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it.each([
    [{ sku: false, warehouse: true }, 'skuId'],
    [{ sku: true, warehouse: false }, 'warehouseId'],
    [{ sku: true, warehouse: true }, 'correctsEventId'],
  ])('reports which reference is missing (%o)', async (exists, field) => {
    const pool = fakePool([], [], [exists]);
    await expect(
      repoWith(pool).recordMovement(ORG, USER, 'key-00000001', receipt),
    ).rejects.toEqual(new UnknownReferenceError(field));
  });

  it('hashes every field that defines the movement', () => {
    expect(movementHash(receipt)).toMatch(/^[0-9a-f]{64}$/);
    expect(movementHash({ ...receipt, reference: 'PO-1002' })).not.toBe(movementHash(receipt));
    expect(movementHash({ ...receipt })).toBe(movementHash(receipt));
  });
});

describe('POST /v1/organizations/:orgId/inventory/movements', () => {
  let app: INestApplication;
  let inventory: { recordMovement: jest.Mock };

  beforeEach(async () => {
    inventory = { recordMovement: jest.fn() };
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

  const body = {
    skuId: SKU,
    warehouseId: WAREHOUSE,
    type: 'receipt',
    quantity: 24,
    reference: 'PO-1001',
  };
  const post = (token: string, key: string | null, payload: unknown = body) => {
    const req = request(app.getHttpServer())
      .post(`/v1/organizations/${ORG}/inventory/movements`)
      .set('Authorization', `Bearer ${token}`);
    return (key ? req.set('Idempotency-Key', key) : req).send(payload as object);
  };

  it('records a movement as the calling user and returns 201', async () => {
    inventory.recordMovement.mockResolvedValue({
      event: { id: EVENT, quantityDelta: 24 },
      replayed: false,
    });

    const res = await post('manager-token-0123456789', 'po-1001-line-1').expect(201);

    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.body).toEqual({ data: { id: EVENT, quantityDelta: 24 } });
    expect(inventory.recordMovement).toHaveBeenCalledWith(ORG, USER, 'po-1001-line-1', receipt);
  });

  it('returns 200 with the original event for a retry', async () => {
    inventory.recordMovement.mockResolvedValue({ event: { id: EVENT }, replayed: true });
    const res = await post('manager-token-0123456789', 'po-1001-line-1').expect(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body.data.id).toBe(EVENT);
  });

  it('returns 409 when the key was used for another movement', async () => {
    inventory.recordMovement.mockRejectedValue(new IdempotencyConflictError('po-1001-line-1'));
    const res = await post('manager-token-0123456789', 'po-1001-line-1').expect(409);
    expect(res.body.error.code).toBe('idempotency_conflict');
  });

  it('requires a well-formed Idempotency-Key header', async () => {
    for (const key of [null, 'short', 'has spaces in it']) {
      const res = await post('manager-token-0123456789', key).expect(422);
      expect(res.body.error.details[0].field).toBe('Idempotency-Key');
    }
    expect(inventory.recordMovement).not.toHaveBeenCalled();
  });

  it('returns 422 for an SKU outside the organization', async () => {
    inventory.recordMovement.mockRejectedValue(new UnknownReferenceError('skuId'));
    const res = await post('manager-token-0123456789', 'po-1001-line-1').expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'skuId', message: 'is not an active SKU in this organization' },
    ]);
  });

  it.each(['viewer', 'buyer'])('does not let a %s record movements', async (role) => {
    await post(`${role}-token-0123456789`, 'po-1001-line-1').expect(403);
    expect(inventory.recordMovement).not.toHaveBeenCalled();
  });
});

describe('0004_inventory_events migration', () => {
  let sql: string;

  beforeAll(async () => {
    sql = await readFile(join(__dirname, '..', 'migrations', '0004_inventory_events.sql'), 'utf8');
  });

  it('makes the ledger append-only', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON inventory_events\s+FOR EACH ROW/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON inventory_events/);
  });

  it('keeps references inside the organization and keys unique per organization', () => {
    expect(sql).toContain('UNIQUE (organization_id, idempotency_key)');
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, sku_id\)\s+REFERENCES skus \(organization_id, id\)/);
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, warehouse_id\)\s+REFERENCES warehouses \(organization_id, id\)/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, corrects_event_id\)\s+REFERENCES inventory_events \(organization_id, id\)/,
    );
  });
});
