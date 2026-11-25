import { STATUS_LABELS, type PurchaseOrderStatus } from '@/lib/purchase-orders';

export function StatusBadge({ status }: { status: PurchaseOrderStatus }) {
  return <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>;
}
