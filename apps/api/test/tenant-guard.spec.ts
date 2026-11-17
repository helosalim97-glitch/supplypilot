import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import { satisfiesRole } from '../src/auth/roles';
import { TenantGuard } from '../src/auth/tenant.guard';
import { OrganizationsController } from '../src/organizations/organizations.controller';

const ORG_A = '6f1c2a52-6a0e-4b8e-9a51-0c6a1f6c0001';
const ORG_B = '6f1c2a52-6a0e-4b8e-9a51-0c6a1f6c0002';
const TOKEN = 'test-token-0123456789abcdef';
const USER = 'b3d1e0f4-2c8a-4f61-8d7e-5a9b6c3d0001';

function fakeRepository() {
  return {
    findUserIdByToken: jest.fn(async (token: string) => (token === TOKEN ? USER : null)),
    findRole: jest.fn(async (userId: string, orgId: string) =>
      userId === USER && orgId === ORG_A ? 'buyer' : null,
    ),
    listMemberships: jest.fn(async () => [
      { organizationId: ORG_A, slug: 'north-supply', name: 'North Supply', role: 'buyer' as const },
    ]),
  };
}

describe('TenantGuard', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [TenantGuard, { provide: AuthRepository, useValue: fakeRepository() }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 without a bearer token', async () => {
    await request(app.getHttpServer()).get('/v1/me/organizations').expect(401);
  });

  it('returns 401 for an unknown token', async () => {
    await request(app.getHttpServer())
      .get('/v1/me/organizations')
      .set('Authorization', 'Bearer unknown-token-0123456789')
      .expect(401);
  });

  it('lists the caller organizations', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/me/organizations')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.body.data).toEqual([
      { organizationId: ORG_A, slug: 'north-supply', name: 'North Supply', role: 'buyer' },
    ]);
  });

  it('returns the membership for an organization the caller belongs to', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/organizations/${ORG_A}/membership`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.body).toEqual({ organizationId: ORG_A, role: 'buyer' });
  });

  it('returns 403 for another tenant organization', async () => {
    await request(app.getHttpServer())
      .get(`/v1/organizations/${ORG_B}/membership`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(403);
  });

  it('returns 403 for a malformed organization id', async () => {
    await request(app.getHttpServer())
      .get('/v1/organizations/not-a-uuid/membership')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(403);
  });
});

describe('satisfiesRole', () => {
  it('accepts equal and higher roles and rejects lower ones', () => {
    expect(satisfiesRole('buyer', 'buyer')).toBe(true);
    expect(satisfiesRole('owner', 'viewer')).toBe(true);
    expect(satisfiesRole('viewer', 'buyer')).toBe(false);
  });
});
