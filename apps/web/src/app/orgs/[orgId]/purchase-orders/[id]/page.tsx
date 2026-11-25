import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { apiFetchOrNull } from '@/lib/api';
import { isUuid, requireMembership } from '@/lib/organizations';
import {
  ACTION_NOTICES,
  availableActions,
  canReceive,
  describeAuditAction,
  formatCents,
  formatDateTime,
  STATUS_LABELS,
  isStatus,
  type AuditEvent,
  type PurchaseOrder,
  type Receipt,
} from '@/lib/purchase-orders';
import { StatusBadge } from '../status-badge';
import { ReceiveForm } from './receive-form';
import { StatusActions } from './status-actions';

export const metadata: Metadata = { title: 'Purchase order' };

export default async function PurchaseOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, id } = await params;
  const membership = await requireMembership(orgId);
  if (!isUuid(id)) notFound();

  const path = `/v1/organizations/${orgId}/purchase-orders/${id}`;
  const [order, events, receipts] = await Promise.all([
    apiFetchOrNull<{ data: PurchaseOrder }>(path),
    apiFetchOrNull<{ data: AuditEvent[] }>(`${path}/events`),
    apiFetchOrNull<{ data: Receipt[] }>(`${path}/receipts`),
  ]);
  if (!order || !events || !receipts) notFound();
  const po = order.data;

  const { notice } = await searchParams;
  const noticeText =
    typeof notice === 'string' && notice in ACTION_NOTICES
      ? ACTION_NOTICES[notice as keyof typeof ACTION_NOTICES]
      : null;
  const actions = availableActions(po.status, membership.role);
  const receivable = canReceive(po, membership.role);

  return (
    <article>
      <p className="breadcrumbs">
        <Link href="/orgs">Organizations</Link> /{' '}
        <Link href={`/orgs/${orgId}/purchase-orders`}>{membership.name}: purchase orders</Link> /{' '}
        {po.number}
      </p>
      <header className="page-header">
        <h1>
          {po.number} <StatusBadge status={po.status} />
        </h1>
      </header>
      {noticeText && (
        <p className="notice success" role="status">
          {noticeText}
        </p>
      )}

      <dl className="facts">
        <div>
          <dt>Supplier</dt>
          <dd>
            {po.supplierName} ({po.supplierCode})
          </dd>
        </div>
        <div>
          <dt>Deliver to</dt>
          <dd>
            {po.warehouseName} ({po.warehouseCode})
          </dd>
        </div>
        <div>
          <dt>Expected</dt>
          <dd>{po.expectedOn ?? 'Not set'}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{formatCents(po.totalCents)}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>
            {po.totalUnitsReceived} of {po.totalUnits} units
          </dd>
        </div>
        {po.decisionReason && (
          <div>
            <dt>Decision note</dt>
            <dd>{po.decisionReason}</dd>
          </div>
        )}
      </dl>
      {po.notes && <p className="notes">{po.notes}</p>}

      <h2>Lines</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">SKU</th>
            <th scope="col" className="num">Ordered</th>
            <th scope="col" className="num">Received</th>
            <th scope="col" className="num">Unit cost</th>
            <th scope="col" className="num">Line total</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.lineNumber}</td>
              <th scope="row">
                {line.skuCode} — {line.skuName}
              </th>
              <td className="num">
                {line.quantityOrdered} {line.unit}
              </td>
              <td className="num">{line.quantityReceived}</td>
              <td className="num">{formatCents(line.unitCostCents)}</td>
              <td className="num">{formatCents(line.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {actions.length > 0 && (
        <section aria-labelledby="actions-heading">
          <h2 id="actions-heading">Actions</h2>
          {po.status === 'submitted' && actions.includes('approve') && (
            <p className="muted">
              Orders are approved or rejected by a manager other than the person who submitted
              them.
            </p>
          )}
          <StatusActions orgId={orgId} orderId={po.id} actions={actions} />
        </section>
      )}

      {receivable && (
        <section className="panel">
          <ReceiveForm
            key={po.updatedAt}
            orgId={orgId}
            orderId={po.id}
            idempotencyKey={`web-receipt-${randomUUID()}`}
            lines={po.lines}
          />
        </section>
      )}

      <h2>Deliveries</h2>
      {receipts.data.length === 0 ? (
        <p className="empty">Nothing received yet.</p>
      ) : (
        <ol className="timeline">
          {receipts.data.map((receipt) => (
            <li key={receipt.id}>
              <strong>{formatDateTime(receipt.receivedAt)}</strong>
              {receipt.reference && <> · {receipt.reference}</>}
              <ul>
                {receipt.lines.map((line) => (
                  <li key={line.purchaseOrderLineId}>
                    Line {line.lineNumber} ({line.skuCode}): {line.quantity}
                  </li>
                ))}
              </ul>
              {receipt.notes && <p className="muted">{receipt.notes}</p>}
            </li>
          ))}
        </ol>
      )}

      <h2>Audit trail</h2>
      <ol className="timeline">
        {events.data.map((event) => (
          <li key={event.id}>
            <strong>{describeAuditAction(event.action)}</strong>{' '}
            <span className="muted">{formatDateTime(event.occurredAt)}</span>
            {event.fromStatus && event.toStatus && isStatus(event.fromStatus) && isStatus(event.toStatus) && (
              <> · {STATUS_LABELS[event.fromStatus]} → {STATUS_LABELS[event.toStatus]}</>
            )}
            {event.reason && <p>“{event.reason}”</p>}
            <p className="muted small">By user {event.actorId.slice(0, 8)}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}
