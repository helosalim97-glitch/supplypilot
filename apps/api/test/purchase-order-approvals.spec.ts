import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import type { Role } from '../src/auth/roles';
import { TenantGuard } from '../src/auth/tenant.guard';
import { configureApp } from '../src/http/configure-app';
import { PurchasingController } from '../src/purchasing/purchasing.controller';
import type { AuditEvent, PurchaseOrder } from '../src/purchasing/purchasing.models';
import {
  PurchasingRepository,
  type TransitionInput,
} from '../src/purchasing/purchasing.repository';
import { AUDIT_ACTION, planTransition } from '../src/purchasing/purchasing.state-machine';

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
  'u-north-buyer-2': {
    token: 'north-buyer2-token-012345678',
    organizationId: ORG_NORTH,
    role: 'buyer',
  },
  'u-north-manager': {
    token: 'north-manager-token-01234567',
    organizationId: ORG_NORTH,
    role: 'manager',
  },
  'u-north-owner': {
    token: 'north-owner-token-0123456789',
    organizationId: ORG_NORTH,
    role: 'owner',
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
 * In-memory stand-in for the approval part of PurchasingRepository. It uses
 * the real state machine, so these specs exercise the same rules the
 * repository applies inside its transaction.
 */
function fakePurchasing() {
  const orders: PurchaseOrder[] = [];
  const events: (AuditEvent & { organizationId: string })[] = [];
  let clock = Date.parse('2026-11-23T09:00:00.000Z');
  const tick = () => new Date((clock += 60_000)).toISOString();

  const find = (org: string, id: string) =>
    orders.find((o) => o.organizationId === org && o.id === id);

  return {
    orders,
    events,
    /** A draft as POST /purchase-orders would have created it. */
    seedDraft(org: string, createdBy = 'u-north-buyer'): PurchaseOrder {
      const now = tick();
      const order: PurchaseOrder = {
        id: randomUUID(),
        organizationId: org,
        number: `PO-${String(orders.length + 1).padStart(6, '0')}`,
        status: 'draft',
        supplierId: randomUUID(),
        supplierCode: 'ACME',
        supplierName: 'Acme Packaging',
        warehouseId: randomUUID(),
        warehouseCode: 'WH1',
        warehouseName: 'Main warehouse',
        expectedOn: null,
        notes: null,
        createdBy,
        submittedBy: null,
        submittedAt: null,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        lineCount: 1,
        totalUnits: 400,
        totalUnitsReceived: 0,
        totalCents: 34_000,
        createdAt: now,
        updatedAt: now,
        lines: [],
      };
      orders.push(order);
      return order;
    },
    findOrder: jest.fn(async (org: string, id: string) => find(org, id) ?? null),
    listEvents: jest.fn(async (org: string, id: string) =>
      find(org, id)
        ? events
            .filter((e) => e.organizationId === org && e.entityId === id)
            .map(({ organizationId: _org, ...event }) => event)
        : null,
    ),
    transition: jest.fn(async (org: string, id: string, input: TransitionInput) => {
      const order = find(org, id);
      if (!order) return null;
      const from = order.status;
      const to = planTransition({ ...input, from, submittedBy: order.submittedBy });
      const now = tick();
      order.status = to;
      order.updatedAt = now;
      if (input.action === 'submit') {
        Object.assign(order, {
          submittedBy: input.actorId,
          submittedAt: now,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
        });
      } else if (input.action === 'approve' || input.action === 'reject') {
        Object.assign(order, {
          decidedBy: input.actorId,
          decidedAt: now,
          decisionReason: input.reason,
        });
      } else if (input.action === 'reopen') {
        Object.assign(order, {
          submittedBy: null,
          submittedAt: null,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
        });
      }
      events.push({
        organizationId: org,
        id: randomUUID(),
        entityType: 'purchase_order',
        entityId: id,
        action: AUDIT_ACTION[input.action],
        actorId: input.actorId,
        fromStatus: from,
        toStatus: to,
        reason: input.reason,
        details: { number: order.number, lineCount: order.lineCount, totalCents: order.totalCents },
        occurredAt: now,
      });
      return { ...order };
    }),
  };
}

describe('purchase order approvals API', () => {
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
  const step = (
    userId: string,
    id: string,
    action: string,
    body: object = {},
    org = USERS[userId].organizationId,
  ) =>
    server()
      .post(`/v1/organizations/${org}/purchase-orders/${id}/${action}`)
      .set(as(userId))
      .send(body);
  const events = (userId: string, id: string, org = USERS[userId].organizationId) =>
    server().get(`/v1/organizations/${org}/purchase-orders/${id}/events`).set(as(userId));

  it('runs draft → submitted → approved and records who decided and why', async () => {
    const { id } = purchasing.seedDraft(ORG_NORTH);

    const submitted = await step('u-north-buyer', id, 'submit').expect(200);
    expect(submitted.body.data).toMatchObject({
      status: 'submitted',
      submittedBy: 'u-north-buyer',
      decidedBy: null,
    });

    const approved = await step('u-north-manager', id, 'approve', {
      reason: 'Covers the December demand spike',
    }).expect(200);
    expect(approved.body.data).toMatchObject({
      status: 'approved',
      submittedBy: 'u-north-buyer',
      decidedBy: 'u-north-manager',
      decisionReason: 'Covers the December demand spike',
    });
    expect(approved.body.data.decidedAt).toEqual(expect.any(String));

    const trail = await events('u-north-viewer', id).expect(200);
    expect(
      trail.body.data.map((e: AuditEvent) => [e.action, e.actorId, e.fromStatus, e.toStatus]),
    ).toEqual([
      ['purchase_order.submitted', 'u-north-buyer', 'draft', 'submitted'],
      ['purchase_order.approved', 'u-north-manager', 'submitted', 'approved'],
    ]);
    expect(trail.body.data[1]).toMatchObject({
      entityType: 'purchase_order',
      entityId: id,
      reason: 'Covers the December demand spike',
      details: { number: 'PO-000001', totalCents: 34_000 },
    });
  });

  it('lets a rejected order be reopened, fixed and approved on resubmission', async () => {
    const { id } = purchasing.seedDraft(ORG_NORTH);
    await step('u-north-buyer', id, 'submit').expect(200);

    const rejected = await step('u-north-manager', id, 'reject', {
      reason: 'Quantity above forecast',
    }).expect(200);
    expect(rejected.body.data).toMatchObject({
      status: 'rejected',
      decisionReason: 'Quantity above forecast',
    });

    const reopened = await step('u-north-buyer', id, 'reopen').expect(200);
    expect(reopened.body.data).toMatchObject({
      status: 'draft',
      submittedBy: null,
      decidedBy: null,
      decisionReason: null,
    });

    // The manager who rejected it can now submit it and someone else approves.
    await step('u-north-manager', id, 'submit').expect(200);
    await step('u-north-owner', id, 'approve').expect(200);

    const trail = await events('u-north-viewer', id).expect(200);
    expect(trail.body.data.map((e: AuditEvent) => e.toStatus)).toEqual([
      'submitted',
      'rejected',
      'draft',
      'submitted',
      'approved',
    ]);
  });

  describe('refusals', () => {
    it('answers 409 invalid_status_transition when the step does not apply', async () => {
      const { id } = purchasing.seedDraft(ORG_NORTH);
      const res = await step('u-north-manager', id, 'approve').expect(409);
      expect(res.body.error).toMatchObject({
        code: 'invalid_status_transition',
        message: 'The purchase order is draft and cannot be approved',
      });

      await step('u-north-buyer', id, 'submit').expect(200);
      await step('u-north-buyer', id, 'submit').expect(409);
      await step('u-north-buyer', id, 'reopen').expect(409);
      expect(purchasing.events).toHaveLength(1);
    });

    it('stops the submitter from approving their own order, whatever their role', async () => {
      const { id } = purchasing.seedDraft(ORG_NORTH, 'u-north-owner');
      await step('u-north-owner', id, 'submit').expect(200);

      const res = await step('u-north-owner', id, 'approve').expect(403);
      expect(res.body.error.code).toBe('self_decision_not_allowed');
      await step('u-north-owner', id, 'reject', { reason: 'Changed my mind' }).expect(403);
      expect(purchasing.orders[0].status).toBe('submitted');

      await step('u-north-manager', id, 'approve').expect(200);
    });

    it('keeps decisions for managers and read-only access for viewers', async () => {
      const { id } = purchasing.seedDraft(ORG_NORTH);
      await step('u-north-viewer', id, 'submit').expect(403);
      await step('u-north-buyer', id, 'submit').expect(200);

      const res = await step('u-north-buyer-2', id, 'approve').expect(403);
      expect(res.body.error.code).toBe('forbidden');
      await step('u-north-buyer-2', id, 'reject', { reason: 'No' }).expect(403);
      expect(purchasing.transition).toHaveBeenCalledTimes(1);
    });

    it('lets a buyer cancel a submitted order but only a manager an approved one', async () => {
      const first = purchasing.seedDraft(ORG_NORTH);
      await step('u-north-buyer', first.id, 'submit').expect(200);
      const cancelled = await step('u-north-buyer', first.id, 'cancel', {
        reason: 'Duplicate of PO-000002',
      }).expect(200);
      expect(cancelled.body.data.status).toBe('cancelled');

      const second = purchasing.seedDraft(ORG_NORTH);
      await step('u-north-buyer', second.id, 'submit').expect(200);
      await step('u-north-manager', second.id, 'approve').expect(200);
      const res = await step('u-north-buyer', second.id, 'cancel', {
        reason: 'Supplier out of stock',
      }).expect(403);
      expect(res.body.error).toMatchObject({
        code: 'forbidden',
        message: 'Only a manager or above can cancel this purchase order',
      });
      await step('u-north-manager', second.id, 'cancel', {
        reason: 'Supplier out of stock',
      }).expect(200);
    });

    it('requires a reason to reject or cancel, before touching the order', async () => {
      const { id } = purchasing.seedDraft(ORG_NORTH);
      await step('u-north-buyer', id, 'submit').expect(200);
      for (const action of ['reject', 'cancel']) {
        const res = await step('u-north-manager', id, action, { reason: '  ' }).expect(422);
        expect(res.body.error.details).toEqual([
          expect.objectContaining({ field: 'reason' }),
        ]);
      }
      expect(purchasing.transition).toHaveBeenCalledTimes(1);
    });

    it("hides other organizations' orders and their audit trail", async () => {
      const { id } = purchasing.seedDraft(ORG_NORTH);
      await step('u-north-buyer', id, 'submit').expect(200);

      await step('u-south-manager', id, 'approve', {}, ORG_NORTH).expect(403);
      const res = await step('u-south-manager', id, 'approve', {}, ORG_SOUTH).expect(404);
      expect(res.body.error.code).toBe('not_found');
      await events('u-south-manager', id, ORG_SOUTH).expect(404);
      expect(purchasing.orders[0].status).toBe('submitted');
    });

    it('answers 404 for a malformed id without querying', async () => {
      await step('u-north-manager', 'not-a-uuid', 'approve').expect(404);
      await events('u-north-viewer', 'not-a-uuid').expect(404);
      expect(purchasing.transition).not.toHaveBeenCalled();
      expect(purchasing.listEvents).not.toHaveBeenCalled();
    });
  });
});
