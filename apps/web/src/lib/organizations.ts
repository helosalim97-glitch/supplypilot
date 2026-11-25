import 'server-only';
import { notFound } from 'next/navigation';
import { ApiRequestError, apiFetch } from './api';
import { isRole, type Membership, type Role } from './purchase-orders';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function listMemberships(token?: string): Promise<Membership[]> {
  const { data } = await apiFetch<{ data: Membership[] }>('/v1/me/organizations', { token });
  return data;
}

/**
 * The caller's organization and role. The API answers 403 for unknown
 * organizations and ones the caller isn't in; both become a 404 page.
 */
export async function requireMembership(orgId: string): Promise<Membership> {
  if (!isUuid(orgId)) notFound();
  try {
    const { role } = await apiFetch<{ organizationId: string; role: Role }>(
      `/v1/organizations/${orgId}/membership`,
    );
    const membership = (await listMemberships()).find((m) => m.organizationId === orgId);
    if (!membership || !isRole(role)) notFound();
    return { ...membership, role };
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
      notFound();
    }
    throw error;
  }
}
