import { Body, Controller, Get, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth.context';
import { RequireRole } from '../auth/require-role.decorator';
import { TenantGuard } from '../auth/tenant.guard';
import { ApiError, ValidationError } from '../http/api-error';
import type { Sku, Supplier, Warehouse } from './catalog.models';
import {
  CatalogRepository,
  DuplicateCodeError,
  UnknownReferenceError,
  type CatalogEntity,
} from './catalog.repository';
import { isUuid, parseNewSku, parseNewSupplier, parseNewWarehouse } from './catalog.validation';

const LABELS: Record<CatalogEntity, string> = {
  supplier: 'Supplier',
  warehouse: 'Warehouse',
  sku: 'SKU',
};

function notFound(entity: CatalogEntity): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, 'not_found', `${LABELS[entity]} not found`);
}

/** Looks a record up by id; malformed ids are a plain 404, not a database error. */
async function findOr404<T>(
  entity: CatalogEntity,
  id: string,
  find: (id: string) => Promise<T | null>,
): Promise<T> {
  const record = isUuid(id) ? await find(id) : null;
  if (!record) throw notFound(entity);
  return record;
}

/** Maps repository errors to 409 (duplicate code) and 422 (bad reference). */
async function create<T>(insert: () => Promise<T>): Promise<T> {
  try {
    return await insert();
  } catch (error) {
    if (error instanceof DuplicateCodeError) {
      throw new ApiError(HttpStatus.CONFLICT, 'duplicate_code', error.message, [
        { field: 'code', message: 'is already used in this organization' },
      ]);
    }
    if (error instanceof UnknownReferenceError) {
      throw new ValidationError([
        { field: error.field, message: 'does not exist in this organization' },
      ]);
    }
    throw error;
  }
}

/**
 * Catalog endpoints, scoped to the organization in the path. Any member can
 * read; creating records needs `manager` or higher. Responses are wrapped in
 * `{ data }`; errors use the shared error envelope.
 */
@Controller('v1/organizations/:orgId')
@UseGuards(TenantGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogRepository) {}

  @Get('suppliers')
  @RequireRole('viewer')
  async listSuppliers(@Auth() auth: AuthContext): Promise<{ data: Supplier[] }> {
    return { data: await this.catalog.listSuppliers(orgOf(auth)) };
  }

  @Get('suppliers/:id')
  @RequireRole('viewer')
  async getSupplier(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ data: Supplier }> {
    const org = orgOf(auth);
    return { data: await findOr404('supplier', id, (i) => this.catalog.findSupplier(org, i)) };
  }

  @Post('suppliers')
  @RequireRole('manager')
  async createSupplier(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ data: Supplier }> {
    const input = parseNewSupplier(body);
    return { data: await create(() => this.catalog.createSupplier(orgOf(auth), input)) };
  }

  @Get('warehouses')
  @RequireRole('viewer')
  async listWarehouses(@Auth() auth: AuthContext): Promise<{ data: Warehouse[] }> {
    return { data: await this.catalog.listWarehouses(orgOf(auth)) };
  }

  @Get('warehouses/:id')
  @RequireRole('viewer')
  async getWarehouse(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ data: Warehouse }> {
    const org = orgOf(auth);
    return { data: await findOr404('warehouse', id, (i) => this.catalog.findWarehouse(org, i)) };
  }

  @Post('warehouses')
  @RequireRole('manager')
  async createWarehouse(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ data: Warehouse }> {
    const input = parseNewWarehouse(body);
    return { data: await create(() => this.catalog.createWarehouse(orgOf(auth), input)) };
  }

  @Get('skus')
  @RequireRole('viewer')
  async listSkus(@Auth() auth: AuthContext): Promise<{ data: Sku[] }> {
    return { data: await this.catalog.listSkus(orgOf(auth)) };
  }

  @Get('skus/:id')
  @RequireRole('viewer')
  async getSku(@Auth() auth: AuthContext, @Param('id') id: string): Promise<{ data: Sku }> {
    const org = orgOf(auth);
    return { data: await findOr404('sku', id, (i) => this.catalog.findSku(org, i)) };
  }

  @Post('skus')
  @RequireRole('manager')
  async createSku(@Auth() auth: AuthContext, @Body() body: unknown): Promise<{ data: Sku }> {
    const input = parseNewSku(body);
    return { data: await create(() => this.catalog.createSku(orgOf(auth), input)) };
  }
}

/** TenantGuard sets the organization on every `@RequireRole` route. */
function orgOf(auth: AuthContext): string {
  return auth.organizationId as string;
}
