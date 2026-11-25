'use client';

import { useActionState } from 'react';
import { quantityField, type PurchaseOrderLine } from '@/lib/purchase-orders';
import { receiveGoods, type FormState } from './actions';

const INITIAL: FormState = { message: null, errors: {} };

export function ReceiveForm({
  orgId,
  orderId,
  idempotencyKey,
  lines,
}: {
  orgId: string;
  orderId: string;
  idempotencyKey: string;
  lines: PurchaseOrderLine[];
}) {
  const [state, action, pending] = useActionState(
    receiveGoods.bind(null, orgId, orderId, idempotencyKey),
    INITIAL,
  );
  const open = lines.filter((line) => line.quantityOutstanding > 0);
  const formError = state.errors.form ?? state.message;

  return (
    <form action={action} className="stack" aria-labelledby="receive-heading">
      <h2 id="receive-heading">Record a delivery</h2>
      <p className="muted">
        Enter what arrived. Leave a line blank if nothing came for it — the rest stays outstanding.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">SKU</th>
            <th scope="col" className="num">Outstanding</th>
            <th scope="col" className="num">Received now</th>
          </tr>
        </thead>
        <tbody>
          {open.map((line) => {
            const field = quantityField(line.id);
            const error = state.errors[field];
            const inputId = `receive-${line.id}`;
            return (
              <tr key={line.id}>
                <th scope="row">
                  <label htmlFor={inputId}>
                    {line.skuCode} — {line.skuName}
                  </label>
                </th>
                <td className="num">
                  {line.quantityOutstanding} {line.unit}
                </td>
                <td className="num">
                  <input
                    id={inputId}
                    name={field}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={line.quantityOutstanding}
                    step={1}
                    className="qty"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${inputId}-error` : undefined}
                  />
                  {error && (
                    <p id={`${inputId}-error`} className="field-error">
                      {error}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label htmlFor="receipt-reference">Delivery note / packing slip (optional)</label>
      <input id="receipt-reference" name="reference" maxLength={120} />
      {state.errors.reference && <p className="field-error">{state.errors.reference}</p>}
      <label htmlFor="receipt-notes">Notes (optional)</label>
      <textarea id="receipt-notes" name="notes" rows={2} maxLength={1000} />
      {state.errors.notes && <p className="field-error">{state.errors.notes}</p>}
      {formError && (
        <p className="form-error" role="alert">
          {formError}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? 'Recording…' : 'Record delivery'}
      </button>
    </form>
  );
}
