"""Read-only access to the API's PostgreSQL tables.

The API is the only writer of domain state (ADR 0001). The worker opens its
connections read-only and scopes every query by organization.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Protocol

from .lead_times import OrderDelivery
from .proposals import StockPosition


@dataclass(frozen=True)
class Supplier:
    id: str
    code: str
    name: str
    archived: bool


class LeadTimeSource(Protocol):
    def organization_exists(self, organization_id: str) -> bool: ...

    def suppliers(self, organization_id: str) -> list[Supplier]: ...

    def deliveries(self, organization_id: str, received_from: datetime, received_to: datetime,
                   supplier_id: str | None = None) -> list[OrderDelivery]: ...


class ReorderSource(LeadTimeSource, Protocol):
    def stock_positions(self, organization_id: str) -> list[StockPosition]: ...

    def daily_issues(self, organization_id: str, occurred_from: datetime, occurred_to: datetime
                     ) -> dict[tuple[str, str], dict[date, int]]: ...


# Approved orders that have at least one delivery. Only receipts up to the end
# of the window count, so a past `asOf` gives the same answer later on.
DELIVERIES_SQL = """
SELECT po.id::text, po.number, po.supplier_id::text, po.decided_at, po.expected_on,
       min(r.received_at) AS first_received_at
  FROM purchase_orders po
  JOIN purchase_order_receipts r
    ON r.organization_id = po.organization_id AND r.purchase_order_id = po.id
 WHERE po.organization_id = %(org)s
   AND po.status IN ('partially_received', 'received')
   AND po.decided_at IS NOT NULL
   AND r.received_at <= %(to)s
   AND (%(supplier)s::uuid IS NULL OR po.supplier_id = %(supplier)s::uuid)
 GROUP BY po.id
HAVING min(r.received_at) >= %(from)s
 ORDER BY first_received_at, po.number
"""


# Current stock of active SKUs at active warehouses, with the preferred
# supplier and the units still outstanding on open orders for that warehouse.
# Drafts count as on order too, so approving a proposal (which raises a draft)
# stops the same pair from being proposed again.
STOCK_POSITIONS_SQL = """
SELECT b.sku_id::text, k.code::text, b.warehouse_id::text, w.code::text,
       k.preferred_supplier_id::text, s.archived_at IS NOT NULL, b.on_hand,
       coalesce(o.on_order, 0)::int
  FROM stock_balances b
  JOIN skus k ON k.organization_id = b.organization_id AND k.id = b.sku_id
             AND k.archived_at IS NULL
  JOIN warehouses w ON w.organization_id = b.organization_id AND w.id = b.warehouse_id
                   AND w.archived_at IS NULL
  LEFT JOIN suppliers s ON s.organization_id = k.organization_id AND s.id = k.preferred_supplier_id
  LEFT JOIN LATERAL (
    SELECT sum(l.quantity_ordered - l.quantity_received) AS on_order
      FROM purchase_order_lines l
      JOIN purchase_orders po
        ON po.organization_id = l.organization_id AND po.id = l.purchase_order_id
     WHERE l.organization_id = b.organization_id AND l.sku_id = b.sku_id
       AND po.warehouse_id = b.warehouse_id
       AND po.status IN ('draft', 'submitted', 'approved', 'partially_received')
  ) o ON true
 WHERE b.organization_id = %s
 ORDER BY k.code, w.code
"""

# Units issued per SKU, warehouse and UTC day. Issues are stored as negative deltas.
DAILY_ISSUES_SQL = """
SELECT sku_id::text, warehouse_id::text, (occurred_at AT TIME ZONE 'UTC')::date,
       sum(-quantity_delta)::bigint
  FROM inventory_events
 WHERE organization_id = %(org)s AND event_type = 'issue'
   AND occurred_at >= %(from)s AND occurred_at <= %(to)s
 GROUP BY 1, 2, 3
"""


def read_only_connection(database_url: str, connect_timeout: int = 5
                         ) -> Callable[[], AbstractContextManager[Any]]:
    """A factory for short-lived read-only connections (one per call)."""

    @contextmanager
    def connect() -> Iterator[Any]:
        import psycopg

        with psycopg.connect(database_url, connect_timeout=connect_timeout) as conn:
            conn.read_only = True
            yield conn

    return connect


class PostgresLeadTimeSource:
    def __init__(self, connect: Callable[[], AbstractContextManager[Any]]) -> None:
        self._connect = connect

    def organization_exists(self, organization_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute("SELECT 1 FROM organizations WHERE id = %s", (organization_id,)).fetchone()
            return row is not None

    def suppliers(self, organization_id: str) -> list[Supplier]:
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT id::text, code::text, name, archived_at IS NOT NULL
                     FROM suppliers WHERE organization_id = %s ORDER BY code""",
                (organization_id,),
            ).fetchall()
        return [Supplier(id=r[0], code=r[1], name=r[2], archived=r[3]) for r in rows]

    def deliveries(self, organization_id: str, received_from: datetime, received_to: datetime,
                   supplier_id: str | None = None) -> list[OrderDelivery]:
        with self._connect() as conn:
            rows = conn.execute(DELIVERIES_SQL, {
                "org": organization_id, "from": received_from, "to": received_to,
                "supplier": supplier_id,
            }).fetchall()
        return [
            OrderDelivery(order_id=r[0], order_number=r[1], supplier_id=r[2], approved_at=r[3],
                          expected_on=r[4], first_received_at=r[5])
            for r in rows
        ]

    def stock_positions(self, organization_id: str) -> list[StockPosition]:
        with self._connect() as conn:
            rows = conn.execute(STOCK_POSITIONS_SQL, (organization_id,)).fetchall()
        return [
            StockPosition(sku_id=r[0], sku_code=r[1], warehouse_id=r[2], warehouse_code=r[3],
                          supplier_id=r[4], supplier_archived=bool(r[4]) and r[5],
                          on_hand=r[6], on_order=r[7])
            for r in rows
        ]

    def daily_issues(self, organization_id: str, occurred_from: datetime, occurred_to: datetime
                     ) -> dict[tuple[str, str], dict[date, int]]:
        with self._connect() as conn:
            rows = conn.execute(DAILY_ISSUES_SQL, {
                "org": organization_id, "from": occurred_from, "to": occurred_to,
            }).fetchall()
        issues: dict[tuple[str, str], dict[date, int]] = {}
        for sku_id, warehouse_id, day, units in rows:
            issues.setdefault((sku_id, warehouse_id), {})[day] = int(units)
        return issues
