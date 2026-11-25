import type { Role } from '../src/auth/roles';
import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from '../src/purchasing/purchasing.models';
import {
  availableActions,
  InvalidTransitionError,
  planTransition,
  PURCHASE_ORDER_ACTIONS,
  SelfDecisionError,
  TransitionForbiddenError,
  type PurchaseOrderAction,
} from '../src/purchasing/purchasing.state-machine';

const BUYER = 'u-buyer';
const MANAGER = 'u-manager';

function plan(
  action: PurchaseOrderAction,
  from: PurchaseOrderStatus,
  role: Role = 'owner',
  actorId = MANAGER,
  submittedBy: string | null = BUYER,
) {
  return planTransition({ action, from, actorId, actorRole: role, submittedBy });
}

/** Every edge an owner may take; anything else must be refused. */
const ALLOWED: [PurchaseOrderAction, PurchaseOrderStatus, PurchaseOrderStatus][] = [
  ['submit', 'draft', 'submitted'],
  ['approve', 'submitted', 'approved'],
  ['reject', 'submitted', 'rejected'],
  ['cancel', 'draft', 'cancelled'],
  ['cancel', 'submitted', 'cancelled'],
  ['cancel', 'approved', 'cancelled'],
  ['reopen', 'rejected', 'draft'],
];

describe('purchase order state machine', () => {
  it.each(ALLOWED)('%s moves a %s order to %s', (action, from, to) => {
    expect(plan(action, from)).toBe(to);
  });

  it('refuses every other action/status pair with InvalidTransitionError', () => {
    for (const action of PURCHASE_ORDER_ACTIONS) {
      for (const from of PURCHASE_ORDER_STATUSES) {
        if (ALLOWED.some(([a, f]) => a === action && f === from)) continue;
        expect(() => plan(action, from)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('leaves terminal and receiving states alone', () => {
    for (const status of ['cancelled', 'partially_received', 'received'] as const) {
      expect(availableActions(status, 'owner')).toEqual([]);
    }
  });

  it('explains a refused transition', () => {
    expect(() => plan('approve', 'draft')).toThrow(
      'The purchase order is draft and cannot be approved',
    );
    expect(() => plan('submit', 'partially_received')).toThrow(
      'The purchase order is partially received and cannot be submitted',
    );
  });

  describe('roles', () => {
    it('lets a buyer submit, cancel an unapproved order and reopen', () => {
      expect(plan('submit', 'draft', 'buyer', BUYER, null)).toBe('submitted');
      expect(plan('cancel', 'submitted', 'buyer', BUYER)).toBe('cancelled');
      expect(plan('reopen', 'rejected', 'buyer', BUYER)).toBe('draft');
    });

    it('keeps approval, rejection and cancelling an approved order for managers', () => {
      for (const [action, from] of [
        ['approve', 'submitted'],
        ['reject', 'submitted'],
        ['cancel', 'approved'],
      ] as const) {
        expect(() => plan(action, from, 'buyer', 'u-other-buyer')).toThrow(
          TransitionForbiddenError,
        );
        expect(plan(action, from, 'manager')).toBeDefined();
      }
    });

    it('never lets a viewer change status', () => {
      for (const [action, from] of ALLOWED) {
        expect(() => plan(action, from, 'viewer')).toThrow(TransitionForbiddenError);
      }
    });

    it('lists what each role can do next', () => {
      expect(availableActions('draft', 'viewer')).toEqual([]);
      expect(availableActions('draft', 'buyer')).toEqual(['submit', 'cancel']);
      expect(availableActions('submitted', 'buyer')).toEqual(['cancel']);
      expect(availableActions('submitted', 'manager')).toEqual(['approve', 'reject', 'cancel']);
      expect(availableActions('approved', 'buyer')).toEqual([]);
      expect(availableActions('approved', 'manager')).toEqual(['cancel']);
      expect(availableActions('rejected', 'buyer')).toEqual(['reopen']);
    });
  });

  describe('four-eyes rule', () => {
    it('stops the submitter from approving or rejecting their own order', () => {
      expect(() => plan('approve', 'submitted', 'owner', BUYER, BUYER)).toThrow(SelfDecisionError);
      expect(() => plan('reject', 'submitted', 'manager', BUYER, BUYER)).toThrow(
        'An order cannot be rejected by the person who submitted it',
      );
    });

    it('still lets the submitter cancel their own order', () => {
      expect(plan('cancel', 'submitted', 'manager', BUYER, BUYER)).toBe('cancelled');
    });

    it('checks the status before the role and the role before the submitter', () => {
      expect(() => plan('approve', 'draft', 'viewer', BUYER, BUYER)).toThrow(InvalidTransitionError);
      expect(() => plan('approve', 'submitted', 'buyer', BUYER, BUYER)).toThrow(
        TransitionForbiddenError,
      );
    });
  });
});
