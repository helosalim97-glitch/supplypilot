import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth.context';
import { RequireRole } from '../auth/require-role.decorator';
import { TenantGuard } from '../auth/tenant.guard';
import { isUuid } from '../catalog/catalog.validation';
import { ApiError } from '../http/api-error';
import type { PurchaseOrder } from '../purchasing/purchasing.models';
import { LineTotalTooLargeError } from '../purchasing/purchasing.repository';
import { ReorderCandidateSource, WorkerUnavailableError } from './reorder-worker.client';
import type { ReorderProposal, ReorderProposalQuery, ReorderRunResult } from './reorders.models';
import {
  ProposalNotPendingError,
  ProposalOutdatedError,
  ReordersRepository,
} from './reorders.repository';
import { parseDecision, parseProposalQuery, parseRunSettings } from './reorders.validation';

function notFound(): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, 'not_found', 'Reorder proposal not found');
}

/**
 * Reorder proposals, scoped to the organization in the path. Any member can
 * read them; managers and above start runs and decide. A proposal never
 * orders anything by itself: approving one raises a draft purchase order
 * that still goes through submit and approval.
 */
@Controller('v1/organizations/:orgId/reorders')
@UseGuards(TenantGuard)
export class ReordersController {
  constructor(
    private readonly reorders: ReordersRepository,
    private readonly worker: ReorderCandidateSource,
  ) {}

  /** Newest first; filters by status, SKU and warehouse. */
  @Get()
  @RequireRole('viewer')
  async list(
    @Auth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<{ data: ReorderProposal[]; page: ReorderProposalQuery & { hasMore: boolean } }> {
    const filters = parseProposalQuery(query);
    const { proposals, hasMore } = await this.reorders.list(orgOf(auth), filters);
    return { data: proposals, page: { ...filters, hasMore } };
  }

  /**
   * Asks the forecasting worker which stocked SKUs need a reorder now and
   * stores the answer as proposals. `503 worker_unavailable` when the worker
   * isn't configured or reachable; nothing is stored then.
   */
  @Post('runs')
  @HttpCode(HttpStatus.OK)
  @RequireRole('manager')
  async run(@Auth() auth: AuthContext, @Body() body: unknown): Promise<{ data: ReorderRunResult }> {
    const settings = parseRunSettings(body);
    let candidates;
    try {
      candidates = await this.worker.candidates(orgOf(auth), settings);
    } catch (error) {
      if (error instanceof WorkerUnavailableError) {
        throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'worker_unavailable', error.message);
      }
      throw error;
    }
    return { data: await this.reorders.applyRun(orgOf(auth), auth.userId, candidates) };
  }

  @Get(':id')
  @RequireRole('viewer')
  async get(@Auth() auth: AuthContext, @Param('id') id: string): Promise<{ data: ReorderProposal }> {
    const proposal = isUuid(id) ? await this.reorders.find(orgOf(auth), id) : null;
    if (!proposal) throw notFound();
    return { data: proposal };
  }

  /**
   * `{ decision: 'approve' | 'reject', reason?, quantity?, expectedOn? }`.
   * Approving returns the draft purchase order it raised. `409
   * proposal_not_pending` once a proposal was decided or replaced.
   */
  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequireRole('manager')
  async decide(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: { proposal: ReorderProposal; purchaseOrder: PurchaseOrder | null } }> {
    if (!isUuid(id)) throw notFound();
    const input = parseDecision(body);
    try {
      const result = await this.reorders.decide(orgOf(auth), id, auth.userId, input);
      if (!result) throw notFound();
      return { data: result };
    } catch (error) {
      if (error instanceof ProposalNotPendingError) {
        throw new ApiError(HttpStatus.CONFLICT, 'proposal_not_pending', error.message);
      }
      if (error instanceof ProposalOutdatedError) {
        throw new ApiError(HttpStatus.CONFLICT, 'proposal_outdated', error.message);
      }
      if (error instanceof LineTotalTooLargeError) {
        throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', error.message, [
          { field: 'quantity', message: error.message },
        ]);
      }
      throw error;
    }
  }
}

/** TenantGuard sets the organization on every `@RequireRole` route. */
function orgOf(auth: AuthContext): string {
  return auth.organizationId as string;
}
