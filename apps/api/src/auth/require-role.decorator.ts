import { SetMetadata } from '@nestjs/common';
import type { Role } from './roles';

export const REQUIRED_ROLE = 'supplypilot:required-role';

/**
 * Marks an organization-scoped handler. The route must have an `:orgId`
 * parameter; the caller needs a membership in that organization with at least
 * this role. Used together with `TenantGuard`.
 */
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);
