import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { isRole, type Role } from './roles';

export interface MembershipSummary {
  organizationId: string;
  slug: string;
  name: string;
  role: Role;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  /** Returns the user id for an active (not expired, not revoked) token. */
  async findUserIdByToken(token: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM api_tokens
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [hashToken(token)],
    );
    return rows[0]?.user_id ?? null;
  }

  async findRole(userId: string, organizationId: string): Promise<Role | null> {
    const { rows } = await this.pool.query<{ role: string }>(
      'SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2',
      [userId, organizationId],
    );
    const role = rows[0]?.role;
    return isRole(role) ? role : null;
  }

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const { rows } = await this.pool.query<{
      organization_id: string;
      slug: string;
      name: string;
      role: string;
    }>(
      `SELECT o.id AS organization_id, o.slug, o.name, m.role
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1
        ORDER BY o.name`,
      [userId],
    );
    return rows
      .filter((row) => isRole(row.role))
      .map((row) => ({
        organizationId: row.organization_id,
        slug: row.slug,
        name: row.name,
        role: row.role as Role,
      }));
  }
}
