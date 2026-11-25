import type { Metadata } from 'next';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { requireMembership } from '@/lib/organizations';
import {
  PAGE_SIZE,
  PURCHASE_ORDER_STATUSES,
  STATUS_LABELS,
  formatCents,
  listApiQuery,
  listHref,
  parseListParams,
  type PurchaseOrderSummary,
} from '@/lib/purchase-orders';
import { StatusBadge } from './status-badge';

export const metadata: Metadata = { title: 'Purchase orders' };

export default async function PurchaseOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const membership = await requireMembership(orgId);
  const filters = parseListParams(await searchParams);
  const base = `/orgs/${orgId}/purchase-orders`;

  const { data: orders, page } = await apiFetch<{
    data: PurchaseOrderSummary[];
    page: { hasMore: boolean };
  }>(`/v1/organizations/${orgId}/purchase-orders?${listApiQuery(filters)}`);

  return (
    <section>
      <p className="breadcrumbs">
        <Link href="/orgs">Organizations</Link> / {membership.name}
      </p>
      <h1>Purchase orders</h1>
      <p className="muted">
        Signed in as <strong>{membership.role}</strong>.
      </p>

      <nav aria-label="Filter by status" className="filters">
        <Link
          href={listHref(base, { status: null, offset: 0 })}
          aria-current={filters.status === null ? 'page' : undefined}
        >
          All
        </Link>
        {PURCHASE_ORDER_STATUSES.map((status) => (
          <Link
            key={status}
            href={listHref(base, { status, offset: 0 })}
            aria-current={filters.status === status ? 'page' : undefined}
          >
            {STATUS_LABELS[status]}
          </Link>
        ))}
      </nav>

      {orders.length === 0 ? (
        <p className="empty">
          {filters.status
            ? `No purchase orders are ${STATUS_LABELS[filters.status].toLowerCase()}.`
            : 'No purchase orders yet.'}
        </p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">Purchase orders, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Status</th>
              <th scope="col">Supplier</th>
              <th scope="col">Warehouse</th>
              <th scope="col">Expected</th>
              <th scope="col" className="num">Received / ordered</th>
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <th scope="row">
                  <Link href={`${base}/${order.id}`}>{order.number}</Link>
                </th>
                <td>
                  <StatusBadge status={order.status} />
                </td>
                <td>{order.supplierName}</td>
                <td>{order.warehouseName}</td>
                <td>{order.expectedOn ?? '—'}</td>
                <td className="num">
                  {order.totalUnitsReceived} / {order.totalUnits}
                </td>
                <td className="num">{formatCents(order.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <nav aria-label="Pages" className="pager">
        {filters.offset > 0 && (
          <Link href={listHref(base, { ...filters, offset: Math.max(0, filters.offset - PAGE_SIZE) })}>
            ← Newer
          </Link>
        )}
        {page.hasMore && (
          <Link href={listHref(base, { ...filters, offset: filters.offset + PAGE_SIZE })}>
            Older →
          </Link>
        )}
      </nav>
    </section>
  );
}
