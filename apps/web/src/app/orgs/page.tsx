import type { Metadata } from 'next';
import Link from 'next/link';
import { listMemberships } from '@/lib/organizations';

export const metadata: Metadata = { title: 'Organizations' };

export default async function OrganizationsPage() {
  const memberships = await listMemberships();
  return (
    <section>
      <h1>Your organizations</h1>
      {memberships.length === 0 ? (
        <p className="muted">Your account isn&apos;t a member of any organization yet.</p>
      ) : (
        <ul className="card-list">
          {memberships.map((m) => (
            <li key={m.organizationId}>
              <Link href={`/orgs/${m.organizationId}/purchase-orders`}>{m.name}</Link>
              <span className="badge">{m.role}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
