import { Body, Controller, Get, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth.context';
import { RequireRole } from '../auth/require-role.decorator';
import { TenantGuard } from '../auth/tenant.guard';
import { UnknownReferenceError } from '../catalog/catalog.repository';
import { isUuid } from '../catalog/catalog.validation';
import { ApiError, ValidationError } from '../http/api-error';
import type { PurchaseOrder, PurchaseOrderQuery, PurchaseOrderSummary } from './purchasing.models';
import {
  LineTotalTooLargeError,
  PurchaseOrderNotEditableError,
  PurchasingRepository,
} from './purchasing.repository';
import {
  parseLineReplacement,
  parseNewPurchaseOrder,
  parsePurchaseOrderQuery,
} from './purchasing.validation';

function notFound(): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, 'not_found', 'Purchase order not found');
}

function referenceMessage(field: string): string {
  if (field === 'supplierId') return 'is not an active supplier in this organization';
  if (field === 'warehouseId') return 'is not an active warehouse in this organization';
  return 'is not an active SKU in this organization';
}

/** Maps repository errors of order writes to 409 / 422 responses. */
async function write<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UnknownReferenceError) {
      throw new ValidationError([{ field: error.field, message: referenceMessage(error.field) }]);
    }
    if (error instanceof LineTotalTooLargeError) {
      throw new ValidationError([{ field: 'lines', message: error.message }]);
    }
    if (error instanceof PurchaseOrderNotEditableError) {
      throw new ApiError(HttpStatus.CONFLICT, 'purchase_order_not_editable', error.message);
    }
    throw error;
  }
}

/**
 * Purchase orders, scoped to the organization in the path. Any member can
 * read; buyers and above create drafts and edit their lines.
 */
@Controller('v1/organizations/:orgId/purchase-orders')
@UseGuards(TenantGuard)
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingRepository) {}

  /** Newest first, with line count and totals; filters by status, supplier, warehouse. */
  @Get()
  @RequireRole('viewer')
  async list(
    @Auth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<{ data: PurchaseOrderSummary[]; page: PurchaseOrderQuery & { hasMore: boolean } }> {
    const filters = parsePurchaseOrderQuery(query);
    const { orders, hasMore } = await this.purchasing.listOrders(orgOf(auth), filters);
    return { data: orders, page: { ...filters, hasMore } };
  }

  @Get(':id')
  @RequireRole('viewer')
  async get(@Auth() auth: AuthContext, @Param('id') id: string): Promise<{ data: PurchaseOrder }> {
    const order = isUuid(id) ? await this.purchasing.findOrder(orgOf(auth), id) : null;
    if (!order) throw notFound();
    return { data: order };
  }

  /** `201` with the new draft, its number and lines. */
  @Post()
  @RequireRole('buyer')
  async create(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ data: PurchaseOrder }> {
    const input = parseNewPurchaseOrder(body);
    return { data: await write(() => this.purchasing.createOrder(orgOf(auth), auth.userId, input)) };
  }

  /** Replaces every line of a draft; `409 purchase_order_not_editable` once it left draft. */
  @Put(':id/lines')
  @RequireRole('buyer')
  async replaceLines(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: PurchaseOrder }> {
    if (!isUuid(id)) throw notFound();
    const lines = parseLineReplacement(body);
    const order = await write(() => this.purchasing.replaceLines(orgOf(auth), id, lines));
    if (!order) throw notFound();
    return { data: order };
  }
}

/** TenantGuard sets the organization on every `@RequireRole` route. */
function orgOf(auth: AuthContext): string {
  return auth.organizationId as string;
}
