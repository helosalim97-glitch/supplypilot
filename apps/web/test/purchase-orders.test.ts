import { describe, expect, it } from 'vitest';
import {
  availableActions,
  buildReceiptPayload,
  canReceive,
  describeAuditAction,
  formatCents,
  listApiQuery,
  listHref,
  mapReceiptErrors,
  parseListParams,
  parseReason,
  quantityField,
  type PurchaseOrderSummary,
} from '@/lib/purchase-orders';

function form(values: Record<string, string>): Pick<FormData, 'get'> {
  return { get: (name: string) => values[name] ?? null };
}

const lines = [
  { id: 'line-a', quantityOutstanding: 400 },
  { id: 'line-b', quantityOutstanding: 24 },
];

describe('availableActions', () => {
  it('mirrors the API state machine per role', () => {
    expect(availableActions('draft', 'viewer')).toEqual([]);
    expect(availableActions('draft', 'buyer')).toEqual(['submit', 'cancel']);
    expect(availableActions('submitted', 'buyer')).toEqual(['cancel']);
    expect(availableActions('submitted', 'manager')).toEqual(['approve', 'reject', 'cancel']);
    expect(availableActions('approved', 'buyer')).toEqual([]);
    expect(availableActions('approved', 'manager')).toEqual(['cancel']);
    expect(availableActions('rejected', 'buyer')).toEqual(['reopen']);
    expect(availableActions('partially_received', 'owner')).toEqual([]);
    expect(availableActions('received', 'owner')).toEqual([]);
    expect(availableActions('cancelled', 'owner')).toEqual([]);
  });
});

describe('canReceive', () => {
  const order = (status: PurchaseOrderSummary['status'], received = 0) =>
    ({ status, totalUnits: 424, totalUnitsReceived: received }) as PurchaseOrderSummary;

  it('allows buyers on approved and partially received orders with units outstanding', () => {
    expect(canReceive(order('approved'), 'buyer')).toBe(true);
    expect(canReceive(order('partially_received', 100), 'manager')).toBe(true);
  });

  it('refuses viewers, other statuses and fully received orders', () => {
    expect(canReceive(order('approved'), 'viewer')).toBe(false);
    expect(canReceive(order('submitted'), 'owner')).toBe(false);
    expect(canReceive(order('received', 424), 'owner')).toBe(false);
    expect(canReceive(order('partially_received', 424), 'owner')).toBe(false);
  });
});

describe('buildReceiptPayload', () => {
  it('skips blank and zero lines so partial deliveries need no extra input', () => {
    const result = buildReceiptPayload(
      form({ [quantityField('line-a')]: ' 150 ', [quantityField('line-b')]: '0', reference: ' DN-7781 ' }),
      lines,
    );
    expect(result).toEqual({
      payload: { lines: [{ lineId: 'line-a', quantity: 150 }], reference: 'DN-7781', notes: null },
    });
  });

  it('rejects quantities above what is outstanding and non-integers', () => {
    const result = buildReceiptPayload(
      form({ [quantityField('line-a')]: '401', [quantityField('line-b')]: '2.5' }),
      lines,
    );
    expect(result).toEqual({
      errors: {
        [quantityField('line-a')]: 'Only 400 outstanding',
        [quantityField('line-b')]: 'Enter a whole number of units',
      },
    });
  });

  it('needs at least one line', () => {
    expect(buildReceiptPayload(form({}), lines)).toEqual({
      errors: { form: 'Enter the quantity received for at least one line' },
    });
  });

  it('limits the reference length', () => {
    const result = buildReceiptPayload(
      form({ [quantityField('line-a')]: '1', reference: 'x'.repeat(121) }),
      lines,
    );
    expect(result).toEqual({ errors: { reference: 'At most 120 characters' } });
  });
});

describe('mapReceiptErrors', () => {
  it('maps API line indexes back to the inputs that were sent', () => {
    const sent = [
      { lineId: 'line-b', quantity: 30 },
      { lineId: 'line-a', quantity: 1 },
    ];
    expect(
      mapReceiptErrors(
        [
          { field: 'lines[0].quantity', message: 'is more than the 24 unit(s) still outstanding' },
          { field: 'Idempotency-Key', message: 'was already used' },
        ],
        sent,
      ),
    ).toEqual({
      [quantityField('line-b')]: 'is more than the 24 unit(s) still outstanding',
      form: 'was already used',
    });
  });
});

describe('parseReason', () => {
  it('requires a reason to reject or cancel', () => {
    expect(parseReason('reject', '  ')).toEqual({ error: 'A reason is required to reject an order' });
    expect(parseReason('cancel', null)).toEqual({ error: 'A reason is required to cancel an order' });
    expect(parseReason('reject', ' Price too high ')).toEqual({ reason: 'Price too high' });
  });

  it('keeps the comment optional elsewhere', () => {
    expect(parseReason('approve', '')).toEqual({ reason: null });
    expect(parseReason('submit', null)).toEqual({ reason: null });
    expect(parseReason('approve', 'x'.repeat(501))).toEqual({ error: 'At most 500 characters' });
  });
});

describe('list parameters', () => {
  it('ignores unknown statuses and snaps offsets to the page size', () => {
    expect(parseListParams({ status: 'shipped', offset: '30' })).toEqual({ status: null, offset: 25 });
    expect(parseListParams({ status: 'submitted', offset: '-5' })).toEqual({ status: 'submitted', offset: 0 });
    expect(parseListParams({ status: ['approved', 'draft'] })).toEqual({ status: 'approved', offset: 0 });
  });

  it('builds page links and API queries', () => {
    expect(listHref('/po', { status: null, offset: 0 })).toBe('/po');
    expect(listHref('/po', { status: 'approved', offset: 50 })).toBe('/po?status=approved&offset=50');
    expect(listApiQuery({ status: 'draft', offset: 25 })).toBe('limit=25&offset=25&status=draft');
  });
});

describe('formatting', () => {
  it('formats cents and audit actions', () => {
    expect(formatCents(123456)).toBe('1,234.56');
    expect(formatCents(5)).toBe('0.05');
    expect(describeAuditAction('purchase_order.goods_received')).toBe('Goods received');
  });
});
