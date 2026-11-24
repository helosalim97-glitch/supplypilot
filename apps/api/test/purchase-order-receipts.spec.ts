import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import type { Role } from '../src/auth/roles';
import { TenantGuard } from '../src/auth/tenant.guard';
import { configureApp } from '../src/http/configure-app';
import { IdempotencyConflictError } from '../src/inventory/inventory.repository';
import { PurchasingController } from '../src/purchasing/purchasing.controller';
import type {
  NewReceipt,
  PurchaseOrder,
  PurchaseOrderStatus,
  Receipt,
} from '../src/purchasing/purchasing.models';
import { PurchasingRepository } from '../src/purchasing/purchasing.repository';
import { planReceipt, receiptHash } from '../src/purchasing/receiving';

const ORG_NORTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const ORG_SOUTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000002';

const USERS: Record<string, { token: string; organizationId: string; role: Role }> = {
  'u-north-viewer': {
    token: 'north-viewer-token-0123456789',
    organizationId: ORG_NORTH,
    role: 'viewer',
  },
  'u-north-buyer': {
    token: 'north-buyer-token-0123456789',
    organizationId: ORG_NORTH,
    role: 'buyer',
  },
  'u-south-manager': {
    token: 'south-manager-token-01234567',
    organizationId: ORG_SOUTH,
    role: 'manager',
  },
};

function fakeAuthRepository() {
  const entries = Object.entries(USERS);
  return {
    findUserIdByToken: jest.fn(
      async (token: string) => entries.find(([, u]) => u.token === token)?.[0] ?? null,
    ),
    findRole: jest.fn(async (userId: string, organizationId: string) => {
      const user = USERS[userId];
      return user && user.organizationId === organizationId ? user.role : null;
    }),
    listMemberships: jest.fn(async () => []),
  };
}

/**
 * In-memory stand-in for the receiving part of PurchasingRepository, built on
 * the real planReceipt and receiptHash so the HTTP specs follow the same rules.
 */
function fakePurchasing() {
  const orders: PurchaseOrder[] = [];
  const receipts: (Receipt & { organizationId: string; key: string; hash: string })[] = [];
  const stock = new Map<string, number>();
  const find = (org: string, id: string) =>
    orders.find((o) => o.organizationId === org && o.id === id);

  const line = (lineNumber: number, quantityOrdered: number) => ({
    id: randomUUID(),
    lineNumber,
    skuId: randomUUID(),
    skuCode: `SKU-${lineNumber}`,
    skuName: `Synthetic SKU ${lineNumber}`,
    unit: 'each',
    quantityOrdered,
    quantityReceived: 0,
    quantityOutstanding: quantityOrdered,
    unitCostCents: 100,
    lineTotalCents: quantityOrdered * 100,
  });

  return {
    stock,
    seedOrder(org: string, status: PurchaseOrderStatus = 'approved'): PurchaseOrder {
      const lines = [line(1, 400), line(2, 24)];
      const order: PurchaseOrder = {
        id: randomUUID(),
        organizationId: org,
        number: `PO-${String(orders.length + 1).padStart(6, '0')}`,
        status,
        supplierId: randomUUID(),
        supplierCode: 'ACME',
        supplierName: 'Acme Packaging',
        warehouseId: randomUUID(),
        warehouseCode: 'WH1',
        warehouseName: 'Main warehouse',
        expectedOn: null,
        notes: null,
        createdBy: 'u-north-buyer',
        submittedBy: 'u-north-buyer',
        submittedAt: '2026-11-24T08:00:00.000Z',
        decidedBy: 'u-north-manager',
        decidedAt: '2026-11-24T08:30:00.000Z',
        decisionReason: null,
        lineCount: 2,
        totalUnits: 424,
        totalUnitsReceived: 0,
        totalCents: 42_400,
        createdAt: '2026-11-24T07:00:00.000Z',
        updatedAt: '2026-11-24T08:30:00.000Z',
        lines,
      };
      orders.push(order);
      return order;
    },
    receive: jest.fn(
      async (org: string, id: string, actorId: string, key: string, input: NewReceipt) => {
        const order = find(org, id);
        if (!order) return null;
        const hash = receiptHash(id, input);
        const previous = receipts.find((r) => r.organizationId === org && r.key === key);
        if (previous) {
          if (previous.hash !== hash) throw new IdempotencyConflictError(key);
          return { receipt: previous, order: { ...order }, replayed: true };
        }
        const plan = planReceipt(order.status, order.lines, input.lines);
        for (const { line: planned, quantity } of plan.lines) {
          const target = order.lines.find((l) => l.id === planned.id)!;
          target.quantityReceived += quantity;
          target.quantityOutstanding -= quantity;
          stock.set(target.skuId, (stock.get(target.skuId) ?? 0) + quantity);
        }
        order.status = plan.nextStatus;
        order.totalUnitsReceived += plan.units;
        const receipt = {
          organizationId: org,
          key,
          hash,
          id: randomUUID(),
          purchaseOrderId: id,
          reference: input.reference,
          notes: input.notes,
          receivedBy: actorId,
          receivedAt: input.receivedAt ?? '2026-11-24T10:00:00.000Z',
          recordedAt: '2026-11-24T10:00:00.000Z',
          lines: plan.lines.map(({ line: l, quantity }) => ({
            purchaseOrderLineId: l.id,
            lineNumber: l.lineNumber,
            skuId: l.skuId,
            skuCode: `SKU-${l.lineNumber}`,
            quantity,
            inventoryEventId: randomUUID(),
          })),
        };
        receipts.push(receipt);
        return { receipt, order: { ...order }, replayed: false };
      },
    ),
    listReceipts: jest.fn(async (org: string, id: string) =>
      find(org, id)
        ? receipts
            .filter((r) => r.organizationId === org && r.purchaseOrderId === id)
            .map(({ organizationId: _o, key: _k, hash: _h, ...r }) => r)
        : null,
    ),
  };
}

describe('purchase order receipts API', () => {
  let app: INestApplication;
  let purchasing: ReturnType<typeof fakePurchasing>;

  beforeEach(async () => {
    purchasing = fakePurchasing();
    const moduleRef = await Test.createTestingModule({
      controllers: [PurchasingController],
      providers: [
        TenantGuard,
        { provide: AuthRepository, useValue: fakeAuthRepository() },
        { provide: PurchasingRepository, useValue: purchasing },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const server = () => request(app.getHttpServer());
  const as = (userId: string) => ({ Authorization: `Bearer ${USERS[userId].token}` });
  const receive = (
    userId: string,
    id: string,
    body: object,
    key: string | null = 'delivery-dn-7781',
    org = USERS[userId].organizationId,
  ) => {
    const req = server()
      .post(`/v1/organizations/${org}/purchase-orders/${id}/receipts`)
      .set(as(userId));
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  };

  it('books a partial shipment, then the rest, and lists both receipts', async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    const [a, b] = order.lines;

    const first = await receive('u-north-buyer', order.id, {
      lines: [{ lineId: a.id, quantity: 250 }],
      reference: 'DN-7781',
    }).expect(201);
    expect(first.headers['idempotent-replayed']).toBe('false');
    expect(first.body.data.order).toMatchObject({ status: 'partially_received', totalUnitsReceived: 250 });
    expect(first.body.data.order.lines[0]).toMatchObject({
      quantityReceived: 250,
      quantityOutstanding: 150,
    });
    expect(first.body.data.receipt).toMatchObject({
      reference: 'DN-7781',
      receivedBy: 'u-north-buyer',
      lines: [{ purchaseOrderLineId: a.id, lineNumber: 1, quantity: 250 }],
    });

    const second = await receive(
      'u-north-buyer',
      order.id,
      { lines: [{ lineId: a.id, quantity: 150 }, { lineId: b.id, quantity: 24 }] },
      'delivery-dn-7790',
    ).expect(201);
    expect(second.body.data.order).toMatchObject({ status: 'received', totalUnitsReceived: 424 });

    const list = await server()
      .get(`/v1/organizations/${ORG_NORTH}/purchase-orders/${order.id}/receipts`)
      .set(as('u-north-viewer'))
      .expect(200);
    expect(list.body.data.map((r: Receipt) => r.lines.length)).toEqual([1, 2]);
  });

  it('replays a retried delivery instead of adding stock twice', async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    const body = { lines: [{ lineId: order.lines[0].id, quantity: 100 }] };

    const first = await receive('u-north-buyer', order.id, body).expect(201);
    const retry = await receive('u-north-buyer', order.id, body).expect(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.receipt.id).toBe(first.body.data.receipt.id);
    expect(purchasing.stock.get(order.lines[0].skuId)).toBe(100);
  });

  it('refuses the same key for a different delivery', async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    await receive('u-north-buyer', order.id, {
      lines: [{ lineId: order.lines[0].id, quantity: 100 }],
    }).expect(201);
    const res = await receive('u-north-buyer', order.id, {
      lines: [{ lineId: order.lines[0].id, quantity: 101 }],
    }).expect(409);
    expect(res.body.error.code).toBe('idempotency_conflict');
  });

  it('refuses more than is outstanding with 409 over_receipt', async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    const res = await receive('u-north-buyer', order.id, {
      lines: [{ lineId: order.lines[1].id, quantity: 25 }],
    }).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'over_receipt',
      details: [{ field: 'lines[0].quantity', message: 'is more than the 24 unit(s) still outstanding' }],
    });
    expect(purchasing.stock.size).toBe(0);
  });

  it.each(['draft', 'submitted', 'rejected', 'cancelled', 'received'] as const)(
    'refuses a delivery for a %s order',
    async (status) => {
      const order = purchasing.seedOrder(ORG_NORTH, status);
      const res = await receive('u-north-buyer', order.id, {
        lines: [{ lineId: order.lines[0].id, quantity: 1 }],
      }).expect(409);
      expect(res.body.error.code).toBe('purchase_order_not_receivable');
    },
  );

  it('rejects a line of another order with 422', async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    const other = purchasing.seedOrder(ORG_NORTH);
    const res = await receive('u-north-buyer', order.id, {
      lines: [{ lineId: other.lines[0].id, quantity: 1 }],
    }).expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'lines[0].lineId', message: 'is not a line of this purchase order' },
    ]);
  });

  it('requires an Idempotency-Key and a valid body', async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    const noKey = await receive('u-north-buyer', order.id, { lines: [] }, null).expect(422);
    expect(noKey.body.error.details[0].field).toBe('Idempotency-Key');
    const badBody = await receive('u-north-buyer', order.id, { lines: [] }).expect(422);
    expect(badBody.body.error.details).toEqual([
      { field: 'lines', message: 'must be an array of 1 to 200 lines' },
    ]);
    expect(purchasing.receive).not.toHaveBeenCalled();
  });

  it('lets viewers read receipts but not book them', async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    await receive('u-north-viewer', order.id, {
      lines: [{ lineId: order.lines[0].id, quantity: 1 }],
    }).expect(403);
    await server()
      .get(`/v1/organizations/${ORG_NORTH}/purchase-orders/${order.id}/receipts`)
      .set(as('u-north-viewer'))
      .expect(200);
  });

  it("hides another tenant's orders behind 404", async () => {
    const order = purchasing.seedOrder(ORG_NORTH);
    await receive('u-south-manager', order.id, {
      lines: [{ lineId: order.lines[0].id, quantity: 1 }],
    }).expect(404);
    await server()
      .get(`/v1/organizations/${ORG_SOUTH}/purchase-orders/${order.id}/receipts`)
      .set(as('u-south-manager'))
      .expect(404);
    await server()
      .get(`/v1/organizations/${ORG_NORTH}/purchase-orders/not-a-uuid/receipts`)
      .set(as('u-north-viewer'))
      .expect(404);
  });
});
