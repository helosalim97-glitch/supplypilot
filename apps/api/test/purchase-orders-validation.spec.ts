import { ValidationError } from '../src/http/api-error';
import {
  DEFAULT_ORDER_LIMIT,
  isCalendarDate,
  MAX_LINES,
  parseLineReplacement,
  parseNewPurchaseOrder,
  parsePurchaseOrderQuery,
  parseTransition,
} from '../src/purchasing/purchasing.validation';

const SUPPLIER = '6c1f2d3e-0000-4000-8000-000000000001';
const WAREHOUSE = '6c1f2d3e-0000-4000-8000-000000000002';
const SKU_A = '6c1f2d3e-0000-4000-8000-0000000000a1';
const SKU_B = '6c1f2d3e-0000-4000-8000-0000000000b2';

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return (error.details ?? []).map((d) => d.field);
    throw error;
  }
  throw new Error('expected a ValidationError');
}

const valid = {
  supplierId: SUPPLIER,
  warehouseId: WAREHOUSE,
  lines: [{ skuId: SKU_A, quantity: 12 }],
};

describe('parseNewPurchaseOrder', () => {
  it('accepts a minimal order and fills optional fields with null', () => {
    expect(parseNewPurchaseOrder(valid)).toEqual({
      supplierId: SUPPLIER,
      warehouseId: WAREHOUSE,
      expectedOn: null,
      notes: null,
      lines: [{ skuId: SKU_A, quantity: 12, unitCostCents: null }],
    });
  });

  it('keeps an explicit unit cost, expected date and trimmed notes', () => {
    const order = parseNewPurchaseOrder({
      ...valid,
      expectedOn: '2026-12-04',
      notes: '  Deliver to dock 2 ',
      lines: [{ skuId: SKU_A.toUpperCase(), quantity: 3, unitCostCents: 0 }],
    });
    expect(order.expectedOn).toBe('2026-12-04');
    expect(order.notes).toBe('Deliver to dock 2');
    expect(order.lines).toEqual([{ skuId: SKU_A, quantity: 3, unitCostCents: 0 }]);
  });

  it('reports every invalid field with its line index', () => {
    expect(
      fieldsOf(() =>
        parseNewPurchaseOrder({
          supplierId: 'acme',
          expectedOn: '2026-02-30',
          extra: true,
          lines: [
            { skuId: SKU_A, quantity: 0 },
            { skuId: 'nope', quantity: 1.5, unitCostCents: -1, colour: 'red' },
          ],
        }),
      ),
    ).toEqual([
      'extra',
      'supplierId',
      'warehouseId',
      'expectedOn',
      'lines[0].quantity',
      'lines[1].colour',
      'lines[1].skuId',
      'lines[1].quantity',
      'lines[1].unitCostCents',
    ]);
  });

  it('rejects the same SKU on two lines, even in another letter case', () => {
    const lines = [
      { skuId: SKU_A, quantity: 1 },
      { skuId: SKU_B, quantity: 1 },
      { skuId: SKU_A.toUpperCase(), quantity: 2 },
    ];
    expect(fieldsOf(() => parseNewPurchaseOrder({ ...valid, lines }))).toEqual(['lines[2].skuId']);
  });

  it('needs between 1 and 200 lines', () => {
    expect(fieldsOf(() => parseNewPurchaseOrder({ ...valid, lines: [] }))).toEqual(['lines']);
    expect(fieldsOf(() => parseNewPurchaseOrder({ ...valid, lines: undefined }))).toEqual(['lines']);
    const tooMany = Array.from({ length: MAX_LINES + 1 }, () => ({ skuId: SKU_A, quantity: 1 }));
    expect(fieldsOf(() => parseNewPurchaseOrder({ ...valid, lines: tooMany }))).toEqual(['lines']);
  });

  it('caps quantity × unit cost per line', () => {
    const lines = [{ skuId: SKU_A, quantity: 1_000_000, unitCostCents: 2_000_000_000 }];
    expect(fieldsOf(() => parseNewPurchaseOrder({ ...valid, lines }))).toEqual([
      'lines[0].unitCostCents',
    ]);
  });

  it('refuses a body that is not an object', () => {
    expect(fieldsOf(() => parseNewPurchaseOrder([valid]))).toEqual(['body']);
    expect(fieldsOf(() => parseNewPurchaseOrder(null))).toEqual(['body']);
  });
});

describe('parseLineReplacement', () => {
  it('returns the new line list', () => {
    expect(parseLineReplacement({ lines: [{ skuId: SKU_B, quantity: 4, unitCostCents: 95 }] }))
      .toEqual([{ skuId: SKU_B, quantity: 4, unitCostCents: 95 }]);
  });

  it('only accepts the lines field', () => {
    expect(fieldsOf(() => parseLineReplacement({ lines: valid.lines, notes: 'x' }))).toEqual([
      'notes',
    ]);
  });
});

describe('parsePurchaseOrderQuery', () => {
  it('defaults to the first page without filters', () => {
    expect(parsePurchaseOrderQuery({})).toEqual({
      status: null,
      supplierId: null,
      warehouseId: null,
      limit: DEFAULT_ORDER_LIMIT,
      offset: 0,
    });
  });

  it('parses filters and paging', () => {
    expect(
      parsePurchaseOrderQuery({ status: 'draft', supplierId: SUPPLIER, limit: '10', offset: '20' }),
    ).toEqual({ status: 'draft', supplierId: SUPPLIER, warehouseId: null, limit: 10, offset: 20 });
  });

  it('rejects unknown statuses, parameters and out-of-range paging', () => {
    expect(
      fieldsOf(() => parsePurchaseOrderQuery({ status: 'open', sort: 'number', limit: '0' })),
    ).toEqual(['sort', 'status', 'limit']);
  });
});

describe('isCalendarDate', () => {
  it.each(['2026-12-31', '2028-02-29'])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-1-05', '26-01-05', '1999-12-31'])(
    'rejects %s',
    (value) => {
      expect(isCalendarDate(value)).toBe(false);
    },
  );
});

describe('parseTransition', () => {
  it('accepts an empty or missing body where no reason is needed', () => {
    expect(parseTransition('submit', undefined)).toEqual({ reason: null });
    expect(parseTransition('approve', {})).toEqual({ reason: null });
    expect(parseTransition('reopen', { reason: null })).toEqual({ reason: null });
  });

  it('trims the reason', () => {
    expect(parseTransition('approve', { reason: '  Within Q4 budget ' })).toEqual({
      reason: 'Within Q4 budget',
    });
  });

  it('requires a reason to reject or cancel', () => {
    for (const action of ['reject', 'cancel'] as const) {
      expect(fieldsOf(() => parseTransition(action, {}))).toEqual(['reason']);
      expect(parseTransition(action, { reason: 'Supplier price too high' }).reason).toBe(
        'Supplier price too high',
      );
    }
  });

  it('reports a blank, over-long or non-string reason once', () => {
    for (const reason of ['   ', 'x'.repeat(501), 42]) {
      expect(fieldsOf(() => parseTransition('reject', { reason }))).toEqual(['reason']);
    }
    expect(parseTransition('approve', { reason: 'x'.repeat(500) }).reason).toHaveLength(500);
  });

  it('rejects unknown fields and non-object bodies', () => {
    expect(fieldsOf(() => parseTransition('approve', { status: 'approved' }))).toEqual(['status']);
    expect(fieldsOf(() => parseTransition('approve', ['reason']))).toEqual(['body']);
  });
});
