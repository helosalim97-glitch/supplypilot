'use client';

import { useActionState } from 'react';
import {
  ACTION_LABELS,
  REASON_REQUIRED,
  type PurchaseOrderAction,
} from '@/lib/purchase-orders';
import { changeStatus, type FormState } from './actions';

const INITIAL: FormState = { message: null, errors: {} };

function ActionForm({
  orgId,
  orderId,
  action,
}: {
  orgId: string;
  orderId: string;
  action: PurchaseOrderAction;
}) {
  const [state, formAction, pending] = useActionState(
    changeStatus.bind(null, orgId, orderId, action),
    INITIAL,
  );
  const needsReason = REASON_REQUIRED.has(action);
  const reasonId = `reason-${action}`;
  const errorId = `${reasonId}-error`;
  const danger = action === 'reject' || action === 'cancel';

  return (
    <form action={formAction} className="action-form" aria-label={ACTION_LABELS[action]}>
      {(needsReason || action === 'approve') && (
        <>
          <label htmlFor={reasonId}>
            {needsReason ? 'Reason (required)' : 'Comment (optional)'}
          </label>
          <textarea
            id={reasonId}
            name="reason"
            rows={2}
            maxLength={500}
            required={needsReason}
            aria-invalid={state.errors.reason ? true : undefined}
            aria-describedby={state.errors.reason ? errorId : undefined}
          />
          {state.errors.reason && (
            <p id={errorId} className="field-error">
              {state.errors.reason}
            </p>
          )}
        </>
      )}
      <button type="submit" disabled={pending} className={danger ? 'danger' : undefined}>
        {pending ? 'Working…' : ACTION_LABELS[action]}
      </button>
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function StatusActions({
  orgId,
  orderId,
  actions,
}: {
  orgId: string;
  orderId: string;
  actions: PurchaseOrderAction[];
}) {
  return (
    <div className="actions">
      {actions.map((action) => (
        <ActionForm key={action} orgId={orgId} orderId={orderId} action={action} />
      ))}
    </div>
  );
}
