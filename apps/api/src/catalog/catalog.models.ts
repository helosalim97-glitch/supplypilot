/** Catalog records as the API exposes them (camelCase, ISO timestamps). */

export interface Supplier {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  contactEmail: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Warehouse {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Sku {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  unit: string;
  unitCostCents: number;
  reorderPoint: number;
  preferredSupplierId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewSupplier {
  code: string;
  name: string;
  contactEmail?: string | null;
}

export interface NewWarehouse {
  code: string;
  name: string;
}

export interface NewSku {
  code: string;
  name: string;
  unit: string;
  unitCostCents: number;
  reorderPoint?: number;
  preferredSupplierId?: string | null;
}

/** Rows as returned by `pg` (snake_case, Date timestamps). */
interface BaseRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SupplierRow extends BaseRow {
  contact_email: string | null;
}

export type WarehouseRow = BaseRow;

export interface SkuRow extends BaseRow {
  unit: string;
  unit_cost_cents: number;
  reorder_point: number;
  preferred_supplier_id: string | null;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function base(row: BaseRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    code: row.code,
    name: row.name,
    archivedAt: iso(row.archived_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toSupplier(row: SupplierRow): Supplier {
  const { archivedAt, createdAt, updatedAt, ...rest } = base(row);
  return { ...rest, contactEmail: row.contact_email, archivedAt, createdAt, updatedAt };
}

export function toWarehouse(row: WarehouseRow): Warehouse {
  return base(row);
}

export function toSku(row: SkuRow): Sku {
  const { archivedAt, createdAt, updatedAt, ...rest } = base(row);
  return {
    ...rest,
    unit: row.unit,
    unitCostCents: row.unit_cost_cents,
    reorderPoint: row.reorder_point,
    preferredSupplierId: row.preferred_supplier_id,
    archivedAt,
    createdAt,
    updatedAt,
  };
}
