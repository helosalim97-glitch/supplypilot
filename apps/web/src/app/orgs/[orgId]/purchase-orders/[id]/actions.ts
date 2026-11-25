'use server';

import { redirect } from 'next/navigation';
import { ApiRequestError, apiFetch, apiFetchOrNull } from '@/lib/api';
import { isUuid } from '@/lib/organizations';
import {
  buildReceiptPayload,
  isAction,
  mapReceiptErrors,
  parseReason,
  type FieldErrors,
  type PurchaseOrder,
  type PurchaseOrderAction,
} from '@/lib/purchase-orders';

export interface FormState {
  message: string | null;
  errors: FieldErrors;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/;

function orderPath(orgId: string, orderId: string): string {
  if (!isUuid(orgId) || !isUuid(orderId)) throw new Error('Invalid purchase order reference');
  return `/v1/organizations/${orgId}/purchase-orders/${orderId}`;
}

function detailHref(orgId: string, orderId: string, notice: string): string {
  return `/orgs/${orgId}/purchase-orders/${orderId}?notice=${notice}`;
}

/** Explains an API refusal in the form; anything unexpected is rethrown. */
function failure(error: unknown, errors: FieldErrors = {}): FormState {
  if (!(error instanceof ApiRequestError)) throw error;
  if (error.status === 404) {
    return { message: 'This purchase order no longer exists or you lost access to it.', errors };
  }
  return { message: error.message, errors };
}

/** submit / approve / reject / cancel / reopen. */
export async function changeStatus(
  orgId: string,
  orderId: string,
  action: PurchaseOrderAction,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  if (!isAction(action)) return { message: 'Unknown action', errors: {} };
  const parsed = parseReason(action, form.get('reason'));
  if ('error' in parsed) return { message: null, errors: { reason: parsed.error } };

  try {
    await apiFetch(`${orderPath(orgId, orderId)}/${action}`, {
      method: 'POST',
      body: parsed.reason === null ? {} : { reason: parsed.reason },
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      const reason = error.details.find((d) => d.field === 'reason');
      return failure(error, reason ? { reason: reason.message } : {});
    }
    throw error;
  }
  redirect(detailHref(orgId, orderId, action));
}

/**
 * Books a delivery. The idempotency key is minted when the page renders, so
 * a double submit or a retried request books the delivery only once.
 */
export async function receiveGoods(
  orgId: string,
  orderId: string,
  idempotencyKey: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return { message: 'Reload the page and try again.', errors: {} };

  const order = await apiFetchOrNull<{ data: PurchaseOrder }>(orderPath(orgId, orderId));
  if (!order) {
    return { message: 'This purchase order no longer exists or you lost access to it.', errors: {} };
  }
  const built = buildReceiptPayload(form, order.data.lines);
  if ('errors' in built) return { message: null, errors: built.errors };

  try {
    await apiFetch(`${orderPath(orgId, orderId)}/receipts`, {
      method: 'POST',
      body: built.payload,
      headers: { 'idempotency-key': idempotencyKey },
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return failure(error, mapReceiptErrors(error.details, built.payload.lines));
    }
    throw error;
  }
  redirect(detailHref(orgId, orderId, 'received'));
}
