import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import type { Role } from '../src/auth/roles';
import { TenantGuard } from '../src/auth/tenant.guard';
import { CatalogController } from '../src/catalog/catalog.controller';
import type {
  NewSku,
  NewSupplier,
  NewWarehouse,
  Sku,
  Supplier,
  Warehouse,
} from '../src/catalog/catalog.models';
import {
  CatalogRepository,
  DuplicateCodeError,
  UnknownReferenceError,
  type CatalogEntity,
} from '../src/catalog/catalog.repository';
import { configureApp } from '../src/http/configure-app';

const ORG_NORTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const ORG_SOUTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000002';

type Tenant = 'north' | 'south';

interface User {
  token: string;
  userId: string;
  organizationId: string;
  role: Role;
}

const USERS: Record<string, User> = {
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
  'north-manager': {
    token: 'north-manager-token-0123456789',
    userId: 'u-north-manager',
    organizationId: ORG_NORTH,
    role: 'manager',
  },
  'south-manager': {
    token: 'south-manager-token-0123456789',
    userId: 'u-south-manager',
    organizationId: ORG_SOUTH,
    role: 'manager',
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

type Scoped = { id: string; organizationId: string; code: string };

/**
 * In-memory stand-in for CatalogRepository with the same contract: rows are
 * scoped by organization, codes are unique per organization ignoring case,
 * and a preferred supplier must exist in the same organization.
 */
function fakeCatalog() {
  const suppliers: Supplier[] = [];
  const warehouses: Warehouse[] = [];
  const skus: Sku[] = [];
  const now = '2026-11-17T12:00:00.000Z';

  const stamp = (organizationId: string) => ({
    id: randomUUID(),
    organizationId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const insert = <T extends Scoped>(rows: T[], entity: CatalogEntity, row: T): T => {
    const code = row.code.toLowerCase();
    if (rows.some((r) => r.organizationId === row.organizationId && r.code.toLowerCase() === code)) {
      throw new DuplicateCodeError(entity, row.code);
    }
    rows.push(row);
    return row;
  };

  const list =
    <T extends Scoped>(rows: T[]) =>
    async (organizationId: string) =>
      rows.filter((r) => r.organizationId === organizationId);

  const find =
    <T extends Scoped>(rows: T[]) =>
    async (organizationId: string, id: string) =>
      rows.find((r) => r.organizationId === organizationId && r.id === id) ?? null;

  return {
    listSuppliers: jest.fn(list(suppliers)),
    findSupplier: jest.fn(find(suppliers)),
    createSupplier: jest.fn(async (org: string, input: NewSupplier) =>
      insert(suppliers, 'supplier', {
        ...stamp(org),
        code: input.code,
        name: input.name,
        contactEmail: input.contactEmail ?? null,
      }),
    ),
    listWarehouses: jest.fn(list(warehouses)),
    findWarehouse: jest.fn(find(warehouses)),
    createWarehouse: jest.fn(async (org: string, input: NewWarehouse) =>
      insert(warehouses, 'warehouse', { ...stamp(org), code: input.code, name: input.name }),
    ),
    listSkus: jest.fn(list(skus)),
    findSku: jest.fn(find(skus)),
    createSku: jest.fn(async (org: string, input: NewSku) => {
      const supplierId = input.preferredSupplierId ?? null;
      if (supplierId && !suppliers.some((s) => s.organizationId === org && s.id === supplierId)) {
        throw new UnknownReferenceError('preferredSupplierId');
      }
      return insert(skus, 'sku', {
        ...stamp(org),
        code: input.code,
        name: input.name,
        unit: input.unit,
        unitCostCents: input.unitCostCents,
        reorderPoint: input.reorderPoint ?? 0,
        preferredSupplierId: supplierId,
      });
    }),
  };
}

const fields = (body: { error: { details: { field: string }[] } }) =>
  body.error.details.map((d) => d.field);

describe('catalog API', () => {
  let app: INestApplication;
  let catalog: ReturnType<typeof fakeCatalog>;

  beforeEach(async () => {
    catalog = fakeCatalog();
    const moduleRef = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [
        TenantGuard,
        { provide: AuthRepository, useValue: fakeAuthRepository() },
        { provide: CatalogRepository, useValue: catalog },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const url = (org: string, rest: string) => `/v1/organizations/${org}/${rest}`;
  const bearer = (tenant: Tenant, role: Role) => ({
    Authorization: `Bearer ${USERS[`${tenant}-${role}`].token}`,
  });

  const get = (org: string, rest: string, tenant: Tenant, role: Role) =>
    request(app.getHttpServer()).get(url(org, rest)).set(bearer(tenant, role));

  const post = (org: string, rest: string, body: unknown, tenant: Tenant, role: Role) =>
    request(app.getHttpServer())
      .post(url(org, rest))
      .set(bearer(tenant, role))
      .send(body as object);

  const asNorthManager = (rest: string, body: unknown) =>
    post(ORG_NORTH, rest, body, 'north', 'manager');

  const validSku = { code: 'SKU-001', name: 'Oat milk 1L', unit: 'each', unitCostCents: 189 };

  describe('happy path', () => {
    it('creates and reads back suppliers, warehouses and SKUs', async () => {
      const supplier = await asNorthManager('suppliers', {
        code: 'ACME',
        name: '  Acme Foods ',
        contactEmail: 'orders@acme.test',
      }).expect(201);
      expect(supplier.body.data).toMatchObject({
        code: 'ACME',
        name: 'Acme Foods',
        contactEmail: 'orders@acme.test',
        organizationId: ORG_NORTH,
      });

      await asNorthManager('warehouses', { code: 'WH-1', name: 'Main warehouse' }).expect(201);

      const supplierId = supplier.body.data.id;
      const sku = await asNorthManager('skus', { ...validSku, preferredSupplierId: supplierId })
        .expect(201);
      expect(sku.body.data).toMatchObject({
        ...validSku,
        reorderPoint: 0,
        preferredSupplierId: supplierId,
      });

      const list = await get(ORG_NORTH, 'skus', 'north', 'viewer').expect(200);
      expect(list.body).toEqual({ data: [sku.body.data] });

      const one = await get(ORG_NORTH, `skus/${sku.body.data.id}`, 'north', 'viewer').expect(200);
      expect(one.body).toEqual({ data: sku.body.data });

      const warehouses = await get(ORG_NORTH, 'warehouses', 'north', 'viewer').expect(200);
      expect(warehouses.body.data).toHaveLength(1);
    });
  });

  describe('roles and tenants', () => {
    it.each(['viewer', 'buyer'] as const)('a %s can read but not create', async (role) => {
      await get(ORG_NORTH, 'suppliers', 'north', role).expect(200);
      const res = await post(ORG_NORTH, 'suppliers', { code: 'ACME', name: 'Acme' }, 'north', role)
        .expect(403);
      expect(res.body.error.code).toBe('forbidden');
      expect(catalog.createSupplier).not.toHaveBeenCalled();
    });

    it('does not let a manager of another organization in', async () => {
      await post(ORG_NORTH, 'suppliers', { code: 'ACME', name: 'Acme' }, 'south', 'manager')
        .expect(403);
      await get(ORG_NORTH, 'skus', 'south', 'manager').expect(403);
    });

    it('keeps records invisible across tenants even with a known id', async () => {
      const created = await asNorthManager('skus', validSku).expect(201);

      const res = await get(ORG_SOUTH, `skus/${created.body.data.id}`, 'south', 'manager')
        .expect(404);
      expect(res.body.error).toMatchObject({ code: 'not_found', message: 'SKU not found' });

      const list = await get(ORG_SOUTH, 'skus', 'south', 'manager').expect(200);
      expect(list.body).toEqual({ data: [] });
    });

    it('lets two organizations use the same code', async () => {
      await asNorthManager('suppliers', { code: 'ACME', name: 'Acme' }).expect(201);
      await post(ORG_SOUTH, 'suppliers', { code: 'ACME', name: 'Acme' }, 'south', 'manager')
        .expect(201);
    });
  });

  describe('validation (422)', () => {
    it('lists every invalid field and never reaches the repository', async () => {
      const res = await asNorthManager('skus', {
        code: '-bad',
        name: '   ',
        unit: 'Each',
        unitCostCents: 1.5,
        reorderPoint: -1,
        preferredSupplierId: 'not-a-uuid',
      }).expect(422);

      expect(res.body.error.code).toBe('validation_failed');
      expect(fields(res.body)).toEqual([
        'code',
        'name',
        'unit',
        'unitCostCents',
        'reorderPoint',
        'preferredSupplierId',
      ]);
      expect(catalog.createSku).not.toHaveBeenCalled();
    });

    it('requires the mandatory fields', async () => {
      const res = await asNorthManager('skus', {}).expect(422);
      expect(fields(res.body)).toEqual(['code', 'name', 'unit', 'unitCostCents']);
    });

    it('rejects unknown fields', async () => {
      const res = await asNorthManager('suppliers', { code: 'ACME', name: 'Acme', phone: '555' })
        .expect(422);
      expect(res.body.error.details).toEqual([
        { field: 'phone', message: 'is not an allowed field' },
      ]);
    });

    it('rejects a body that is not an object', async () => {
      const res = await asNorthManager('suppliers', [{ code: 'ACME' }]).expect(422);
      expect(res.body.error.details).toEqual([{ field: 'body', message: 'must be a JSON object' }]);
    });

    it('rejects an invalid email and an over-long name', async () => {
      const res = await asNorthManager('suppliers', {
        code: 'ACME',
        name: 'x'.repeat(121),
        contactEmail: 'not-an-email',
      }).expect(422);
      expect(fields(res.body)).toEqual(['name', 'contactEmail']);
    });

    it('rejects costs that do not fit an integer column', async () => {
      const res = await asNorthManager('skus', { ...validSku, unitCostCents: 2_147_483_648 })
        .expect(422);
      expect(fields(res.body)).toEqual(['unitCostCents']);
    });

    it('rejects a preferred supplier from another organization', async () => {
      const south = await post(
        ORG_SOUTH,
        'suppliers',
        { code: 'SOUTHCO', name: 'South Co' },
        'south',
        'manager',
      ).expect(201);

      const res = await asNorthManager('skus', {
        ...validSku,
        preferredSupplierId: south.body.data.id,
      }).expect(422);
      expect(res.body.error.details).toEqual([
        { field: 'preferredSupplierId', message: 'does not exist in this organization' },
      ]);
    });
  });

  describe('conflicts and lookups', () => {
    it('returns 409 for a duplicate code, ignoring case', async () => {
      await asNorthManager('suppliers', { code: 'ACME', name: 'Acme' }).expect(201);
      const res = await asNorthManager('suppliers', { code: 'acme', name: 'Acme again' })
        .expect(409);
      expect(res.body.error).toMatchObject({
        code: 'duplicate_code',
        details: [{ field: 'code', message: 'is already used in this organization' }],
      });
    });

    it('returns 404 for a malformed id without querying', async () => {
      const res = await get(ORG_NORTH, 'warehouses/not-a-uuid', 'north', 'viewer').expect(404);
      expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Warehouse not found' });
      expect(catalog.findWarehouse).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown id', async () => {
      await get(ORG_NORTH, `suppliers/${randomUUID()}`, 'north', 'viewer').expect(404);
    });
  });

  describe('error envelope', () => {
    it('wraps a 401 and echoes a safe caller request id', async () => {
      const res = await request(app.getHttpServer())
        .get(url(ORG_NORTH, 'skus'))
        .set('X-Request-Id', 'req-test-0001')
        .expect(401);

      expect(res.headers['x-request-id']).toBe('req-test-0001');
      expect(res.body).toEqual({
        error: {
          code: 'unauthorized',
          message: 'A valid bearer token is required',
          requestId: 'req-test-0001',
        },
      });
    });

    it('generates a request id when the caller sends an unsafe one', async () => {
      const res = await request(app.getHttpServer())
        .get(url(ORG_NORTH, 'skus'))
        .set('X-Request-Id', 'bad id with spaces')
        .expect(401);

      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    });

    it('hides unexpected errors behind a generic 500', async () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      catalog.listSkus.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED postgres://supplypilot:secret@db:5432'),
      );

      const res = await get(ORG_NORTH, 'skus', 'north', 'viewer').expect(500);

      expect(res.body).toEqual({
        error: {
          code: 'internal_error',
          message: 'Internal server error',
          requestId: res.headers['x-request-id'],
        },
      });
      expect(JSON.stringify(res.body)).not.toContain('secret');
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });
  });
});
