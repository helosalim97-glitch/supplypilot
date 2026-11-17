import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthRepository } from './auth.repository';
import type { AuthenticatedRequest } from './auth.context';
import { REQUIRED_ROLE } from './require-role.decorator';
import { satisfiesRole, type Role } from './roles';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]{20,256}=*)$/;

/**
 * Authenticates the bearer token (401 when missing or invalid) and, on routes
 * marked with `@RequireRole`, checks the caller's membership in `:orgId`.
 *
 * Unknown organizations, organizations the caller does not belong to and
 * insufficient roles all get the same 403, so the response does not reveal
 * whether another tenant's organization exists.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly repository: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const match = BEARER_PATTERN.exec(request.headers.authorization ?? '');
    const userId = match ? await this.repository.findUserIdByToken(match[1]) : null;
    if (!userId) {
      throw new UnauthorizedException('A valid bearer token is required');
    }
    request.auth = { userId };

    const required = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      return true;
    }

    const organizationId = request.params?.orgId;
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
      throw new ForbiddenException('Access to this organization is not allowed');
    }

    const role = await this.repository.findRole(userId, organizationId);
    if (!role || !satisfiesRole(role, required)) {
      throw new ForbiddenException('Access to this organization is not allowed');
    }

    request.auth = { userId, organizationId, role };
    return true;
  }
}
