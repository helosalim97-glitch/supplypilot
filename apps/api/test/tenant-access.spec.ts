import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Auth, type AuthContext } from '../src/auth/auth.context';
import { AuthRepository } from '../src/auth/auth.repository';
import { RequireRole } from '../src/auth/require-role.decorator';
import { ROLES, satisfiesRole, type Role } from '../src/auth/roles';
import { TenantGuard } from '../src/auth/tenant.guard';

/**
 * Two tenants, one user per role in each, plus a user with no memberships.
 * The fake repository mirrors the SQL in AuthRepository: tokens map to users,
 * memberships are looked up by (user, organization).
 */
const ORG_NORTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const ORG_SOUTH = '0b7e1c9a-3f2d-4c1e-8a6b-000000000002';
const ORG_UNKNOWN = '0b7e1c9a-3f2d-4c1e-8a6b-000000000099';

interface Fixture {
  token: string;
  userId: string;
  memberships: Record<string, Role>;
}

function userId(n: number): string {
  return `5d2f7a10-9c4b-4e3a-b1d8-${n.toString().padStart(12, '0')}`;
}

const USERS: Record<string, Fixture> = {};
ROLES.forEach((role, i) => {
  USERS[`north-${role}`] = {
    token: `north-${role}-token-0123456789`,
    userId: userId(i + 1),
    memberships: { [ORG_NORTH]: role },
  };
  USERS[`south-${role}`] = {
    token: `south-${role}-token-0123456789`,
    userId: userId(i + 11),
    memberships: { [ORG_SOUTH]: role },
  };
});
USERS.outsider = { token: 'outsider-token-0123456789', userId: userId(99), memberships: {} };
USERS.both = {
  token: 'both-orgs-token-0123456789',
  userId: userId(50),
  memberships: { [ORG_NORTH]: 'owner', [ORG_SOUTH]: 'viewer' },
};

function fakeRepository() {
  const byToken = new Map(Object.values(USERS).map((u) => [u.token, u]));
  const byId = new Map(Object.values(USERS).map((u) => [u.userId, u]));
  return {
    findUserIdByToken: jest.fn(async (token: string) => byToken.get(token)?.userId ?? null),
    findRole: jest.fn(
      async (uid: string, orgId: string) => byId.get(uid)?.memberships[orgId] ?? null,
    ),
    listMemberships: jest.fn(async () => []),
  };
}

/** One route per minimum role, so every (role, required) pair can be exercised. */
@Controller('v1/organizations/:orgId/probe')
@UseGuards(TenantGuard)
class ProbeController {
  @Get('viewer')
  @RequireRole('viewer')
  viewer(@Auth() auth: AuthContext) {
    return auth;
  }

  @Get('buyer')
  @RequireRole('buyer')
  buyer(@Auth() auth: AuthContext) {
    return auth;
  }

  @Get('manager')
  @RequireRole('manager')
  manager(@Auth() auth: AuthContext) {
    return auth;
  }

  @Get('owner')
  @RequireRole('owner')
  owner(@Auth() auth: AuthContext) {
    return auth;
  }
}

describe('tenant access', () => {
  let app: INestApplication;
  let repository: ReturnType<typeof fakeRepository>;

  beforeAll(async () => {
    repository = fakeRepository();
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [TenantGuard, { provide: AuthRepository, useValue: repository }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const probe = (orgId: string, required: Role, token?: string) => {
    const req = request(app.getHttpServer()).get(`/v1/organizations/${orgId}/probe/${required}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  describe('role matrix', () => {
    const cases = ROLES.flatMap((actual) =>
      ROLES.map((required) => [actual, required, satisfiesRole(actual, required)] as const),
    );

    it('covers every role pair', () => {
      expect(cases).toHaveLength(ROLES.length * ROLES.length);
    });

    it.each(cases)('%s calling a %s route → allowed: %s', async (actual, required, allowed) => {
      const user = USERS[`north-${actual}`];
      const res = await probe(ORG_NORTH, required, user.token).expect(allowed ? 200 : 403);
      if (allowed) {
        expect(res.body).toEqual({ userId: user.userId, organizationId: ORG_NORTH, role: actual });
      }
    });

    it('matches the documented hierarchy', () => {
      const allowed = (actual: Role) => ROLES.filter((required) => satisfiesRole(actual, required));
      expect(allowed('viewer')).toEqual(['viewer']);
      expect(allowed('buyer')).toEqual(['viewer', 'buyer']);
      expect(allowed('manager')).toEqual(['viewer', 'buyer', 'manager']);
      expect(allowed('owner')).toEqual(['viewer', 'buyer', 'manager', 'owner']);
    });
  });

  describe('cross-tenant access', () => {
    it.each(ROLES)('a %s of one organization cannot reach the other', async (role) => {
      await probe(ORG_SOUTH, 'viewer', USERS[`north-${role}`].token).expect(403);
      await probe(ORG_NORTH, 'viewer', USERS[`south-${role}`].token).expect(403);
    });

    it('rejects a user with no memberships', async () => {
      await probe(ORG_NORTH, 'viewer', USERS.outsider.token).expect(403);
      await probe(ORG_SOUTH, 'viewer', USERS.outsider.token).expect(403);
    });

    it('uses the role of the organization in the path, not the highest one', async () => {
      const { token } = USERS.both;
      await probe(ORG_NORTH, 'owner', token).expect(200);
      await probe(ORG_SOUTH, 'owner', token).expect(403);
      const res = await probe(ORG_SOUTH, 'viewer', token).expect(200);
      expect(res.body).toMatchObject({ organizationId: ORG_SOUTH, role: 'viewer' });
    });

    it('gives the same 403 for unknown, foreign and under-privileged access', async () => {
      const token = USERS['north-viewer'].token;
      const unknown = await probe(ORG_UNKNOWN, 'viewer', token).expect(403);
      const foreign = await probe(ORG_SOUTH, 'viewer', token).expect(403);
      const lowRole = await probe(ORG_NORTH, 'owner', token).expect(403);
      expect(foreign.body).toEqual(unknown.body);
      expect(lowRole.body).toEqual(unknown.body);
    });

    it('looks up the membership for the organization in the path', async () => {
      repository.findRole.mockClear();
      await probe(ORG_SOUTH, 'viewer', USERS['south-buyer'].token).expect(200);
      expect(repository.findRole).toHaveBeenCalledTimes(1);
      expect(repository.findRole).toHaveBeenCalledWith(USERS['south-buyer'].userId, ORG_SOUTH);
    });

    it('does not query memberships for a malformed organization id', async () => {
      repository.findRole.mockClear();
      await probe('north-supply', 'viewer', USERS['north-owner'].token).expect(403);
      expect(repository.findRole).not.toHaveBeenCalled();
    });
  });

  describe('authentication comes first', () => {
    it('returns 401 without a token, even for a real organization', async () => {
      await probe(ORG_NORTH, 'viewer').expect(401);
    });

    it('returns 401 for a malformed authorization header', async () => {
      const token = USERS['north-owner'].token;
      await request(app.getHttpServer())
        .get(`/v1/organizations/${ORG_NORTH}/probe/viewer`)
        .set('Authorization', `Token ${token}`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/v1/organizations/${ORG_NORTH}/probe/viewer`)
        .set('Authorization', 'Bearer short')
        .expect(401);
    });

    it('returns 401 for an unknown token without checking memberships', async () => {
      repository.findRole.mockClear();
      await probe(ORG_NORTH, 'viewer', 'revoked-or-expired-token-0123').expect(401);
      expect(repository.findRole).not.toHaveBeenCalled();
    });
  });
});
