import { ValidationError } from '../src/http/api-error';
import {
  InvalidWorkerResponseError,
  parseDecision,
  parseProposalQuery,
  parseRunSettings,
  parseWorkerCandidates,
} from '../src/reorders/reorders.validation';

const ORG = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const SKU = '1c2d3e4f-0000-4000-8000-000000000001';
const WH = '1c2d3e4f-0000-4000-8000-000000000002';
const SUP = '1c2d3e4f-0000-4000-8000-000000000003';

function fields(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return (error.details ?? []).map((d) => d.field);
    throw error;
  }
  throw new Error('expected a ValidationError');
}

function workerCandidate(overrides: Record<string, unknown> = {}) {
  return {
    skuId: SKU,
    skuCode: 'BOX-S',
    warehouseId: WH,
    warehouseCode: 'WH1',
    supplierId: SUP,
    onHand: 10,
    onOrder: 0,
    leadTime: { sampleCount: 5, meanDays: 6.4, stdDevDays: 0.55, reliability: 'consistent' },
    calculation: {
      shouldReorder: true,
      suggestedOrderQty: 51,
      reorderPoint: 28,
      safetyStock: 2,
      orderUpTo: 61,
      inventoryPosition: 10,
      daysOfCover: 2.5,
      warnings: [],
      evidence: { meanDailyDemand: 4, leadTimeDays: 6.4, z: 1.6449 },
    },
    digest: 'a'.repeat(64),
    ...overrides,
  };
}

const response = (candidates: unknown[] = [workerCandidate()], extra: object = {}) => ({
  organizationId: ORG,
  asOf: '2026-11-27T10:00:00Z',
  parameters: { demandWindowDays: 90, serviceLevel: 0.95 },
  candidates,
  skipped: [{ skuId: SKU, skuCode: 'BOX-L', warehouseId: WH, warehouseCode: 'WH2', reason: 'no_demand' }],
  ...extra,
});

describe('parseRunSettings', () => {
  it('accepts an empty body and settings within the worker limits', () => {
    expect(parseRunSettings(undefined)).toEqual({});
    expect(parseRunSettings({ demandWindowDays: 30, serviceLevel: 0.99, reviewPeriodDays: 0 })).toEqual({
      demandWindowDays: 30,
      serviceLevel: 0.99,
      reviewPeriodDays: 0,
    });
  });

  it('reports every bad setting', () => {
    expect(
      fields(() =>
        parseRunSettings({ demandWindowDays: 13.5, serviceLevel: 1, leadTimeWindowDays: '30', skuIds: [] }),
      ),
    ).toEqual(['skuIds', 'demandWindowDays', 'leadTimeWindowDays', 'serviceLevel']);
    expect(fields(() => parseRunSettings([]))).toEqual(['body']);
  });
});

describe('parseDecision', () => {
  it('approves with optional quantity and date', () => {
    expect(parseDecision({ decision: 'approve' })).toEqual({
      decision: 'approve',
      reason: null,
      quantity: null,
      expectedOn: null,
    });
    expect(parseDecision({ decision: 'approve', quantity: 60, expectedOn: '2026-12-10', reason: ' ok ' })).toEqual({
      decision: 'approve',
      reason: 'ok',
      quantity: 60,
      expectedOn: '2026-12-10',
    });
  });

  it('needs a reason to reject and no order details', () => {
    expect(fields(() => parseDecision({ decision: 'reject' }))).toEqual(['reason']);
    expect(
      fields(() => parseDecision({ decision: 'reject', reason: 'Seasonal', quantity: 5, expectedOn: '2026-12-10' })),
    ).toEqual(['quantity', 'expectedOn']);
  });

  it('rejects unknown decisions, fields and bad values', () => {
    expect(
      fields(() => parseDecision({ decision: 'order', quantity: 0, expectedOn: '2026-02-30', supplierId: SUP })),
    ).toEqual(['supplierId', 'decision', 'quantity', 'expectedOn']);
    expect(fields(() => parseDecision(null))).toEqual(['body']);
  });
});

describe('parseProposalQuery', () => {
  it('parses filters and paging', () => {
    expect(parseProposalQuery({ status: 'pending', skuId: SKU.toUpperCase(), limit: '10' })).toEqual({
      status: 'pending',
      skuId: SKU,
      warehouseId: null,
      limit: 10,
      offset: 0,
    });
    expect(fields(() => parseProposalQuery({ status: 'open', warehouseId: 'x', limit: '0', sort: 'qty' }))).toEqual([
      'sort',
      'status',
      'warehouseId',
      'limit',
    ]);
  });
});

describe('parseWorkerCandidates', () => {
  it('keeps the numbers and folds lead time and settings into the evidence', () => {
    const parsed = parseWorkerCandidates(response(), ORG);
    expect(parsed.calculatedAt).toBe('2026-11-27T10:00:00Z');
    expect(parsed.skipped).toHaveLength(1);
    const [c] = parsed.candidates;
    expect(c).toMatchObject({ skuId: SKU, supplierId: SUP, suggestedQty: 51, reorderPoint: 28, onHand: 10 });
    expect(c.evidence).toMatchObject({
      meanDailyDemand: 4,
      inventoryPosition: 10,
      leadTime: { meanDays: 6.4 },
      parameters: { demandWindowDays: 90 },
    });
  });

  it('turns quantities above the order line limit into skipped pairs', () => {
    const huge = workerCandidate({ calculation: { ...workerCandidate().calculation, suggestedOrderQty: 1_000_001 } });
    const parsed = parseWorkerCandidates(response([huge]), ORG);
    expect(parsed.candidates).toEqual([]);
    expect(parsed.skipped.map((s) => s.reason)).toEqual(['no_demand', 'quantity_too_large']);
  });

  it.each([
    ['another organization', { ...response(), organizationId: SKU }],
    ['a bad digest', response([workerCandidate({ digest: 'xyz' })])],
    ['a negative quantity', response([workerCandidate({ onHand: -1 })])],
    ['a fractional quantity', response([workerCandidate({ onOrder: 1.5 })])],
    ['a non-uuid id', response([workerCandidate({ supplierId: "1' OR 1=1" })])],
    ['a repeated pair', response([workerCandidate(), workerCandidate()])],
    ['free-text warnings', response([workerCandidate({ calculation: { ...workerCandidate().calculation, warnings: ['<b>x</b>'] } })])],
    ['no candidates array', { ...response(), candidates: null }],
    ['a zero suggestion', response([workerCandidate({ calculation: { ...workerCandidate().calculation, suggestedOrderQty: 0 } })])],
  ])('refuses %s', (_label, body) => {
    expect(() => parseWorkerCandidates(body, ORG)).toThrow(InvalidWorkerResponseError);
  });
});
