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
  type RowOutcome,
} from './imports.models';

/**
 * The batch is no longer in the attempt this worker claimed (a stale attempt
 * was taken over by another worker). Stop without touching it.
 */
export class ClaimLostError extends Error {
  constructor(readonly batchId: string) {
    super(`Import ${batchId} is no longer claimed by this attempt`);
    this.name = 'ClaimLostError';
  }
}

const BATCH_COLUMNS =
  'id, organization_id, kind, file_name, file_sha256, delimiter, columns, column_mapping, ' +
  'default_type, status, row_count, valid_count, created_by, created_at, applied_by, ' +
  'queued_at, started_at, finished_at, attempts, applied_count, duplicate_count, ' +
  'rejected_count, failure_reason';

const ROW_COLUMNS =
  'row_number, cells, mapped_values, sku_id, warehouse_id, event_type, quantity_delta, ' +
  'reason, reference, occurred_at, errors, outcome, event_id, duplicate_of_row, outcome_message';

/**
 * Closes the attempt a worker claimed, with the outcome counts of its rows.
 * `$3` is the claimed attempt number: a stale worker cannot close a batch
 * another worker has taken over.
 */
const closeBatchSql = (assignments: string) => `UPDATE import_batches b
     SET ${assignments},
         applied_count = c.applied, duplicate_count = c.duplicate, rejected_count = c.rejected
    FROM (SELECT count(*) FILTER (WHERE outcome = 'applied')::int AS applied,
                 count(*) FILTER (WHERE outcome = 'duplicate')::int AS duplicate,
                 count(*) FILTER (WHERE outcome = 'rejected')::int AS rejected
            FROM import_rows WHERE organization_id = $1 AND batch_id = $2) c
   WHERE b.organization_id = $1 AND b.id = $2 AND b.status = 'applying' AND b.attempts = $3
   RETURNING ${BATCH_COLUMNS.split(', ').map((c) => `b.${c}`).join(', ')}`;

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

  /** Rows of a batch in file order, optionally only valid/invalid rows or one outcome. */
  async listRows(
    organizationId: string,
    batchId: string,
    query: ImportRowQuery,
  ): Promise<{ rows: ImportRow[]; hasMore: boolean }> {
    const { rows } = await this.pool.query<ImportRowRecord>(
      `SELECT ${ROW_COLUMNS}
         FROM import_rows
        WHERE organization_id = $1 AND batch_id = $2
          AND ($3::text IS NULL OR ($3::text = 'valid') = (jsonb_array_length(errors) = 0))
          AND ($4::text IS NULL OR outcome = $4::text)
        ORDER BY row_number
        LIMIT $5 OFFSET $6`,
      [organizationId, batchId, query.status, query.outcome, query.limit + 1, query.offset],
    );
    return {
      rows: rows.slice(0, query.limit).map(toImportRow),
      hasMore: rows.length > query.limit,
    };
  }

  /**
   * Queues a previewed batch, or a failed one again, for the import worker.
   * Returns null when the batch is not in a state that can be queued (or has
   * no valid rows); the caller looks it up to say why.
   */
  async requestApply(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<ImportBatch | null> {
    const { rows } = await this.pool.query<ImportBatchRow>(
      `UPDATE import_batches
          SET status = 'queued', applied_by = $3, queued_at = now(), failure_reason = NULL
        WHERE organization_id = $1 AND id = $2
          AND status IN ('previewed', 'failed') AND valid_count > 0
        RETURNING ${BATCH_COLUMNS}`,
      [organizationId, id, userId],
    );
    return rows[0] ? toImportBatch(rows[0]) : null;
  }

  /**
   * Claims the oldest queued batch of any organization, or one whose attempt
   * has been `applying` for longer than `staleAfterSeconds` (its worker died).
   * SKIP LOCKED lets several workers poll without taking the same batch.
   */
  async claimNextBatch(staleAfterSeconds: number): Promise<ImportBatch | null> {
    const { rows } = await this.pool.query<ImportBatchRow>(
      `UPDATE import_batches
          SET status = 'applying', started_at = now(), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM import_batches
           WHERE status = 'queued'
              OR (status = 'applying' AND started_at < now() - make_interval(secs => $1))
           ORDER BY queued_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING ${BATCH_COLUMNS}`,
      [staleAfterSeconds],
    );
    return rows[0] ? toImportBatch(rows[0]) : null;
  }

  /** Valid rows of a batch in file order, with any outcome already stored. */
  async listValidRows(organizationId: string, batchId: string): Promise<ImportRow[]> {
    const { rows } = await this.pool.query<ImportRowRecord>(
      `SELECT ${ROW_COLUMNS}
         FROM import_rows
        WHERE organization_id = $1 AND batch_id = $2 AND jsonb_array_length(errors) = 0
        ORDER BY row_number`,
      [organizationId, batchId],
    );
    return rows.map(toImportRow);
  }

  /**
   * Stores what applying did with one row. Only a row without an outcome, of
   * a batch still in the claimed attempt, is updated; otherwise the attempt
   * lost its claim and ClaimLostError stops it.
   */
  async recordOutcome(
    organizationId: string,
    batchId: string,
    attempt: number,
    rowNumber: number,
    outcome: RowOutcome,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ row_number: number }>(
      `UPDATE import_rows r
          SET outcome = $5, event_id = $6, duplicate_of_row = $7, outcome_message = $8,
              processed_at = now()
         FROM import_batches b
        WHERE r.organization_id = $1 AND r.batch_id = $2 AND r.row_number = $4
          AND r.outcome IS NULL
          AND b.organization_id = r.organization_id AND b.id = r.batch_id
          AND b.status = 'applying' AND b.attempts = $3
        RETURNING r.row_number`,
      [
        organizationId,
        batchId,
        attempt,
        rowNumber,
        outcome.outcome,
        outcome.eventId,
        outcome.duplicateOfRow,
        outcome.message,
      ],
    );
    if (!rows[0]) throw new ClaimLostError(batchId);
  }

  /** Marks the claimed attempt applied, with its outcome counts. */
  async finishBatch(organizationId: string, id: string, attempt: number): Promise<ImportBatch> {
    const { rows } = await this.pool.query<ImportBatchRow>(
      closeBatchSql(`status = 'applied', finished_at = now()`),
      [organizationId, id, attempt],
    );
    if (!rows[0]) throw new ClaimLostError(id);
    return toImportBatch(rows[0]);
  }

  /** Marks the claimed attempt failed; rows applied so far keep their outcome. */
  async failBatch(
    organizationId: string,
    id: string,
    attempt: number,
    reason: string,
  ): Promise<ImportBatch | null> {
    const { rows } = await this.pool.query<ImportBatchRow>(
      closeBatchSql(`status = 'failed', failure_reason = $4`),
      [organizationId, id, attempt, reason],
    );
    return rows[0] ? toImportBatch(rows[0]) : null;
  }
}
