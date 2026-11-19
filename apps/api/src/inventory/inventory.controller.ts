import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthContext } from '../auth/auth.context';
import { RequireRole } from '../auth/require-role.decorator';
import { TenantGuard } from '../auth/tenant.guard';
import { UnknownReferenceError } from '../catalog/catalog.repository';
import { ApiError, ValidationError } from '../http/api-error';
import type { BalanceQuery, InventoryEvent, StockBalance } from './inventory.models';
import {
  IdempotencyConflictError,
  InsufficientStockError,
  InventoryRepository,
  StockOverflowError,
} from './inventory.repository';
import { parseBalanceQuery, parseIdempotencyKey, parseNewMovement } from './inventory.validation';

const REFERENCE_LABELS: Record<string, string> = {
  skuId: 'is not an active SKU in this organization',
  warehouseId: 'is not an active warehouse in this organization',
  correctsEventId: 'is not an event for the same SKU and warehouse in this organization',
};

/**
 * Stock balances and movements, scoped to the organization in the path. Each
 * movement appends one event to the ledger; stock is never edited in place.
 */
@Controller('v1/organizations/:orgId/inventory')
@UseGuards(TenantGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryRepository) {}

  /** Current on-hand stock per SKU and warehouse. Any member can read it. */
  @Get()
  @RequireRole('viewer')
  async listBalances(
    @Auth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<{ data: StockBalance[]; page: BalanceQuery & { hasMore: boolean } }> {
    const filters = parseBalanceQuery(query);
    const { balances, hasMore } = await this.inventory.listBalances(
      auth.organizationId as string,
      filters,
    );
    return { data: balances, page: { ...filters, hasMore } };
  }

  /**
   * `201` with the new event, or `200` with the original event when the same
   * `Idempotency-Key` is retried with the same body (`Idempotent-Replayed: true`).
   */
  @Post('movements')
  @RequireRole('manager')
  async recordMovement(
    @Auth() auth: AuthContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: InventoryEvent }> {
    const key = parseIdempotencyKey(idempotencyKey);
    const input = parseNewMovement(body);
    try {
      const { event, replayed } = await this.inventory.recordMovement(
        auth.organizationId as string,
        auth.userId,
        key,
        input,
      );
      res.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
      res.setHeader('Idempotent-Replayed', String(replayed));
      return { data: event };
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(HttpStatus.CONFLICT, 'idempotency_conflict', error.message, [
          { field: 'Idempotency-Key', message: 'was already used for a different movement' },
        ]);
      }
      if (error instanceof InsufficientStockError) {
        throw new ApiError(HttpStatus.CONFLICT, 'insufficient_stock', error.message, [
          {
            field: 'quantity',
            message: `would take on-hand stock below zero (on hand: ${error.onHand})`,
          },
        ]);
      }
      if (error instanceof StockOverflowError) {
        throw new ValidationError([{ field: 'quantity', message: error.message }]);
      }
      if (error instanceof UnknownReferenceError) {
        throw new ValidationError([
          { field: error.field, message: REFERENCE_LABELS[error.field] ?? error.message },
        ]);
      }
      throw error;
    }
  }
}
