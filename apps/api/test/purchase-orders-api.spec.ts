import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import type { Role } from '../src/auth/roles';
import { TenantGuard } from '../src/auth/tenant.guard';
import { UnknownReferenceError } from '../src/catalog/catalog.repository';
import { configureApp } from '../src/http/configure-app';
import { PurchasingController } from '../src/purchasing/purchasing.controller';
import type {
  NewPurchaseOrder,
  NewPurchaseOrderLine,
  PurchaseOrder,
  PurchaseOrderQuery,
  PurchaseOrderStatus,
} from '../src/purchasing/purchasing.models';
import {
  PurchaseOrderNotEditableError,
  PurchasingRepository,
} from '../src/purchasing/purchasing.repository';

const ORG_NORTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const ORG_SOUTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000002';

type Tenant = 'north' | 'south';

const USERS: Record<string, { token: string; userId: string; organizationId: string; role: Role }> =
  {
    'north-viewer': {
      token: 'north-viewer-token-0123456789',
      userId: 'u-north-viewer',
      organizationId: ORG_NORTH,
      role: 'viewer',
    },
    'north-buyer': {
      token: 'north-buyer-token-0123456789',
      userId: 'u-north-buyer',
      organizationId: ORG_NORTH,
      role: 'buyer',
    },
    'south-buyer': {
      token: 'south-buyer-token-0123456789',
      userId: 'u-south-buyer',
      organizationId: ORG_SOUTH,
      role: 'buyer',
    },
  };

function fakeAuthRepository() {
  const users = Object.values(USERS);
  return {
    findUserIdByToken: jest.fn(
      async (token: string) => users.find((u) => u.token === token)?.userId ?? null,
    ),
    findRole: jest.fn(async (userId: string, organizationId: string) => {
      const user = users.find((u) => u.userId === userId);
      return user && user.organizationId === organizationId ? user.role : null;
    }),
    listMemberships: jest.fn(async () => []),
  };
}

interface CatalogItem {
  id: string;
  organizationId: string;
  code: string;
  name: string;
}

interface SkuItem extends CatalogItem {
  unit: string;
  unitCostCents: number;
}

/** Synthetic catalog: one supplier, one warehouse and two SKUs per tenant. */
function catalogFor(organizationId: string, prefix: string) {
  const item = (code: string, name: string): CatalogItem => ({
    id: randomUUID(),
    organizationId,
    code: `${prefix}-${code}`,
    name,
  });
  return {
    supplier: item('ACME', 'Acme Packaging'),
    warehouse: item('WH1', 'Main warehouse'),
    skus: [
      { ...item('BOX-S', 'Corrugated box, small'), unit: 'each', unitCostCents: 85 },
      { ...item('TAPE', 'Packing tape 50 m'), unit: 'roll', unitCostCents: 240 },
    ] as SkuItem[],
  };
}

/**
 * In-memory stand-in for PurchasingRepository with the same contract:
 * per-organization numbering, references must be in the caller's
 * organization, unit cost defaults to the SKU's cost, and only drafts can
 * have their lines replaced.
 */
function fakePurchasing(catalogs: ReturnType<typeof catalogFor>[]) {
  const orders: PurchaseOrder[] = [];
  const counters = new Map<string, number>();
  let clock = Date.parse('2026-11-23T09:00:00.000Z');

  const catalog = (org: string) => catalogs.find((c) => c.supplier.organizationId === org);

  const buildLines = (org: string, lines: NewPurchaseOrderLine[]) =>
    lines.map((line, index) => {
      const sku = catalog(org)?.skus.find((s) => s.id === line.skuId);
      if (!sku) throw new UnknownReferenceError(`lines[${index}].skuId`);
      const unitCostCents = line.unitCostCents ?? sku.unitCostCents;
      return {
        id: randomUUID(),
        lineNumber: index + 1,
        skuId: sku.id,
        skuCode: sku.code,
        skuName: sku.name,
        unit: sku.unit,
        quantityOrdered: line.quantity,
        quantityReceived: 0,
        quantityOutstanding: line.quantity,
        unitCostCents,
        lineTotalCents: line.quantity * unitCostCents,
      };
    });

  const withTotals = (order: PurchaseOrder): PurchaseOrder => ({
    ...order,
    lineCount: order.lines.length,
    totalUnits: order.lines.reduce((sum, l) => sum + l.quantityOrdered, 0),
    totalCents: order.lines.reduce((sum, l) => sum + l.lineTotalCents, 0),
  });

  return {
    orders,
    setStatus(id: string, status: PurchaseOrderStatus) {
      const order = orders.find((o) => o.id === id) as PurchaseOrder;
      order.status = status;
    },
    listOrders: jest.fn(async (org: string, query: PurchaseOrderQuery) => {
      const matches = orders
        .filter(
          (o) =>
            o.organizationId === org &&
            (!query.status || o.status === query.status) &&
            (!query.supplierId || o.supplierId === query.supplierId) &&
            (!query.warehouseId || o.warehouseId === query.warehouseId),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ lines: _lines, ...summary }) => summary);
      const page = matches.slice(query.offset, query.offset + query.limit + 1);
      return { orders: page.slice(0, query.limit), hasMore: page.length > query.limit };
    }),
    findOrder: jest.fn(
      async (org: string, id: string) =>
        orders.find((o) => o.organizationId === org && o.id === id) ?? null,
    ),
    createOrder: jest.fn(async (org: string, userId: string, input: NewPurchaseOrder) => {
      const c = catalog(org);
      if (!c || c.supplier.id !== input.supplierId) throw new UnknownReferenceError('supplierId');
      if (c.warehouse.id !== input.warehouseId) throw new UnknownReferenceError('warehouseId');
      const lines = buildLines(org, input.lines);
      const next = (counters.get(org) ?? 0) + 1;
      counters.set(org, next);
      const now = new Date((clock += 60_000)).toISOString();
      const order = withTotals({
        id: randomUUID(),
        organizationId: org,
        number: `PO-${String(next).padStart(6, '0')}`,
        status: 'draft',
        supplierId: c.supplier.id,
        supplierCode: c.supplier.code,
        supplierName: c.supplier.name,
        warehouseId: c.warehouse.id,
        warehouseCode: c.warehouse.code,
        warehouseName: c.warehouse.name,
        expectedOn: input.expectedOn,
        notes: input.notes,
        createdBy: userId,
        submittedBy: null,
        submittedAt: null,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        lineCount: 0,
        totalUnits: 0,
        totalUnitsReceived: 0,
        totalCents: 0,
        createdAt: now,
        updatedAt: now,
        lines,
      });
      orders.push(order);
      return order;
    }),
    replaceLines: jest.fn(async (org: string, id: string, lines: NewPurchaseOrderLine[]) => {
      const index = orders.findIndex((o) => o.organizationId === org && o.id === id);
      if (index < 0) return null;
      if (orders[index].status !== 'draft') {
        throw new PurchaseOrderNotEditableError(orders[index].status);
      }
      orders[index] = withTotals({
        ...orders[index],
        lines: buildLines(org, lines),
        updatedAt: new Date((clock += 60_000)).toISOString(),
      });
      return orders[index];
    }),
  };
}

describe('purchase orders API', () => {
  let app: INestApplication;
  let purchasing: ReturnType<typeof fakePurchasing>;
  const north = catalogFor(ORG_NORTH, 'N');
  const south = catalogFor(ORG_SOUTH, 'S');
  const [box, tape] = north.skus;

  beforeEach(async () => {
    purchasing = fakePurchasing([north, south]);
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

  const url = (org: string, rest = '') => `/v1/organizations/${org}/purchase-orders${rest}`;
  const auth = (tenant: Tenant, role: Role) => ({
    Authorization: `Bearer ${USERS[`${tenant}-${role}`].token}`,
  });
  const server = () => request(app.getHttpServer());

  const draftBody = {
    supplierId: north.supplier.id,
    warehouseId: north.warehouse.id,
    expectedOn: '2026-12-04',
    lines: [
      { skuId: box.id, quantity: 400 },
      { skuId: tape.id, quantity: 24, unitCostCents: 225 },
    ],
  };

  const createDraft = (body: object = draftBody) =>
    server().post(url(ORG_NORTH)).set(auth('north', 'buyer')).send(body);

  describe('creating a draft', () => {
    it('numbers the order, prices lines from the catalog unless given, and totals them', async () => {
      const res = await createDraft().expect(201);
      expect(res.body.data).toMatchObject({
        organizationId: ORG_NORTH,
        number: 'PO-000001',
        status: 'draft',
        supplierCode: 'N-ACME',
        warehouseCode: 'N-WH1',
        expectedOn: '2026-12-04',
        notes: null,
        createdBy: 'u-north-buyer',
        lineCount: 2,
        totalUnits: 424,
        totalCents: 400 * 85 + 24 * 225,
      });
      expect(res.body.data.lines).toEqual([
        expect.objectContaining({
          lineNumber: 1,
          skuCode: 'N-BOX-S',
          unitCostCents: 85,
          lineTotalCents: 34_000,
        }),
        expect.objectContaining({
          lineNumber: 2,
          skuCode: 'N-TAPE',
          unitCostCents: 225,
          lineTotalCents: 5_400,
        }),
      ]);

      const second = await createDraft().expect(201);
      expect(second.body.data.number).toBe('PO-000002');
    });

    it('reads the draft back by id and lists it', async () => {
      const created = await createDraft().expect(201);
      const id = created.body.data.id;

      const one = await server()
        .get(url(ORG_NORTH, `/${id}`))
        .set(auth('north', 'viewer'))
        .expect(200);
      expect(one.body).toEqual({ data: created.body.data });

      const list = await server().get(url(ORG_NORTH)).set(auth('north', 'viewer')).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).not.toHaveProperty('lines');
      expect(list.body.data[0]).toMatchObject({ id, lineCount: 2, totalUnits: 424 });
      expect(list.body.page).toEqual({
        status: null,
        supplierId: null,
        warehouseId: null,
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    });

    it('returns 422 with the field for invalid input and touches nothing', async () => {
      const res = await createDraft({ ...draftBody, lines: [{ skuId: box.id, quantity: -2 }] })
        .expect(422);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.details).toEqual([
        { field: 'lines[0].quantity', message: 'must be a whole number from 1 to 1000000' },
      ]);
      expect(purchasing.createOrder).not.toHaveBeenCalled();
    });

    it("refuses another organization's supplier, warehouse or SKU with 422", async () => {
      const cases: [object, string][] = [
        [{ ...draftBody, supplierId: south.supplier.id }, 'supplierId'],
        [{ ...draftBody, warehouseId: south.warehouse.id }, 'warehouseId'],
        [
          { ...draftBody, lines: [draftBody.lines[0], { skuId: south.skus[0].id, quantity: 1 }] },
          'lines[1].skuId',
        ],
      ];
      for (const [body, field] of cases) {
        const res = await createDraft(body).expect(422);
        expect(res.body.error.details).toEqual([
          expect.objectContaining({ field, message: expect.stringMatching(/in this organization$/) }),
        ]);
      }
      expect(purchasing.orders).toHaveLength(0);
    });
  });

  describe('roles and tenants', () => {
    it('lets a viewer read but not create or edit', async () => {
      await server().get(url(ORG_NORTH)).set(auth('north', 'viewer')).expect(200);
      const res = await server()
        .post(url(ORG_NORTH))
        .set(auth('north', 'viewer'))
        .send(draftBody)
        .expect(403);
      expect(res.body.error.code).toBe('forbidden');

      const created = await createDraft().expect(201);
      await server()
        .put(url(ORG_NORTH, `/${created.body.data.id}/lines`))
        .set(auth('north', 'viewer'))
        .send({ lines: draftBody.lines })
        .expect(403);
    });

    it('keeps orders invisible to other organizations, even with a known id', async () => {
      const created = await createDraft().expect(201);
      const id = created.body.data.id;

      await server().get(url(ORG_NORTH)).set(auth('south', 'buyer')).expect(403);

      const res = await server()
        .get(url(ORG_SOUTH, `/${id}`))
        .set(auth('south', 'buyer'))
        .expect(404);
      expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Purchase order not found' });
      await server()
        .put(url(ORG_SOUTH, `/${id}/lines`))
        .set(auth('south', 'buyer'))
        .send({ lines: [{ skuId: south.skus[0].id, quantity: 1 }] })
        .expect(404);

      const list = await server().get(url(ORG_SOUTH)).set(auth('south', 'buyer')).expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('numbers each organization separately', async () => {
      await createDraft().expect(201);
      const res = await server()
        .post(url(ORG_SOUTH))
        .set(auth('south', 'buyer'))
        .send({
          supplierId: south.supplier.id,
          warehouseId: south.warehouse.id,
          lines: [{ skuId: south.skus[1].id, quantity: 5 }],
        })
        .expect(201);
      expect(res.body.data.number).toBe('PO-000001');
    });

    it('answers 404 for a malformed id without querying', async () => {
      await server().get(url(ORG_NORTH, '/not-a-uuid')).set(auth('north', 'viewer')).expect(404);
      expect(purchasing.findOrder).not.toHaveBeenCalled();
    });
  });

  describe('editing lines', () => {
    it('replaces all lines of a draft and recomputes totals', async () => {
      const created = await createDraft().expect(201);
      const res = await server()
        .put(url(ORG_NORTH, `/${created.body.data.id}/lines`))
        .set(auth('north', 'buyer'))
        .send({ lines: [{ skuId: tape.id, quantity: 10 }] })
        .expect(200);
      expect(res.body.data).toMatchObject({ lineCount: 1, totalUnits: 10, totalCents: 2_400 });
      expect(res.body.data.lines).toEqual([
        expect.objectContaining({ lineNumber: 1, skuId: tape.id, unitCostCents: 240 }),
      ]);
    });

    it('refuses to change lines once the order left draft', async () => {
      const created = await createDraft().expect(201);
      purchasing.setStatus(created.body.data.id, 'submitted');
      const res = await server()
        .put(url(ORG_NORTH, `/${created.body.data.id}/lines`))
        .set(auth('north', 'buyer'))
        .send({ lines: [{ skuId: tape.id, quantity: 10 }] })
        .expect(409);
      expect(res.body.error.code).toBe('purchase_order_not_editable');
    });
  });

  describe('listing', () => {
    it('filters by status and pages newest first', async () => {
      const first = await createDraft().expect(201);
      const second = await createDraft().expect(201);
      const third = await createDraft().expect(201);
      purchasing.setStatus(first.body.data.id, 'cancelled');

      const drafts = await server()
        .get(url(ORG_NORTH))
        .query({ status: 'draft', limit: '1' })
        .set(auth('north', 'viewer'))
        .expect(200);
      expect(drafts.body.data.map((o: { id: string }) => o.id)).toEqual([third.body.data.id]);
      expect(drafts.body.page).toMatchObject({ status: 'draft', limit: 1, hasMore: true });

      const next = await server()
        .get(url(ORG_NORTH))
        .query({ status: 'draft', limit: '1', offset: '1' })
        .set(auth('north', 'viewer'))
        .expect(200);
      expect(next.body.data.map((o: { id: string }) => o.id)).toEqual([second.body.data.id]);
      expect(next.body.page.hasMore).toBe(false);
    });

    it('rejects an unknown status filter', async () => {
      const res = await server()
        .get(url(ORG_NORTH))
        .query({ status: 'open' })
        .set(auth('north', 'viewer'))
        .expect(422);
      expect(res.body.error.details[0].field).toBe('status');
    });
  });
});
