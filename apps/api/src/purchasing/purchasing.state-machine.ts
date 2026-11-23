import { satisfiesRole, type Role } from '../auth/roles';
import type { PurchaseOrderStatus } from './purchasing.models';

/*
 * Who may move a purchase order between statuses. Kept free of I/O so the
 * repository, the HTTP layer and the tests share one definition. Migration
 * 0009 enforces the same edges with a trigger as a second line of defence.
 */

export const PURCHASE_ORDER_ACTIONS = ['submit', 'approve', 'reject', 'cancel', 'reopen'] as const;

export type PurchaseOrderAction = (typeof PURCHASE_ORDER_ACTIONS)[number];

interface Edge {
  from: PurchaseOrderStatus;
  to: PurchaseOrderStatus;
  /** Lowest role allowed to take this edge. */
  role: Role;
}

const EDGES: Record<PurchaseOrderAction, Edge[]> = {
  submit: [{ from: 'draft', to: 'submitted', role: 'buyer' }],
  approve: [{ from: 'submitted', to: 'approved', role: 'manager' }],
  reject: [{ from: 'submitted', to: 'rejected', role: 'manager' }],
  cancel: [
    { from: 'draft', to: 'cancelled', role: 'buyer' },
    { from: 'submitted', to: 'cancelled', role: 'buyer' },
    // Once approved the supplier may already be working on it.
    { from: 'approved', to: 'cancelled', role: 'manager' },
  ],
  reopen: [{ from: 'rejected', to: 'draft', role: 'buyer' }],
};

/** Actions that must say why. */
export const REASON_REQUIRED: ReadonlySet<PurchaseOrderAction> = new Set(['reject', 'cancel']);

/** Audit action names, e.g. `purchase_order.approved`. */
export const AUDIT_ACTION: Record<PurchaseOrderAction, string> = {
  submit: 'purchase_order.submitted',
  approve: 'purchase_order.approved',
  reject: 'purchase_order.rejected',
  cancel: 'purchase_order.cancelled',
  reopen: 'purchase_order.reopened',
};

const PAST_TENSE: Record<PurchaseOrderAction, string> = {
  submit: 'submitted',
  approve: 'approved',
  reject: 'rejected',
  cancel: 'cancelled',
  reopen: 'reopened',
};

/** The action isn't possible from the order's current status. */
export class InvalidTransitionError extends Error {
  constructor(
    readonly action: PurchaseOrderAction,
    readonly status: PurchaseOrderStatus,
  ) {
    super(`The purchase order is ${status.replace('_', ' ')} and cannot be ${PAST_TENSE[action]}`);
    this.name = 'InvalidTransitionError';
  }
}

/** The caller's role is too low for this step (e.g. a buyer cancelling an approved order). */
export class TransitionForbiddenError extends Error {
  constructor(
    readonly action: PurchaseOrderAction,
    readonly requiredRole: Role,
  ) {
    super(`Only a ${requiredRole} or above can ${action} this purchase order`);
    this.name = 'TransitionForbiddenError';
  }
}

/** The approver or rejecter is the person who submitted the order. */
export class SelfDecisionError extends Error {
  constructor(readonly action: PurchaseOrderAction) {
    super(`An order cannot be ${PAST_TENSE[action]} by the person who submitted it`);
    this.name = 'SelfDecisionError';
  }
}

export function isDecision(action: PurchaseOrderAction): boolean {
  return action === 'approve' || action === 'reject';
}

export interface TransitionRequest {
  action: PurchaseOrderAction;
  from: PurchaseOrderStatus;
  actorId: string;
  actorRole: Role;
  /** Who submitted the order, if it was submitted. */
  submittedBy: string | null;
}

/**
 * The status the order moves to, or an error explaining why it can't.
 * Checks, in order: the edge exists, the role is high enough, and nobody
 * decides on an order they submitted themselves.
 */
export function planTransition(request: TransitionRequest): PurchaseOrderStatus {
  const edge = EDGES[request.action].find((e) => e.from === request.from);
  if (!edge) throw new InvalidTransitionError(request.action, request.from);
  if (!satisfiesRole(request.actorRole, edge.role)) {
    throw new TransitionForbiddenError(request.action, edge.role);
  }
  if (isDecision(request.action) && request.submittedBy === request.actorId) {
    throw new SelfDecisionError(request.action);
  }
  return edge.to;
}

/** Actions the given role could take on an order in this status (for UIs). */
export function availableActions(
  status: PurchaseOrderStatus,
  role: Role,
): PurchaseOrderAction[] {
  return PURCHASE_ORDER_ACTIONS.filter((action) =>
    EDGES[action].some((e) => e.from === status && satisfiesRole(role, e.role)),
  );
}
