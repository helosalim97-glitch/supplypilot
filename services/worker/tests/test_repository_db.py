"""Runs the lead-time queries against a real, migrated PostgreSQL database.

Skipped unless TEST_DATABASE_URL is set. Apply the API migrations first
(`pnpm db:migrate`). All rows are written inside one transaction that is
rolled back at the end, so the database is left as it was:

    TEST_DATABASE_URL=postgres://supplypilot:supplypilot_local@localhost:5432/supplypilot \\
      python -m pytest tests/test_repository_db.py
"""

import hashlib
import os
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

import pytest

from supplypilot_worker.repository import PostgresLeadTimeSource

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")

T0 = datetime(2026, 5, 4, 9, 0, tzinfo=timezone.utc)
WINDOW = (datetime(2026, 1, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc))


@pytest.fixture
def conn():
    psycopg = pytest.importorskip("psycopg")
    with psycopg.connect(DATABASE_URL) as connection:
        try:
            yield connection
        finally:
            connection.rollback()


@pytest.fixture
def source(conn):
    @contextmanager
    def shared():
        # Same connection and transaction, so the uncommitted rows are visible.
        yield conn

    return PostgresLeadTimeSource(shared)


class Org:
    def __init__(self, conn):
        self.conn = conn
        tag = uuid.uuid4().hex[:10]
        self.id = self.one("INSERT INTO organizations (slug, name) VALUES (%s, %s) RETURNING id::text",
                           f"lt-{tag}", f"Synthetic {tag}")
        self.buyer = self.user(f"buyer-{tag}")
        self.approver = self.user(f"approver-{tag}")
        self.warehouse = self.one("""INSERT INTO warehouses (organization_id, code, name)
                                     VALUES (%s, 'WH1', 'Synthetic warehouse') RETURNING id::text""",
                                  self.id)
        self.sku = self.one("""INSERT INTO skus (organization_id, code, name, unit, unit_cost_cents)
                               VALUES (%s, 'SKU-1', 'Synthetic part', 'each', 250) RETURNING id::text""",
                            self.id)
        self.numbers = 0

    def one(self, sql, *params):
        return self.conn.execute(sql, params).fetchone()[0]

    def user(self, name):
        return self.one("INSERT INTO users (email, display_name) VALUES (%s, %s) RETURNING id::text",
                        f"{name}@example.test", name)

    def supplier(self, code, archived=False):
        return self.one("""INSERT INTO suppliers (organization_id, code, name, archived_at)
                           VALUES (%s, %s, %s, %s) RETURNING id::text""",
                        self.id, code, f"Synthetic {code}", T0 if archived else None)

    def order(self, supplier, approved_at=None, expected_on=None):
        self.numbers += 1
        po = self.one("""INSERT INTO purchase_orders
                           (organization_id, number, supplier_id, warehouse_id, expected_on, created_by)
                         VALUES (%s, %s, %s, %s, %s, %s) RETURNING id::text""",
                      self.id, f"PO-{self.numbers:06d}", supplier, self.warehouse, expected_on, self.buyer)
        self.conn.execute("""INSERT INTO purchase_order_lines
                               (organization_id, purchase_order_id, line_number, sku_id,
                                quantity_ordered, unit_cost_cents)
                             VALUES (%s, %s, 1, %s, 10, 250)""", (self.id, po, self.sku))
        self.conn.execute("""UPDATE purchase_orders SET status = 'submitted', submitted_by = %s,
                               submitted_at = %s WHERE id = %s""",
                          (self.buyer, (approved_at or T0) - timedelta(hours=1), po))
        if approved_at is not None:
            self.conn.execute("""UPDATE purchase_orders SET status = 'approved', decided_by = %s,
                                   decided_at = %s WHERE id = %s""", (self.approver, approved_at, po))
        return po

    def receive(self, po, at, final=False):
        key = f"recv-{uuid.uuid4().hex}"
        self.conn.execute("""INSERT INTO purchase_order_receipts
                               (organization_id, purchase_order_id, idempotency_key, request_hash,
                                received_by, received_at)
                             VALUES (%s, %s, %s, %s, %s, %s)""",
                          (self.id, po, key, hashlib.sha256(key.encode()).hexdigest(), self.buyer, at))
        status = "received" if final else "partially_received"
        current = self.one("SELECT status FROM purchase_orders WHERE id = %s", po)
        if current != status:
            self.conn.execute("UPDATE purchase_orders SET status = %s WHERE id = %s", (status, po))


def test_reads_first_delivery_per_approved_order(conn, source):
    org = Org(conn)
    sup = org.supplier("SUP-A")
    other = org.supplier("SUP-B")
    org.supplier("SUP-OLD", archived=True)

    split = org.order(sup, T0, expected_on=date(2026, 5, 10))
    org.receive(split, T0 + timedelta(days=5))
    org.receive(split, T0 + timedelta(days=12), final=True)  # later parts don't add samples
    whole = org.order(other, T0 + timedelta(days=1))
    org.receive(whole, T0 + timedelta(days=8, hours=12), final=True)
    org.order(sup, T0)  # approved, nothing delivered yet
    org.order(sup)  # still waiting for approval

    deliveries = source.deliveries(org.id, *WINDOW)
    assert [(d.order_number, d.supplier_id) for d in deliveries] == [("PO-000001", sup),
                                                                      ("PO-000002", other)]
    first = deliveries[0]
    assert first.approved_at == T0
    assert first.first_received_at == T0 + timedelta(days=5)
    assert first.expected_on == date(2026, 5, 10)

    assert [d.order_number for d in source.deliveries(org.id, *WINDOW, supplier_id=other)] == ["PO-000002"]
    assert [s.code for s in source.suppliers(org.id)] == ["SUP-A", "SUP-B", "SUP-OLD"]
    assert [s.archived for s in source.suppliers(org.id)] == [False, False, True]


def test_window_uses_first_delivery_and_ignores_later_receipts(conn, source):
    org = Org(conn)
    sup = org.supplier("SUP-A")
    po = org.order(sup, T0)
    org.receive(po, T0 + timedelta(days=3))

    as_of = T0 + timedelta(days=2)
    assert source.deliveries(org.id, as_of - timedelta(days=30), as_of) == []
    after = T0 + timedelta(days=3)
    assert len(source.deliveries(org.id, after - timedelta(days=1), after)) == 1
    # First delivery before the window start: the order belongs to an earlier window.
    assert source.deliveries(org.id, after + timedelta(seconds=1), after + timedelta(days=30)) == []


def test_queries_are_scoped_to_the_organization(conn, source):
    mine, theirs = Org(conn), Org(conn)
    po = theirs.order(theirs.supplier("SUP-X"), T0)
    theirs.receive(po, T0 + timedelta(days=4), final=True)

    assert source.organization_exists(mine.id)
    assert not source.organization_exists(str(uuid.uuid4()))
    assert source.deliveries(mine.id, *WINDOW) == []
    assert source.suppliers(mine.id) == []
    assert len(source.deliveries(theirs.id, *WINDOW)) == 1


def test_default_connections_are_read_only():
    psycopg = pytest.importorskip("psycopg")
    from supplypilot_worker.repository import read_only_connection

    with read_only_connection(DATABASE_URL)() as connection:
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            connection.execute("INSERT INTO organizations (slug, name) VALUES ('nope', 'Nope')")
