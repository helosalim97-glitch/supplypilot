/** Organization roles, lowest to highest. */
export const ROLES = ['viewer', 'buyer', 'manager', 'owner'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** True when `actual` is the same as or higher than `required`. */
export function satisfiesRole(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}
