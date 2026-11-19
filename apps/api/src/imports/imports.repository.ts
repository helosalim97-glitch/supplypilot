import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import type { CatalogCodes } from './import-preview';
import {
  toImportBatch,
  toImportRow,
  toImportRowRecord,
  type ImportBatch,
  type ImportBatchRow,
  type ImportDraft,
  type ImportRow,
  type ImportRowQuery,
  type ImportRowRecord,
} from './imports.models';

const BATCH_COLUMNS =
  'id, organization_id, kind, file_name, file_sha256, delimiter, columns, column_mapping, ' +
  'default_type, status, row_count, valid_count, created_by, created_at';

/**
 * Inserts the batch and all its rows in one statement, so a failed upload
 * never leaves a batch without rows.
 */
const INSERT_BATCH_SQL = `WITH batch AS (
     INSERT INTO import_batches
       (organization_id, file_name, file_sha256, delimiter, columns, column_mapping,
        default_type, row_count, valid_count, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
     RETURNING ${BATCH_COLUMNS}
   ), inserted_rows AS (
     INSERT INTO import_rows
       (organization_id, batch_id, row_number, cells, mapped_values, sku_id, warehouse_id,
        event_type, quantity_delta, reason, reference, occurred_at, errors)
     SELECT batch.organization_id, batch.id, r.row_number, r.cells, r.mapped_values, r.sku_id,
            r.warehouse_id, r.event_type, r.quantity_delta, r.reason, r.reference,
            r.occurred_at, r.errors
       FROM batch
      CROSS JOIN jsonb_to_recordset($11::jsonb) AS r(
            row_number integer, cells jsonb, mapped_values jsonb, sku_id uuid,
            warehouse_id uuid, event_type text, quantity_delta integer, reason text,
            reference text, occurred_at timestamptz, errors jsonb)
   )
   SELECT ${BATCH_COLUMNS} FROM batch`;

/** Import batches and their previewed rows, always scoped by organization id. */
@Injectable()
export class ImportsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  /** Ids of the active SKUs and warehouses with the given codes (case-insensitive). */
  async findCatalogCodes(
    organizationId: string,
    skuCodes: string[],
    warehouseCodes: string[],
  ): Promise<CatalogCodes> {
    const { rows } = await this.pool.query<{ kind: 'sku' | 'warehouse'; id: string; code: string }>(
      `SELECT 'sku' AS kind, id, code::text AS code FROM skus
        WHERE organization_id = $1 AND archived_at IS NULL AND code = ANY($2::citext[])
       UNION ALL
       SELECT 'warehouse' AS kind, id, code::text AS code FROM warehouses
        WHERE organization_id = $1 AND archived_at IS NULL AND code = ANY($3::citext[])`,
      [organizationId, skuCodes, warehouseCodes],
    );
    const codes: CatalogCodes = { skus: new Map(), warehouses: new Map() };
    for (const row of rows) {
      (row.kind === 'sku' ? codes.skus : codes.warehouses).set(row.code.toLowerCase(), row.id);
    }
    return codes;
  }

  async createBatch(
    organizationId: string,
    userId: string,
    draft: ImportDraft,
  ): Promise<ImportBatch> {
    const validCount = draft.rows.filter((row) => row.status === 'valid').length;
    const { rows } = await this.pool.query<ImportBatchRow>(INSERT_BATCH_SQL, [
      organizationId,
      draft.fileName,
      draft.fileSha256,
      draft.delimiter,
      JSON.stringify(draft.columns),
      JSON.stringify(draft.mapping),
      draft.defaultType,
      draft.rows.length,
      validCount,
      userId,
      JSON.stringify(draft.rows.map(toImportRowRecord)),
    ]);
    return toImportBatch(rows[0]);
  }

  async findBatch(organizationId: string, id: string): Promise<ImportBatch | null> {
    const { rows } = await this.pool.query<ImportBatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM import_batches WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    return rows[0] ? toImportBatch(rows[0]) : null;
  }

  /** Rows of a batch in file order, optionally only valid or invalid ones. */
  async listRows(
    organizationId: string,
    batchId: string,
    query: ImportRowQuery,
  ): Promise<{ rows: ImportRow[]; hasMore: boolean }> {
    const { rows } = await this.pool.query<ImportRowRecord>(
      `SELECT row_number, cells, mapped_values, sku_id, warehouse_id, event_type,
              quantity_delta, reason, reference, occurred_at, errors
         FROM import_rows
        WHERE organization_id = $1 AND batch_id = $2
          AND ($3::text IS NULL OR ($3::text = 'valid') = (jsonb_array_length(errors) = 0))
        ORDER BY row_number
        LIMIT $4 OFFSET $5`,
      [organizationId, batchId, query.status, query.limit + 1, query.offset],
    );
    return {
      rows: rows.slice(0, query.limit).map(toImportRow),
      hasMore: rows.length > query.limit,
    };
  }
}
