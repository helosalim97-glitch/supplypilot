import { ValidationError } from '../src/http/api-error';
import { parseNewReceipt } from '../src/purchasing/purchasing.validation';
import {
  OverReceiptError,
  PurchaseOrderNotReceivableError,
  UnknownOrderLineError,
  planReceipt,
  receiptEventKey,
  receiptHash,
  type ReceivableLine,
} from '../src/purchasing/receiving';

const LINE_A = '6d1f0c3e-2b7a-4f0e-9c1d-00000000000a';
const LINE_B = '6d1f0c3e-2b7a-4f0e-9c1d-00000000000b';
const ORDER = '6d1f0c3e-2b7a-4f0e-9c1d-0000000000ff';

const lines = (receivedA = 0, receivedB = 0): ReceivableLine[] => [
  { id: LINE_A, lineNumber: 1, skuId: 'sku-a', quantityOrdered: 400, quantityReceived: receivedA },
  { id: LINE_B, lineNumber: 2, skuId: 'sku-b', quantityOrdered: 24, quantityReceived: receivedB },
];

describe('planReceipt', () => {
  it('marks a first delivery that leaves units outstanding as partially received', () => {
    const plan = planReceipt('approved', lines(), [{ lineId: LINE_A, quantity: 250 }]);
    expect(plan.nextStatus).toBe('partially_received');
    expect(plan.units).toBe(250);
    expect(plan.lines).toEqual([{ line: lines()[0], quantity: 250 }]);
  });

  it('marks the order received once every line is complete', () => {
    const plan = planReceipt('partially_received', lines(250, 0), [
      { lineId: LINE_B, quantity: 24 },
      { lineId: LINE_A, quantity: 150 },
    ]);
    expect(plan.nextStatus).toBe('received');
    expect(plan.units).toBe(174);
  });

  it('receives everything in one delivery straight from approved', () => {
    const plan = planReceipt('approved', lines(), [
      { lineId: LINE_A, quantity: 400 },
      { lineId: LINE_B, quantity: 24 },
    ]);
    expect(plan.nextStatus).toBe('received');
  });

  it('stays partially received while a line is still open', () => {
    const plan = planReceipt('partially_received', lines(400, 0), [
      { lineId: LINE_B, quantity: 10 },
    ]);
    expect(plan.nextStatus).toBe('partially_received');
  });

  it.each(['draft', 'submitted', 'rejected', 'cancelled', 'received'] as const)(
    'refuses deliveries for a %s order',
    (status) => {
      expect(() => planReceipt(status, lines(), [{ lineId: LINE_A, quantity: 1 }])).toThrow(
        PurchaseOrderNotReceivableError,
      );
    },
  );

  it('refuses more than is outstanding on a line and names that line', () => {
    try {
      planReceipt('partially_received', lines(390, 0), [
        { lineId: LINE_B, quantity: 1 },
        { lineId: LINE_A, quantity: 11 },
      ]);
      throw new Error('expected OverReceiptError');
    } catch (error) {
      expect(error).toBeInstanceOf(OverReceiptError);
      expect(error).toMatchObject({ index: 1, outstanding: 10 });
    }
  });

  it('refuses a line of another order', () => {
    expect(() =>
      planReceipt('approved', lines(), [
        { lineId: LINE_A, quantity: 1 },
        { lineId: ORDER, quantity: 1 },
      ]),
    ).toThrow(expect.objectContaining({ name: 'UnknownOrderLineError', index: 1 }));
    expect(() => planReceipt('approved', lines(), [{ lineId: ORDER, quantity: 1 }])).toThrow(
      UnknownOrderLineError,
    );
  });
});

describe('receiptHash', () => {
  const base = {
    lines: [
      { lineId: LINE_A, quantity: 250 },
      { lineId: LINE_B, quantity: 24 },
    ],
    reference: 'DN-7781',
    notes: null,
    receivedAt: null,
  };

  it('ignores the order the lines are listed in', () => {
    const reversed = { ...base, lines: [...base.lines].reverse() };
    expect(receiptHash(ORDER, reversed)).toBe(receiptHash(ORDER, base));
  });

  it('differs for another quantity, reference or order', () => {
    const hash = receiptHash(ORDER, base);
    expect(
      receiptHash(ORDER, { ...base, lines: [{ lineId: LINE_A, quantity: 251 }, base.lines[1]] }),
    ).not.toBe(hash);
    expect(receiptHash(ORDER, { ...base, reference: 'DN-7782' })).not.toBe(hash);
    expect(receiptHash(LINE_A, base)).not.toBe(hash);
  });

  it('builds ledger keys the inventory_events key pattern accepts', () => {
    expect(receiptEventKey(ORDER, 200)).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
  });
});

describe('parseNewReceipt', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const fieldsOf = (body: unknown) => {
    try {
      parseNewReceipt(body, now);
    } catch (error) {
      if (error instanceof ValidationError) return (error.details ?? []).map((d) => d.field);
      throw error;
    }
    return [];
  };

  it('accepts lines with an optional reference, notes and arrival time', () => {
    expect(
      parseNewReceipt(
        {
          lines: [{ lineId: LINE_A.toUpperCase(), quantity: 250 }],
          reference: '  DN-7781 ',
          receivedAt: '2026-11-24T09:15:00+01:00',
        },
        now,
      ),
    ).toEqual({
      lines: [{ lineId: LINE_A, quantity: 250 }],
      reference: 'DN-7781',
      notes: null,
      receivedAt: '2026-11-24T08:15:00.000Z',
    });
  });

  it('reports every invalid field', () => {
    expect(
      fieldsOf({
        lines: [
          { lineId: 'nope', quantity: 0 },
          { lineId: LINE_A, quantity: 2.5, extra: true },
          { lineId: LINE_A, quantity: 1 },
        ],
        reference: '',
        receivedAt: '2026-11-25T10:00:00Z',
        warehouseId: LINE_B,
      }),
    ).toEqual([
      'warehouseId',
      'lines[0].lineId',
      'lines[0].quantity',
      'lines[1].extra',
      'lines[1].quantity',
      'lines[2].lineId',
      'reference',
      'receivedAt',
    ]);
  });

  it('needs at least one line', () => {
    expect(fieldsOf({ lines: [] })).toEqual(['lines']);
    expect(fieldsOf({})).toEqual(['lines']);
    expect(fieldsOf([])).toEqual(['body']);
  });
});
