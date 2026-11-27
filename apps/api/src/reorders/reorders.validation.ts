import { isUuid } from '../catalog/catalog.validation';
import { ValidationError, type FieldError } from '../http/api-error';
import { optionalText } from '../inventory/inventory.validation';
import { MAX_LINE_QUANTITY, MAX_REASON_LENGTH, isCalendarDate } from '../purchasing/purchasing.validation';
import {
  REORDER_DECISIONS,
  REORDER_PROPOSAL_STATUSES,
  type DecisionInput,
  type ReorderCandidate,
  type ReorderDecision,
  type ReorderProposalQuery,
  type ReorderProposalStatus,
  type ReorderRunSettings,
  type SkippedPair,
  type WorkerCandidates,
} from './reorders.models';

type Body = Record<string, unknown>;

function isObject(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(body: Body, allowed: string[], errors: FieldError[], what = 'field'): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push({ field: key, message: `is not an allowed ${what}` });
  }
}

/** Run settings with the same bounds the worker applies. */
const RUN_LIMITS: Record<keyof ReorderRunSettings, { min: number; max: number; whole: boolean }> = {
  demandWindowDays: { min: 14, max: 365, whole: true },
  leadTimeWindowDays: { min: 1, max: 1095, whole: true },
  serviceLevel: { min: 0.5, max: 0.999, whole: false },
  reviewPeriodDays: { min: 0, max: 90, whole: false },
};

/** Body of `POST .../reorders/runs`; every setting is optional. */
export function parseRunSettings(body: unknown): ReorderRunSettings {
  const input = body === undefined || body === null ? {} : body;
  if (!isObject(input)) {
    throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  const errors: FieldError[] = [];
  rejectUnknown(input, Object.keys(RUN_LIMITS), errors);
  const settings: ReorderRunSettings = {};
  for (const [field, limit] of Object.entries(RUN_LIMITS) as [keyof ReorderRunSettings, (typeof RUN_LIMITS)[keyof ReorderRunSettings]][]) {
    const value = input[field];
    if (value === undefined) continue;
    const ok =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (!limit.whole || Number.isInteger(value)) &&
      value >= limit.min &&
      value <= limit.max;
    if (ok) settings[field] = value;
    else {
      errors.push({
        field,
        message: `must be a ${limit.whole ? 'whole ' : ''}number from ${limit.min} to ${limit.max}`,
      });
    }
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return settings;
}

const DECISION_FIELDS = ['decision', 'reason', 'quantity', 'expectedOn'];

function isDecision(value: unknown): value is ReorderDecision {
  return typeof value === 'string' && (REORDER_DECISIONS as readonly string[]).includes(value);
}

/**
 * Body of `POST .../reorders/:id/decision`. Rejecting needs a `reason`;
 * `quantity` (to order a different amount) and `expectedOn` only go with
 * an approval.
 */
export function parseDecision(body: unknown): DecisionInput {
  if (!isObject(body)) {
    throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  const errors: FieldError[] = [];
  rejectUnknown(body, DECISION_FIELDS, errors);

  let decision: ReorderDecision = 'approve';
  if (isDecision(body.decision)) decision = body.decision;
  else errors.push({ field: 'decision', message: `must be one of ${REORDER_DECISIONS.join(', ')}` });

  const reason = optionalText(body, 'reason', MAX_REASON_LENGTH, errors);
  if (decision === 'reject' && reason === null && !errors.some((e) => e.field === 'reason')) {
    errors.push({ field: 'reason', message: 'is required to reject a proposal' });
  }

  let quantity: number | null = null;
  const q = body.quantity;
  if (q !== undefined && q !== null) {
    if (decision === 'reject') {
      errors.push({ field: 'quantity', message: 'only goes with an approval' });
    } else if (typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= MAX_LINE_QUANTITY) {
      quantity = q;
    } else {
      errors.push({ field: 'quantity', message: `must be a whole number from 1 to ${MAX_LINE_QUANTITY}` });
    }
  }

  let expectedOn: string | null = null;
  const e = body.expectedOn;
  if (e !== undefined && e !== null) {
    if (decision === 'reject') {
      errors.push({ field: 'expectedOn', message: 'only goes with an approval' });
    } else if (typeof e === 'string' && isCalendarDate(e)) {
      expectedOn = e;
    } else {
      errors.push({ field: 'expectedOn', message: 'must be null or a calendar date (YYYY-MM-DD)' });
    }
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return { decision, reason, quantity, expectedOn };
}

const QUERY_FIELDS = ['status', 'skuId', 'warehouseId', 'limit', 'offset'];
export const DEFAULT_PROPOSAL_LIMIT = 50;
export const MAX_PROPOSAL_LIMIT = 200;
const MAX_OFFSET = 100_000;

function isStatus(value: unknown): value is ReorderProposalStatus {
  return typeof value === 'string' && (REORDER_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

function queryInt(query: Body, field: string, min: number, max: number, fallback: number, errors: FieldError[]): number {
  const value = query[field];
  if (value === undefined) return fallback;
  const n = typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) {
    errors.push({ field, message: `must be a whole number from ${min} to ${max}` });
    return fallback;
  }
  return n;
}

/** Query string of `GET .../reorders`. */
export function parseProposalQuery(query: unknown): ReorderProposalQuery {
  const input = isObject(query) ? query : {};
  const errors: FieldError[] = [];
  rejectUnknown(input, QUERY_FIELDS, errors, 'query parameter');

  let status: ReorderProposalStatus | null = null;
  if (input.status !== undefined) {
    if (isStatus(input.status)) status = input.status;
    else errors.push({ field: 'status', message: `must be one of ${REORDER_PROPOSAL_STATUSES.join(', ')}` });
  }
  const filter = (field: string): string | null => {
    const value = input[field];
    if (value === undefined) return null;
    if (typeof value === 'string' && isUuid(value)) return value.toLowerCase();
    errors.push({ field, message: 'must be a UUID' });
    return null;
  };

  const result: ReorderProposalQuery = {
    status,
    skuId: filter('skuId'),
    warehouseId: filter('warehouseId'),
    limit: queryInt(input, 'limit', 1, MAX_PROPOSAL_LIMIT, DEFAULT_PROPOSAL_LIMIT, errors),
    offset: queryInt(input, 'offset', 0, MAX_OFFSET, 0, errors),
  };
  if (errors.length > 0) throw new ValidationError(errors);
  return result;
}

/** The worker answered with something the API can't store. */
export class InvalidWorkerResponseError extends Error {
  constructor(detail: string) {
    super(`Unexpected reorder-candidates response from the worker: ${detail}`);
    this.name = 'InvalidWorkerResponseError';
  }
}

const MAX_CANDIDATES = 10_000;
const MAX_INT = 2_147_483_647;
const DIGEST = /^[0-9a-f]{64}$/;
const WARNING = /^[a-z][a-z_]{0,39}$/;

function count(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_INT) {
    return value;
  }
  throw new InvalidWorkerResponseError(`${path} must be a whole number`);
}

function id(value: unknown, path: string): string {
  if (typeof value === 'string' && isUuid(value)) return value.toLowerCase();
  throw new InvalidWorkerResponseError(`${path} must be a UUID`);
}

function text(value: unknown, path: string, max = 120): string {
  if (typeof value === 'string' && value.length >= 1 && value.length <= max) return value;
  throw new InvalidWorkerResponseError(`${path} must be a short string`);
}

/**
 * Checks the worker's answer before anything is stored. The worker is
 * internal but its output still crosses a process boundary, so ids, counts
 * and the digest are checked here (and again by the table's constraints).
 * A suggestion above the per-line limit becomes a skipped pair rather than
 * a proposal nobody could approve.
 */
export function parseWorkerCandidates(body: unknown, organizationId: string): WorkerCandidates {
  if (!isObject(body)) throw new InvalidWorkerResponseError('body must be an object');
  if (body.organizationId !== organizationId) {
    throw new InvalidWorkerResponseError('organizationId does not match the request');
  }
  const calculatedAt = text(body.asOf, 'asOf', 40);
  if (Number.isNaN(Date.parse(calculatedAt))) throw new InvalidWorkerResponseError('asOf must be a timestamp');
  if (!isObject(body.parameters)) throw new InvalidWorkerResponseError('parameters must be an object');
  if (!Array.isArray(body.candidates) || body.candidates.length > MAX_CANDIDATES) {
    throw new InvalidWorkerResponseError('candidates must be an array');
  }
  if (!Array.isArray(body.skipped)) throw new InvalidWorkerResponseError('skipped must be an array');

  const skipped: SkippedPair[] = body.skipped.map((raw, i) => {
    const path = `skipped[${i}]`;
    if (!isObject(raw)) throw new InvalidWorkerResponseError(`${path} must be an object`);
    return {
      skuId: id(raw.skuId, `${path}.skuId`),
      skuCode: text(raw.skuCode, `${path}.skuCode`),
      warehouseId: id(raw.warehouseId, `${path}.warehouseId`),
      warehouseCode: text(raw.warehouseCode, `${path}.warehouseCode`),
      reason: text(raw.reason, `${path}.reason`, 40),
    };
  });

  const candidates: ReorderCandidate[] = [];
  const seen = new Set<string>();
  body.candidates.forEach((raw, i) => {
    const path = `candidates[${i}]`;
    if (!isObject(raw)) throw new InvalidWorkerResponseError(`${path} must be an object`);
    const calc = raw.calculation;
    if (!isObject(calc) || !isObject(calc.evidence)) {
      throw new InvalidWorkerResponseError(`${path}.calculation must be an object with evidence`);
    }
    if (!isObject(raw.leadTime)) throw new InvalidWorkerResponseError(`${path}.leadTime must be an object`);
    const digest = raw.digest;
    if (typeof digest !== 'string' || !DIGEST.test(digest)) {
      throw new InvalidWorkerResponseError(`${path}.digest must be a SHA-256 hex digest`);
    }
    const warnings = calc.warnings;
    if (!Array.isArray(warnings) || !warnings.every((w) => typeof w === 'string' && WARNING.test(w))) {
      throw new InvalidWorkerResponseError(`${path}.calculation.warnings must be a list of codes`);
    }
    const candidate: ReorderCandidate = {
      skuId: id(raw.skuId, `${path}.skuId`),
      warehouseId: id(raw.warehouseId, `${path}.warehouseId`),
      supplierId: id(raw.supplierId, `${path}.supplierId`),
      suggestedQty: count(calc.suggestedOrderQty, `${path}.calculation.suggestedOrderQty`),
      onHand: count(raw.onHand, `${path}.onHand`),
      onOrder: count(raw.onOrder, `${path}.onOrder`),
      reorderPoint: count(calc.reorderPoint, `${path}.calculation.reorderPoint`),
      safetyStock: count(calc.safetyStock, `${path}.calculation.safetyStock`),
      orderUpTo: count(calc.orderUpTo, `${path}.calculation.orderUpTo`),
      warnings: warnings as string[],
      digest,
      evidence: {
        ...calc.evidence,
        inventoryPosition: calc.inventoryPosition,
        daysOfCover: calc.daysOfCover,
        leadTime: raw.leadTime,
        parameters: body.parameters,
      },
    };
    const pair = `${candidate.skuId}/${candidate.warehouseId}`;
    if (seen.has(pair)) throw new InvalidWorkerResponseError(`${path} repeats ${pair}`);
    seen.add(pair);
    if (candidate.suggestedQty < 1) {
      throw new InvalidWorkerResponseError(`${path}.calculation.suggestedOrderQty must be positive`);
    }
    if (candidate.suggestedQty > MAX_LINE_QUANTITY) {
      skipped.push({
        skuId: candidate.skuId,
        skuCode: typeof raw.skuCode === 'string' ? raw.skuCode : candidate.skuId,
        warehouseId: candidate.warehouseId,
        warehouseCode: typeof raw.warehouseCode === 'string' ? raw.warehouseCode : candidate.warehouseId,
        reason: 'quantity_too_large',
      });
      return;
    }
    candidates.push(candidate);
  });

  return { calculatedAt, parameters: body.parameters, candidates, skipped };
}
