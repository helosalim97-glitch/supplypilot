"""Read-only access to the API's PostgreSQL tables.

The API is the only writer of domain state (ADR 0001). The worker opens its
connections read-only and scopes every query by organization.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from .lead_times import OrderDelivery


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
