import { ValidationError, type FieldError } from '../http/api-error';
import type { NewSku, NewSupplier, NewWarehouse } from './catalog.models';

/*
 * Request body validation for catalog writes. The rules mirror the CHECK
 * constraints in migration 0003, so invalid input gets a 422 listing every bad
 * field instead of a database error. Unknown fields are rejected so typos
 * (e.g. `unitCost`) don't silently fall back to defaults.
 */

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const UNIT_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Largest value a PostgreSQL `integer` column accepts. */
const MAX_INT = 2_147_483_647;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

type Body = Record<string, unknown>;

class FieldReader {
  readonly errors: FieldError[] = [];

  constructor(
    private readonly body: Body,
    allowed: readonly string[],
  ) {
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) this.fail(key, 'is not an allowed field');
    }
  }

  fail(field: string, message: string): void {
    this.errors.push({ field, message });
  }

  code(field: string): string {
    const value = this.body[field];
    if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
      this.fail(
        field,
        'must be 1-40 letters, digits, ".", "_" or "-", starting with a letter or digit',
      );
      return '';
    }
    return value;
  }

  name(field: string, maxLength: number): string {
    const value = this.body[field];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length < 1 || trimmed.length > maxLength) {
      this.fail(field, `must be a non-blank string of at most ${maxLength} characters`);
      return '';
    }
    return trimmed;
  }

  unit(field: string): string {
    const value = this.body[field];
    if (typeof value !== 'string' || !UNIT_PATTERN.test(value)) {
      this.fail(field, 'must be 1-16 lowercase letters, digits or "_", starting with a letter');
      return '';
    }
    return value;
  }

  nonNegativeInt(field: string, fallback?: number): number {
    const value = this.body[field];
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_INT) {
      this.fail(field, `must be a whole number from 0 to ${MAX_INT}`);
      return 0;
    }
    return value;
  }

  optionalEmail(field: string): string | null {
    const value = this.body[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > 254 || !EMAIL_PATTERN.test(value)) {
      this.fail(field, 'must be an email address or null');
      return null;
    }
    return value;
  }

  optionalUuid(field: string): string | null {
    const value = this.body[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !isUuid(value)) {
      this.fail(field, 'must be a UUID or null');
      return null;
    }
    return value;
  }

  done<T>(result: T): T {
    if (this.errors.length > 0) throw new ValidationError(this.errors);
    return result;
  }
}

function reader(body: unknown, allowed: readonly string[]): FieldReader {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  return new FieldReader(body as Body, allowed);
}

export function parseNewSupplier(body: unknown): NewSupplier {
  const r = reader(body, ['code', 'name', 'contactEmail']);
  return r.done({
    code: r.code('code'),
    name: r.name('name', 120),
    contactEmail: r.optionalEmail('contactEmail'),
  });
}

export function parseNewWarehouse(body: unknown): NewWarehouse {
  const r = reader(body, ['code', 'name']);
  return r.done({ code: r.code('code'), name: r.name('name', 120) });
}

export function parseNewSku(body: unknown): NewSku {
  const r = reader(body, [
    'code',
    'name',
    'unit',
    'unitCostCents',
    'reorderPoint',
    'preferredSupplierId',
  ]);
  return r.done({
    code: r.code('code'),
    name: r.name('name', 200),
    unit: r.unit('unit'),
    unitCostCents: r.nonNegativeInt('unitCostCents'),
    reorderPoint: r.nonNegativeInt('reorderPoint', 0),
    preferredSupplierId: r.optionalUuid('preferredSupplierId'),
  });
}
