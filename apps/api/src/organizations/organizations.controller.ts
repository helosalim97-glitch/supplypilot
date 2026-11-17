import { Controller, Get, UseGuards } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth.context';
import { AuthRepository, type MembershipSummary } from '../auth/auth.repository';
import { RequireRole } from '../auth/require-role.decorator';
import type { Role } from '../auth/roles';
import { TenantGuard } from '../auth/tenant.guard';

@Controller('v1')
@UseGuards(TenantGuard)
export class OrganizationsController {
  constructor(private readonly repository: AuthRepository) {}

  /** Organizations the caller belongs to, with their role in each. */
  @Get('me/organizations')
  async myOrganizations(@Auth() auth: AuthContext): Promise<{ data: MembershipSummary[] }> {
    return { data: await this.repository.listMemberships(auth.userId) };
  }

  /** The caller's membership in one organization; any role may read it. */
  @Get('organizations/:orgId/membership')
  @RequireRole('viewer')
  membership(@Auth() auth: AuthContext): { organizationId: string; role: Role } {
    return { organizationId: auth.organizationId as string, role: auth.role as Role };
  }
}
