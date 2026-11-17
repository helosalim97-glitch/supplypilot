import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from './roles';

export interface AuthContext {
  userId: string;
  /** Set on organization-scoped routes only. */
  organizationId?: string;
  role?: Role;
}

export type AuthenticatedRequest = Request & { auth?: AuthContext };

/** Injects the context the guards attached to the request. */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);
