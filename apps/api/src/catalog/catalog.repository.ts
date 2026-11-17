import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import {
  toSku,
  toSupplier,
  toWarehouse,
  type NewSku,
  type NewSupplier,
  type NewWarehouse,
  type Sku,
  type SkuRow,
  type Supplier,
  type SupplierRow,
  type Warehouse,
  type WarehouseRow,
} from './catalog.models';

export type CatalogEntity = 'supplier' | 'warehouse' | 'sku';

/** A record with the same code already exists in this organization. */
export class DuplicateCodeError extends Error {
  constructor(
    readonly entity: CatalogEntity,
    readonly code: string,
  ) {
    super(`A ${entity} with code "${code}" already exists`);
    this.name = 'DuplicateCodeError';
  }
}

/** A referenced record does not exist in this organization. */
export class UnknownReferenceError extends Error {
  constructor(readonly field: string) {
    super(`${field} does not refer to a record in this organization`);
    this.name = 'UnknownReferenceError';
  }
}

const SUPPLIER_COLUMNS =
  'id, organization_id, code, name, contact_email, archived_at, created_at, updated_at';
const WAREHOUSE_COLUMNS = 'id, organization_id, code, name, archived_at, created_at, updated_at';
const SKU_COLUMNS =
  'id, organization_id, code, name, unit, unit_cost_cents, reorder_point, ' +
  'preferred_supplier_id, archived_at, created_at, updated_at';

/** PostgreSQL SQLSTATE codes we translate into domain errors. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Catalog data access. Every query is scoped by organization id, so a caller
 * can never read or change another tenant's records, even with a known id.
 */
@Injectable()
export class CatalogRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  async listSuppliers(organizationId: string): Promise<Supplier[]> {
    const { rows } = await this.pool.query<SupplierRow>(
      `SELECT ${SUPPLIER_COLUMNS} FROM suppliers
        WHERE organization_id = $1 AND archived_at IS NULL
        ORDER BY code`,
      [organizationId],
    );
    return rows.map(toSupplier);
  }

  async findSupplier(organizationId: string, id: string): Promise<Supplier | null> {
    const { rows } = await this.pool.query<SupplierRow>(
      `SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    return rows[0] ? toSupplier(rows[0]) : null;
  }

  async createSupplier(organizationId: string, input: NewSupplier): Promise<Supplier> {
    const rows = await this.insert<SupplierRow>(
      'supplier',
      input.code,
      `INSERT INTO suppliers (organization_id, code, name, contact_email)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SUPPLIER_COLUMNS}`,
      [organizationId, input.code, input.name, input.contactEmail ?? null],
    );
    return toSupplier(rows[0]);
  }

  async listWarehouses(organizationId: string): Promise<Warehouse[]> {
    const { rows } = await this.pool.query<WarehouseRow>(
      `SELECT ${WAREHOUSE_COLUMNS} FROM warehouses
        WHERE organization_id = $1 AND archived_at IS NULL
        ORDER BY code`,
      [organizationId],
    );
    return rows.map(toWarehouse);
  }

  async findWarehouse(organizationId: string, id: string): Promise<Warehouse | null> {
    const { rows } = await this.pool.query<WarehouseRow>(
      `SELECT ${WAREHOUSE_COLUMNS} FROM warehouses WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    return rows[0] ? toWarehouse(rows[0]) : null;
  }

  async createWarehouse(organizationId: string, input: NewWarehouse): Promise<Warehouse> {
    const rows = await this.insert<WarehouseRow>(
      'warehouse',
      input.code,
      `INSERT INTO warehouses (organization_id, code, name)
       VALUES ($1, $2, $3)
       RETURNING ${WAREHOUSE_COLUMNS}`,
      [organizationId, input.code, input.name],
    );
    return toWarehouse(rows[0]);
  }

  async listSkus(organizationId: string): Promise<Sku[]> {
    const { rows } = await this.pool.query<SkuRow>(
      `SELECT ${SKU_COLUMNS} FROM skus
        WHERE organization_id = $1 AND archived_at IS NULL
        ORDER BY code`,
      [organizationId],
    );
    return rows.map(toSku);
  }

  async findSku(organizationId: string, id: string): Promise<Sku | null> {
    const { rows } = await this.pool.query<SkuRow>(
      `SELECT ${SKU_COLUMNS} FROM skus WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    return rows[0] ? toSku(rows[0]) : null;
  }

  async createSku(organizationId: string, input: NewSku): Promise<Sku> {
    const rows = await this.insert<SkuRow>(
      'sku',
      input.code,
      `INSERT INTO skus
         (organization_id, code, name, unit, unit_cost_cents, reorder_point, preferred_supplier_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SKU_COLUMNS}`,
      [
        organizationId,
        input.code,
        input.name,
        input.unit,
        input.unitCostCents,
        input.reorderPoint ?? 0,
        input.preferredSupplierId ?? null,
      ],
    );
    return toSku(rows[0]);
  }

  /** Runs an INSERT and maps constraint violations to domain errors. */
  private async insert<Row extends object>(
    entity: CatalogEntity,
    code: string,
    sql: string,
    params: unknown[],
  ): Promise<Row[]> {
    try {
      const { rows } = await this.pool.query<Row>(sql, params);
      return rows;
    } catch (error) {
      const state = sqlState(error);
      if (state === UNIQUE_VIOLATION) throw new DuplicateCodeError(entity, code);
      if (state === FOREIGN_KEY_VIOLATION) throw new UnknownReferenceError('preferredSupplierId');
      throw error;
    }
  }
}
