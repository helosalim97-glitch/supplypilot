import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import type { Role } from '../src/auth/roles';
import { TenantGuard } from '../src/auth/tenant.guard';
import { configureApp } from '../src/http/configure-app';
import { ReorderCandidateSource, WorkerUnavailableError } from '../src/reorders/reorder-worker.client';
import { ReordersController } from '../src/reorders/reorders.controller';
import type { ReorderProposal, WorkerCandidates } from '../src/reorders/reorders.models';
import {
  ProposalNotPendingError,
  ProposalOutdatedError,
  ReordersRepository,
} from '../src/reorders/reorders.repository';

const ORG_NORTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const ORG_SOUTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000002';
const PROPOSAL = '3d4e5f60-0000-4000-8000-000000000001';

const USERS: Record<string, { token: string; organizationId: string; role: Role }> = {
  'u-north-viewer': { token: 'north-viewer-token-0123456789', organizationId: ORG_NORTH, role: 'viewer' },
  'u-north-buyer': { token: 'north-buyer-token-0123456789', organizationId: ORG_NORTH, role: 'buyer' },
  'u-north-manager': { token: 'north-manager-token-01234567', organizationId: ORG_NORTH, role: 'manager' },
  'u-south-manager': { token: 'south-manager-token-01234567', organizationId: ORG_SOUTH, role: 'manager' },
};

function fakeAuthRepository() {
  const entries = Object.entries(USERS);
  return {
    findUserIdByToken: jest.fn(async (token: string) => entries.find(([, u]) => u.token === token)?.[0] ?? null),
    findRole: jest.fn(async (userId: string, organizationId: string) => {
      const user = USERS[userId];
      return user && user.organizationId === organizationId ? user.role : null;
    }),
    listMemberships: jest.fn(async () => []),
  };
}

const proposal = (overrides: Partial<ReorderProposal> = {}): ReorderProposal => ({
  id: PROPOSAL,
  organizationId: ORG_NORTH,
  status: 'pending',
  skuId: '1c2d3e4f-0000-4000-8000-000000000001',
  skuCode: 'BOX-S',
  skuName: 'Corrugated box, small',
  unit: 'each',
  warehouseId: '1c2d3e4f-0000-4000-8000-000000000002',
  warehouseCode: 'WH1',
  supplierId: '1c2d3e4f-0000-4000-8000-000000000003',
  supplierCode: 'ACME',
  suggestedQty: 51,
  onHand: 10,
  onOrder: 0,
  reorderPoint: 28,
  safetyStock: 2,
  orderUpTo: 61,
  evidence: { meanDailyDemand: 4 },
  warnings: [],
  inputsDigest: 'a'.repeat(64),
  calculatedAt: '2026-11-27T10:00:00.000Z',
  createdBy: 'u-north-manager',
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  approvedQty: null,
  purchaseOrderId: null,
  purchaseOrderNumber: null,
  supersededAt: null,
  createdAt: '2026-11-27T10:00:01.000Z',
  updatedAt: '2026-11-27T10:00:01.000Z',
  ...overrides,
});

const CANDIDATES: WorkerCandidates = {
  calculatedAt: '2026-11-27T10:00:00Z',
  parameters: { demandWindowDays: 90 },
  candidates: [],
  skipped: [],
};

describe('reorder proposals API', () => {
  let app: INestApplication;
  let repo: {
    list: jest.Mock;
    find: jest.Mock;
    applyRun: jest.Mock;
    decide: jest.Mock;
  };
  let worker: { candidates: jest.Mock };

  beforeEach(async () => {
    repo = {
      list: jest.fn(async (org: string) => ({
        proposals: org === ORG_NORTH ? [proposal()] : [],
        hasMore: false,
      })),
      find: jest.fn(async (org: string, id: string) => (org === ORG_NORTH && id === PROPOSAL ? proposal() : null)),
      applyRun: jest.fn(async () => ({
        calculatedAt: CANDIDATES.calculatedAt,
        parameters: CANDIDATES.parameters,
        created: 1,
        unchanged: 0,
        superseded: 0,
        skipped: [],
      })),
      decide: jest.fn(async (org: string, id: string, actor: string, input: { decision: string }) =>
        org === ORG_NORTH && id === PROPOSAL
          ? {
              proposal: proposal({ status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: actor }),
              purchaseOrder: null,
            }
          : null,
      ),
    };
    worker = { candidates: jest.fn(async () => CANDIDATES) };
    const moduleRef = await Test.createTestingModule({
      controllers: [ReordersController],
      providers: [
        TenantGuard,
        { provide: AuthRepository, useValue: fakeAuthRepository() },
        { provide: ReordersRepository, useValue: repo },
        { provide: ReorderCandidateSource, useValue: worker },
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
  const base = (org = ORG_NORTH) => `/v1/organizations/${org}/reorders`;

  it('lists proposals for any member with paging', async () => {
    const res = await server().get(`${base()}?status=pending`).set(as('u-north-viewer')).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page).toEqual({
      status: 'pending',
      skuId: null,
      warehouseId: null,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    await server().get(`${base()}?status=open`).set(as('u-north-viewer')).expect(422);
  });

  it('keeps tenants apart: not a member → 403, unknown or foreign proposal → 404', async () => {
    await server().get(base()).set(as('u-south-manager')).expect(403);
    await server().get(`${base(ORG_SOUTH)}/${PROPOSAL}`).set(as('u-south-manager')).expect(404);
    await server().get(`${base()}/not-a-uuid`).set(as('u-north-viewer')).expect(404);
    await server().get(`${base()}/${PROPOSAL}`).set(as('u-north-viewer')).expect(200);
    await server().get(base()).expect(401);
  });

  it('lets only managers start runs', async () => {
    await server().post(`${base()}/runs`).set(as('u-north-viewer')).send({}).expect(403);
    await server().post(`${base()}/runs`).set(as('u-north-buyer')).send({}).expect(403);
    expect(worker.candidates).not.toHaveBeenCalled();

    const res = await server()
      .post(`${base()}/runs`)
      .set(as('u-north-manager'))
      .send({ demandWindowDays: 30 })
      .expect(200);
    expect(res.body.data).toMatchObject({ created: 1, unchanged: 0, superseded: 0 });
    expect(worker.candidates).toHaveBeenCalledWith(ORG_NORTH, { demandWindowDays: 30 });
    expect(repo.applyRun).toHaveBeenCalledWith(ORG_NORTH, 'u-north-manager', CANDIDATES);
  });

  it('validates run settings before calling the worker', async () => {
    const res = await server()
      .post(`${base()}/runs`)
      .set(as('u-north-manager'))
      .send({ serviceLevel: 2 })
      .expect(422);
    expect(res.body.error.details).toEqual([{ field: 'serviceLevel', message: expect.any(String) }]);
    expect(worker.candidates).not.toHaveBeenCalled();
  });

  it('answers 503 and stores nothing when the worker is unavailable', async () => {
    worker.candidates.mockRejectedValueOnce(new WorkerUnavailableError('The forecasting worker could not be reached'));
    const res = await server().post(`${base()}/runs`).set(as('u-north-manager')).send({}).expect(503);
    expect(res.body.error.code).toBe('worker_unavailable');
    expect(repo.applyRun).not.toHaveBeenCalled();
  });

  it('lets only managers decide', async () => {
    const approve = { decision: 'approve' };
    await server().post(`${base()}/${PROPOSAL}/decision`).set(as('u-north-buyer')).send(approve).expect(403);
    const res = await server()
      .post(`${base()}/${PROPOSAL}/decision`)
      .set(as('u-north-manager'))
      .send({ decision: 'approve', quantity: 60 })
      .expect(200);
    expect(res.body.data.proposal.status).toBe('approved');
    expect(repo.decide).toHaveBeenCalledWith(ORG_NORTH, PROPOSAL, 'u-north-manager', {
      decision: 'approve',
      reason: null,
      quantity: 60,
      expectedOn: null,
    });
  });

  it('needs a reason to reject', async () => {
    const res = await server()
      .post(`${base()}/${PROPOSAL}/decision`)
      .set(as('u-north-manager'))
      .send({ decision: 'reject' })
      .expect(422);
    expect(res.body.error.details[0].field).toBe('reason');
    expect(repo.decide).not.toHaveBeenCalled();
  });

  it('maps decided, outdated and unknown proposals', async () => {
    const url = `${base()}/${PROPOSAL}/decision`;
    repo.decide.mockRejectedValueOnce(new ProposalNotPendingError('approved'));
    let res = await server().post(url).set(as('u-north-manager')).send({ decision: 'approve' }).expect(409);
    expect(res.body.error.code).toBe('proposal_not_pending');

    repo.decide.mockRejectedValueOnce(new ProposalOutdatedError('supplierId'));
    res = await server().post(url).set(as('u-north-manager')).send({ decision: 'approve' }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'proposal_outdated', message: expect.stringContaining('supplier') });

    await server()
      .post(`${base()}/3d4e5f60-0000-4000-8000-000000000099/decision`)
      .set(as('u-north-manager'))
      .send({ decision: 'approve' })
      .expect(404);
    await server()
      .post(`${base(ORG_SOUTH)}/${PROPOSAL}/decision`)
      .set(as('u-south-manager'))
      .send({ decision: 'approve' })
      .expect(404);
  });
});
