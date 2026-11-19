import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import { TenantGuard } from '../src/auth/tenant.guard';
import { UnknownReferenceError } from '../src/catalog/catalog.repository';
import { loadImportWorkerConfig } from '../src/config';
import { configureApp } from '../src/http/configure-app';
import { ImportApplier, planApply } from '../src/imports/import-apply';
import { ImportWorker } from '../src/imports/import-worker';
import { ImportsController } from '../src/imports/imports.controller';
import type { ImportBatch, ImportRow, RowOutcome } from '../src/imports/imports.models';
import { ClaimLostError, ImportsRepository } from '../src/imports/imports.repository';
import {
  InsufficientStockError,
  InventoryRepository,
  movementHash,
} from '../src/inventory/inventory.repository';

const ORG = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const SKU = '9a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const WAREHOUSE = '7c2d3e4f-5a6b-4c7d-8e9f-000000000001';
const BATCH = '3c4d5e6f-7a8b-4c9d-8e0f-000000000001';
const MANAGER = '1d2e3f4a-5b6c-4d7e-8f9a-000000000001';
const UPLOADED_AT = '2026-11-19T09:00:00.000Z';

beforeAll(() => Logger.overrideLogger(false));

type Movement = NonNullable<ImportRow['movement']>;

function row(rowNumber: number, overrides: Partial<Movement> = {}): ImportRow {
  return {
    rowNumber,
    status: 'valid',
    cells: [],
    values: {},
    movement: {
      skuId: SKU,
      warehouseId: WAREHOUSE,
      type: 'receipt',
      quantityDelta: 10,
      reason: null,
      reference: `PO-${rowNumber}`,
      occurredAt: '2026-11-18T00:00:00.000Z',
      ...overrides,
    },
    errors: [],
    outcome: null,
  };
}

function batch(
  overrides: Partial<ImportBatch> = {},
  apply: Partial<ImportBatch['apply']> = {},
): ImportBatch {
  return {
    id: BATCH,
    organizationId: ORG,
    kind: 'stock_movements',
    fileName: 'moves.csv',
    fileSha256: 'a'.repeat(64),
    delimiter: ',',
    columns: [],
    mapping: {
      skuCode: 'SKU',
      warehouseCode: 'Warehouse',
      type: null,
      quantity: 'Qty',
      reason: null,
      reference: null,
      occurredAt: null,
    },
    defaultType: 'receipt',
    status: 'applying',
    rowCount: 3,
    validCount: 3,
    invalidCount: 0,
    createdBy: MANAGER,
    createdAt: UPLOADED_AT,
    apply: {
      requestedBy: MANAGER,
      queuedAt: '2026-11-19T09:05:00.000Z',
      startedAt: '2026-11-19T09:05:01.000Z',
      finishedAt: null,
      attempts: 1,
      appliedCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
      failureReason: null,
      ...apply,
    },
    ...overrides,
  };
}

describe('planApply', () => {
  it('keys each movement by its content and marks repeats within the file', () => {
    const plan = planApply([row(4), row(2), row(3, { reference: 'PO-2' })], UPLOADED_AT);
    expect(plan.map((p) => [p.rowNumber, p.duplicateOfRow])).toEqual([
      [2, null],
      [3, 2],
      [4, null],
    ]);
    expect(plan[0].idempotencyKey).toBe(`import:${movementHash(plan[0].movement)}`);
    expect(plan[0].idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
    expect(plan[1].idempotencyKey).toBe(plan[0].idempotencyKey);
    expect(plan[0].movement.correctsEventId).toBeNull();
  });

  it('stamps undated rows with the upload time so the key is stable', () => {
    const [undated] = planApply([row(2, { occurredAt: null })], UPLOADED_AT);
    expect(undated.movement.occurredAt).toBe(UPLOADED_AT);
    const [again] = planApply([row(2, { occurredAt: null })], UPLOADED_AT);
    expect(again.idempotencyKey).toBe(undated.idempotencyKey);
    const [later] = planApply([row(2, { occurredAt: null })], '2026-11-20T09:00:00.000Z');
    expect(later.idempotencyKey).not.toBe(undated.idempotencyKey);
  });

  it('skips invalid rows and flags rows that already have an outcome', () => {
    const invalid: ImportRow = { ...row(3), status: 'invalid', movement: null };
    const applied: ImportRow = {
      ...row(2),
      outcome: { outcome: 'applied', eventId: 'e1', duplicateOfRow: null, message: null },
    };
    const plan = planApply([applied, invalid, row(4)], UPLOADED_AT);
    expect(plan.map((p) => [p.rowNumber, p.done])).toEqual([
      [2, true],
      [4, false],
    ]);
  });
});

describe('ImportApplier', () => {
  function setup(rows: ImportRow[]) {
    const imports = {
      listValidRows: jest.fn(async () => rows),
      recordOutcome: jest.fn(async (..._args: unknown[]) => undefined),
      finishBatch: jest.fn(async () => batch({ status: 'applied' })),
      failBatch: jest.fn(async () => null),
    };
    let next = 0;
    const inventory = {
      recordMovement: jest.fn(async (..._args: unknown[]) => ({
        event: { id: `event-${++next}`, recordedAt: '2026-11-19T09:05:02.000Z' },
        replayed: false,
      })),
    };
    const applier = new ImportApplier(
      imports as unknown as ImportsRepository,
      inventory as unknown as InventoryRepository,
    );
    const outcomes = () =>
      imports.recordOutcome.mock.calls.map((c) => [c[3] as number, c[4] as RowOutcome] as const);
    return { imports, inventory, applier, outcomes };
  }

  it('records rows in file order as the requester and stores each outcome', async () => {
    const { imports, inventory, applier, outcomes } = setup([row(2), row(3)]);
    const result = await applier.apply(batch());

    expect(inventory.recordMovement).toHaveBeenCalledTimes(2);
    const [org, user, key, movement] = inventory.recordMovement.mock.calls[0];
    expect([org, user]).toEqual([ORG, MANAGER]);
    expect(key).toMatch(/^import:[0-9a-f]{64}$/);
    expect(movement).toMatchObject({ skuId: SKU, quantityDelta: 10, reference: 'PO-2' });
    expect(outcomes()).toEqual([
      [2, { outcome: 'applied', eventId: 'event-1', duplicateOfRow: null, message: null }],
      [3, { outcome: 'applied', eventId: 'event-2', duplicateOfRow: null, message: null }],
    ]);
    expect(imports.recordOutcome.mock.calls[0].slice(0, 3)).toEqual([ORG, BATCH, 1]);
    expect(imports.finishBatch).toHaveBeenCalledWith(ORG, BATCH, 1);
    expect(result?.status).toBe('applied');
  });

  it('skips repeats within the file and movements already in the ledger', async () => {
    const { inventory, applier, outcomes } = setup([row(2), row(3, { reference: 'PO-2' }), row(4)]);
    inventory.recordMovement
      .mockResolvedValueOnce({ event: { id: 'event-1', recordedAt: 'x' }, replayed: false })
      .mockResolvedValueOnce({
        event: { id: 'event-old', recordedAt: '2026-11-18T10:00:00.000Z' },
        replayed: true,
      });
    await applier.apply(batch());

    expect(inventory.recordMovement).toHaveBeenCalledTimes(2);
    expect(outcomes()).toEqual([
      [2, { outcome: 'applied', eventId: 'event-1', duplicateOfRow: null, message: null }],
      [3, { outcome: 'duplicate', eventId: null, duplicateOfRow: 2, message: 'Same movement as row 2' }],
      [
        4,
        {
          outcome: 'duplicate',
          eventId: 'event-old',
          duplicateOfRow: null,
          message: 'Already in the stock ledger (recorded 2026-11-18T10:00:00.000Z)',
        },
      ],
    ]);
  });

  it('rejects rows the ledger refuses and carries on', async () => {
    const { inventory, imports, applier, outcomes } = setup([
      row(2, { type: 'issue', quantityDelta: -5 }),
      row(3),
      row(4),
    ]);
    inventory.recordMovement
      .mockRejectedValueOnce(new InsufficientStockError(2, -5))
      .mockRejectedValueOnce(new UnknownReferenceError('skuId'));
    await applier.apply(batch());

    expect(outcomes().map(([n, o]) => [n, o.outcome, o.message])).toEqual([
      [2, 'rejected', 'Would take on-hand stock of 2 below zero (quantity -5)'],
      [3, 'rejected', 'The SKU is no longer active in this organization'],
      [4, 'applied', null],
    ]);
    expect(imports.finishBatch).toHaveBeenCalled();
    expect(imports.failBatch).not.toHaveBeenCalled();
  });

  it('resumes after the rows an earlier attempt already applied', async () => {
    const done: ImportRow = {
      ...row(2),
      outcome: { outcome: 'applied', eventId: 'event-1', duplicateOfRow: null, message: null },
    };
    const { inventory, applier, outcomes } = setup([done, row(3)]);
    await applier.apply(batch({}, { attempts: 2 }));
    expect(inventory.recordMovement).toHaveBeenCalledTimes(1);
    expect(outcomes().map(([n]) => n)).toEqual([3]);
  });

  it('fails the batch on an unexpected error, keeping earlier outcomes', async () => {
    const { inventory, imports, applier } = setup([row(2), row(3)]);
    inventory.recordMovement
      .mockResolvedValueOnce({ event: { id: 'event-1', recordedAt: 'x' }, replayed: false })
      .mockRejectedValueOnce(new Error('connection terminated'));
    const result = await applier.apply(batch());

    expect(result).toBeNull();
    expect(imports.recordOutcome).toHaveBeenCalledTimes(1);
    expect(imports.finishBatch).not.toHaveBeenCalled();
    expect(imports.failBatch).toHaveBeenCalledWith(
      ORG,
      BATCH,
      1,
      'Applying stopped at row 3 because of an unexpected error; apply the import again to continue',
    );
  });

  it('stops quietly when another worker took the batch over', async () => {
    const { imports, applier } = setup([row(2), row(3)]);
    imports.recordOutcome.mockRejectedValueOnce(new ClaimLostError(BATCH));
    expect(await applier.apply(batch())).toBeNull();
    expect(imports.failBatch).not.toHaveBeenCalled();
    expect(imports.finishBatch).not.toHaveBeenCalled();
  });
});

describe('ImportWorker', () => {
  const config = { pollMs: 1000, staleAfterSeconds: 600 };

  it('applies queued batches until the queue is empty', async () => {
    const imports = {
      claimNextBatch: jest
        .fn()
        .mockResolvedValueOnce(batch())
        .mockResolvedValueOnce(batch({ id: 'second' }))
        .mockResolvedValueOnce(null),
    };
    const applier = { apply: jest.fn(async (b: ImportBatch) => b) };
    const worker = new ImportWorker(
      imports as unknown as ImportsRepository,
      applier as unknown as ImportApplier,
      config,
    );
    expect(await worker.drain()).toBe(2);
    expect(imports.claimNextBatch).toHaveBeenCalledWith(600);
    expect(applier.apply.mock.calls.map((c) => c[0].id)).toEqual([BATCH, 'second']);
  });

  it('runs one drain at a time', async () => {
    let release: (value: null) => void = () => undefined;
    const imports = {
      claimNextBatch: jest.fn(() => new Promise<null>((resolve) => (release = resolve))),
    };
    const worker = new ImportWorker(
      imports as unknown as ImportsRepository,
      { apply: jest.fn() } as unknown as ImportApplier,
      config,
    );
    const first = worker.tick();
    const second = worker.tick();
    expect(second).toBe(first);
    release(null);
    await first;
    expect(imports.claimNextBatch).toHaveBeenCalledTimes(1);
  });
});

describe('loadImportWorkerConfig', () => {
  it('uses defaults and reads overrides', () => {
    expect(loadImportWorkerConfig({})).toEqual({ pollMs: 2000, staleAfterSeconds: 600 });
    expect(
      loadImportWorkerConfig({ IMPORT_WORKER_POLL_MS: '0', IMPORT_STALE_AFTER_SECONDS: '120' }),
    ).toEqual({ pollMs: 0, staleAfterSeconds: 120 });
  });

  it('rejects values out of range', () => {
    expect(() => loadImportWorkerConfig({ IMPORT_WORKER_POLL_MS: '-1' })).toThrow(
      /IMPORT_WORKER_POLL_MS/,
    );
    expect(() => loadImportWorkerConfig({ IMPORT_STALE_AFTER_SECONDS: '5' })).toThrow(
      /IMPORT_STALE_AFTER_SECONDS/,
    );
  });
});

describe('ImportsRepository apply queries', () => {
  function fakePool(...results: unknown[][]) {
    const queue = [...results];
    return {
      query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: queue.shift() ?? [] })),
    };
  }
  const repoWith = (pool: ReturnType<typeof fakePool>) =>
    new ImportsRepository(pool as unknown as Pick<Pool, 'query'>);

  it('only queues previewed or failed batches with valid rows', async () => {
    const pool = fakePool([]);
    expect(await repoWith(pool).requestApply(ORG, BATCH, MANAGER)).toBeNull();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status IN ('previewed', 'failed') AND valid_count > 0");
    expect(sql).toContain('failure_reason = NULL');
    expect(params).toEqual([ORG, BATCH, MANAGER]);
  });

  it('claims with SKIP LOCKED and takes over stale attempts', async () => {
    const pool = fakePool([]);
    await repoWith(pool).claimNextBatch(600);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'applying' AND started_at < now() - make_interval(secs => $1)");
    expect(sql).toContain('attempts = attempts + 1');
    expect(params).toEqual([600]);
  });

  it('writes an outcome only for the claimed attempt and an unprocessed row', async () => {
    const pool = fakePool([{ row_number: 2 }], []);
    const outcome: RowOutcome = {
      outcome: 'applied',
      eventId: 'e1',
      duplicateOfRow: null,
      message: null,
    };
    await repoWith(pool).recordOutcome(ORG, BATCH, 3, 2, outcome);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('r.outcome IS NULL');
    expect(sql).toContain("b.status = 'applying' AND b.attempts = $3");
    expect(params).toEqual([ORG, BATCH, 3, 2, 'applied', 'e1', null, null]);
    await expect(repoWith(pool).recordOutcome(ORG, BATCH, 3, 2, outcome)).rejects.toBeInstanceOf(
      ClaimLostError,
    );
  });

  it('closes the attempt with outcome counts', async () => {
    const pool = fakePool([]);
    await expect(repoWith(pool).finishBatch(ORG, BATCH, 1)).rejects.toBeInstanceOf(ClaimLostError);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'applied', finished_at = now()");
    expect(sql).toContain("count(*) FILTER (WHERE outcome = 'duplicate')");
    expect(sql).toContain('b.attempts = $3');
    expect(params).toEqual([ORG, BATCH, 1]);
  });
});

describe('POST /v1/organizations/:orgId/imports/:importId/apply', () => {
  const TOKENS: Record<string, { userId: string; role: 'viewer' | 'buyer' | 'manager' }> = {
    'viewer-token-0123456789': { userId: 'u-viewer', role: 'viewer' },
    'manager-token-0123456789': { userId: MANAGER, role: 'manager' },
  };
  let app: INestApplication;
  let imports: { requestApply: jest.Mock; findBatch: jest.Mock };

  beforeEach(async () => {
    imports = { requestApply: jest.fn(async () => null), findBatch: jest.fn(async () => null) };
    const moduleRef = await Test.createTestingModule({
      controllers: [ImportsController],
      providers: [
        TenantGuard,
        {
          provide: AuthRepository,
          useValue: {
            findUserIdByToken: jest.fn(async (token: string) => TOKENS[token]?.userId ?? null),
            findRole: jest.fn(async (userId: string, organizationId: string) => {
              const entry = Object.values(TOKENS).find((t) => t.userId === userId);
              return entry && organizationId === ORG ? entry.role : null;
            }),
            listMemberships: jest.fn(async () => []),
          },
        },
        { provide: ImportsRepository, useValue: imports },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const apply = (token = 'manager-token-0123456789', id = BATCH) =>
    request(app.getHttpServer())
      .post(`/v1/organizations/${ORG}/imports/${id}/apply`)
      .set('Authorization', `Bearer ${token}`);

  it('queues the batch and returns 202', async () => {
    imports.requestApply.mockResolvedValue(batch({ status: 'queued' }));
    const res = await apply().expect(202);
    expect(imports.requestApply).toHaveBeenCalledWith(ORG, BATCH, MANAGER);
    expect(res.body.data).toMatchObject({ id: BATCH, status: 'queued' });
    expect(imports.findBatch).not.toHaveBeenCalled();
  });

  it.each(['queued', 'applying'] as const)('is a no-op 202 while the batch is %s', async (status) => {
    imports.findBatch.mockResolvedValue(batch({ status }));
    const res = await apply().expect(202);
    expect(res.body.data.status).toBe(status);
  });

  it('returns 409 for an applied batch and 422 when nothing is valid', async () => {
    imports.findBatch.mockResolvedValueOnce(batch({ status: 'applied' }));
    expect((await apply().expect(409)).body.error.code).toBe('import_already_applied');
    imports.findBatch.mockResolvedValueOnce(batch({ status: 'previewed', validCount: 0 }));
    expect((await apply().expect(422)).body.error.code).toBe('nothing_to_apply');
  });

  it('returns 404 for an unknown or malformed id and 403 for a viewer', async () => {
    expect((await apply(undefined, BATCH).expect(404)).body.error.code).toBe('not_found');
    await apply(undefined, 'not-a-uuid').expect(404);
    await apply('viewer-token-0123456789').expect(403);
    expect(imports.requestApply).toHaveBeenCalledTimes(1);
  });

  it('filters rows by outcome', async () => {
    imports.findBatch.mockResolvedValue(batch({ status: 'applied' }));
    const listRows = jest.fn(async () => ({ rows: [], hasMore: false }));
    (imports as unknown as { listRows: jest.Mock }).listRows = listRows;
    await request(app.getHttpServer())
      .get(`/v1/organizations/${ORG}/imports/${BATCH}?outcome=rejected`)
      .set('Authorization', 'Bearer viewer-token-0123456789')
      .expect(200);
    expect(listRows).toHaveBeenCalledWith(ORG, BATCH, {
      status: null,
      outcome: 'rejected',
      limit: 50,
      offset: 0,
    });
  });
});

describe('0007_import_apply_jobs migration', () => {
  let sql: string;

  beforeAll(async () => {
    sql = await readFile(join(__dirname, '..', 'migrations', '0007_import_apply_jobs.sql'), 'utf8');
  });

  it('adds the apply states and per-row outcomes', () => {
    expect(sql).toContain("CHECK (status IN ('previewed', 'queued', 'applying', 'applied', 'failed'))");
    expect(sql).toContain("CHECK (outcome IN ('applied', 'duplicate', 'rejected'))");
    expect(sql).toContain('CONSTRAINT import_rows_outcome_only_valid');
  });

  it('links outcomes to ledger events of the same organization', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, event_id\)\s+REFERENCES inventory_events \(organization_id, id\)/,
    );
  });
});
