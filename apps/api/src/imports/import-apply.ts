import { Injectable, Logger } from '@nestjs/common';
import { UnknownReferenceError } from '../catalog/catalog.repository';
import type { NewMovement } from '../inventory/inventory.models';
import {
  IdempotencyConflictError,
  InsufficientStockError,
  InventoryRepository,
  movementHash,
  StockOverflowError,
} from '../inventory/inventory.repository';
import type { ImportBatch, ImportRow, RowOutcome } from './imports.models';
import { ClaimLostError, ImportsRepository } from './imports.repository';

/** One valid row, ready to record, in file order. */
export interface PlannedRow {
  rowNumber: number;
  movement: NewMovement;
  /** Ledger idempotency key, derived from the movement itself. */
  idempotencyKey: string;
  /** Earlier row of the same file with exactly the same movement. */
  duplicateOfRow: number | null;
  /** Already has an outcome from an earlier attempt. */
  done: boolean;
}

/**
 * Turns the valid rows of a batch into movements to record. A row without a
 * date is stamped with the upload time (`stampedAt`), so every movement is
 * fully determined by the file. Its idempotency key is `import:` + the
 * movement hash: the same movement imported again, from this file or another,
 * maps to the same key and is not recorded twice. A row identical to an
 * earlier row of the file is marked as its duplicate.
 */
export function planApply(rows: ImportRow[], stampedAt: string): PlannedRow[] {
  const firstRowByHash = new Map<string, number>();
  const plan: PlannedRow[] = [];
  for (const row of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
    if (row.status !== 'valid' || row.movement === null) continue;
    const m = row.movement;
    const movement: NewMovement = {
      skuId: m.skuId,
      warehouseId: m.warehouseId,
      type: m.type,
      quantityDelta: m.quantityDelta,
      reason: m.reason,
      reference: m.reference,
      correctsEventId: null,
      occurredAt: m.occurredAt ?? stampedAt,
    };
    const hash = movementHash(movement);
    const first = firstRowByHash.get(hash);
    if (first === undefined) firstRowByHash.set(hash, row.rowNumber);
    plan.push({
      rowNumber: row.rowNumber,
      movement,
      idempotencyKey: `import:${hash}`,
      duplicateOfRow: first ?? null,
      done: row.outcome !== null,
    });
  }
  return plan;
}

const REFERENCE_LABELS: Record<string, string> = { skuId: 'SKU', warehouseId: 'warehouse' };

/**
 * Applies one claimed batch: records each valid row through the stock ledger
 * in file order and stores the outcome on the row. Rows the ledger refuses
 * (not enough stock, SKU archived since the preview, ...) are rejected with a
 * reason and the rest carry on. Any other error stops the attempt and marks
 * the batch failed; applying it again resumes after the last stored outcome.
 */
@Injectable()
export class ImportApplier {
  private readonly logger = new Logger(ImportApplier.name);

  constructor(
    private readonly imports: ImportsRepository,
    private readonly inventory: InventoryRepository,
  ) {}

  /** Returns the finished batch, or null if the attempt failed or lost its claim. */
  async apply(batch: ImportBatch): Promise<ImportBatch | null> {
    const { organizationId, id } = batch;
    const attempt = batch.apply.attempts;
    let current: number | null = null;
    try {
      const rows = await this.imports.listValidRows(organizationId, id);
      for (const step of planApply(rows, batch.createdAt)) {
        if (step.done) continue;
        current = step.rowNumber;
        const outcome = await this.applyRow(batch, step);
        await this.imports.recordOutcome(organizationId, id, attempt, step.rowNumber, outcome);
      }
      return await this.imports.finishBatch(organizationId, id, attempt);
    } catch (error) {
      if (error instanceof ClaimLostError) {
        this.logger.warn(`Import ${id}: attempt ${attempt} lost its claim, stopping`);
        return null;
      }
      this.logger.error(
        `Import ${id}: attempt ${attempt} stopped at row ${current ?? '-'}`,
        error instanceof Error ? error.stack : String(error),
      );
      const where = current === null ? 'before the first row' : `at row ${current}`;
      await this.imports.failBatch(
        organizationId,
        id,
        attempt,
        `Applying stopped ${where} because of an unexpected error; apply the import again to continue`,
      );
      return null;
    }
  }

  private async applyRow(batch: ImportBatch, step: PlannedRow): Promise<RowOutcome> {
    if (step.duplicateOfRow !== null) {
      return {
        outcome: 'duplicate',
        eventId: null,
        duplicateOfRow: step.duplicateOfRow,
        message: `Same movement as row ${step.duplicateOfRow}`,
      };
    }
    const rejected = (message: string): RowOutcome => ({
      outcome: 'rejected',
      eventId: null,
      duplicateOfRow: null,
      message,
    });
    try {
      const { event, replayed } = await this.inventory.recordMovement(
        batch.organizationId,
        batch.apply.requestedBy as string,
        step.idempotencyKey,
        step.movement,
      );
      return replayed
        ? {
            outcome: 'duplicate',
            eventId: event.id,
            duplicateOfRow: null,
            message: `Already in the stock ledger (recorded ${event.recordedAt})`,
          }
        : { outcome: 'applied', eventId: event.id, duplicateOfRow: null, message: null };
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        return rejected(
          `Would take on-hand stock of ${error.onHand} below zero (quantity ${error.quantityDelta})`,
        );
      }
      if (error instanceof StockOverflowError) return rejected(error.message);
      if (error instanceof UnknownReferenceError) {
        const label = REFERENCE_LABELS[error.field] ?? error.field;
        return rejected(`The ${label} is no longer active in this organization`);
      }
      if (error instanceof IdempotencyConflictError) {
        return rejected('Its idempotency key was already used for a different movement');
      }
      throw error;
    }
  }
}
