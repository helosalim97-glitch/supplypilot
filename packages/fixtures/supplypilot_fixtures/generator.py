"""Generate a reproducible, clearly synthetic supply chain dataset.

The same seed and reference date always produce the same records, and
`write_fixture_set` always writes the same bytes for them. Stock is expressed
only as inventory events; balances are derived by summing the ledger.
"""

from __future__ import annotations

import csv
import io
import json
import random
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

FIXTURE_VERSION = "1"
DEFAULT_SEED = 1042
DEFAULT_REFERENCE_DATE = date(2026, 1, 5)
HISTORY_DAYS = 60

ORGANIZATIONS = [
    ("Example Outfitters (Synthetic)", ["Riverside DC", "Hilltop Store", "Harbor Overflow"]),
    ("Demo Pantry Co. (Synthetic)", ["Central Kitchen", "Eastside Depot"]),
]
SUPPLIER_NAMES = ["Acme Sample Supply", "Placeholder Parts Ltd", "Fictional Freight Goods"]
PRODUCTS = [
    ("Trail Water Bottle", "each"), ("Wool Hiking Socks", "pair"), ("Camp Mug", "each"),
    ("Headlamp", "each"), ("Rain Shell", "each"), ("Trekking Pole", "each"),
    ("Energy Bar Box", "case"), ("First Aid Kit", "each"), ("Dry Bag", "each"),
]

# Column order for the CSV files; these double as sample files for CSV import.
CSV_COLUMNS = {
    "skus": ["sku_code", "name", "unit", "unit_cost_cents", "reorder_point", "preferred_supplier_code"],
    "suppliers": ["supplier_code", "name", "contact_email"],
    "inventory_events": ["event_id", "sku_code", "warehouse_code", "event_type", "quantity", "occurred_at"],
}

REQUIRED_FIELDS = {
    "organizations": {"id": str, "name": str},
    "warehouses": {"id": str, "organization_id": str, "code": str, "name": str},
    "suppliers": {"id": str, "organization_id": str, "code": str, "name": str, "contact_email": str},
    "supplier_lead_times": {"id": str, "organization_id": str, "supplier_id": str, "ordered_on": str, "lead_time_days": int},
    "skus": {"id": str, "organization_id": str, "code": str, "name": str, "unit": str,
             "unit_cost_cents": int, "reorder_point": int, "preferred_supplier_id": str},
    "purchase_orders": {"id": str, "organization_id": str, "supplier_id": str, "warehouse_id": str,
                        "status": str, "ordered_on": str, "expected_on": str},
    "purchase_order_lines": {"id": str, "organization_id": str, "purchase_order_id": str, "sku_id": str, "quantity": int},
    "receipts": {"id": str, "organization_id": str, "purchase_order_line_id": str, "quantity": int, "received_at": str},
    "inventory_events": {"id": str, "organization_id": str, "sku_id": str, "warehouse_id": str,
                         "event_type": str, "quantity": int, "occurred_at": str},
}
EVENT_TYPES = {"receipt", "sale", "adjustment"}
PO_STATUSES = {"approved", "partially_received", "received"}


def _ts(day: date, hour: int, minute: int = 0) -> str:
    return datetime.combine(day, time(hour, minute), tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def generate(seed: int = DEFAULT_SEED, reference_date: date = DEFAULT_REFERENCE_DATE) -> dict:
    """Return the full fixture set as a dict of table name -> list of records."""
    rng = random.Random(seed)
    start = reference_date - timedelta(days=HISTORY_DAYS)
    data: dict[str, list[dict]] = {name: [] for name in REQUIRED_FIELDS}
    counters: dict[str, int] = defaultdict(int)

    def next_id(prefix: str) -> str:
        counters[prefix] += 1
        return f"{prefix}_{counters[prefix]:04d}"

    def add_event(org_id, sku_id, wh_id, kind, qty, at, receipt_id=None):
        event = {"id": next_id("evt"), "organization_id": org_id, "sku_id": sku_id, "warehouse_id": wh_id,
                 "event_type": kind, "quantity": qty, "occurred_at": at}
        if receipt_id:
            event["receipt_id"] = receipt_id
        data["inventory_events"].append(event)

    for org_index, (org_name, warehouse_names) in enumerate(ORGANIZATIONS, start=1):
        org_id = next_id("org")
        data["organizations"].append({"id": org_id, "name": org_name})
        slug = f"O{org_index}"

        warehouses = []
        for w, wh_name in enumerate(warehouse_names, start=1):
            wh = {"id": next_id("wh"), "organization_id": org_id, "code": f"{slug}-WH{w}", "name": wh_name}
            warehouses.append(wh)
        data["warehouses"].extend(warehouses)

        # The last supplier is erratic: same mean lead time, much wider spread.
        suppliers = []
        for s, sup_name in enumerate(SUPPLIER_NAMES, start=1):
            code = f"{slug}-SUP{s}"
            sup = {"id": next_id("sup"), "organization_id": org_id, "code": code, "name": sup_name,
                   "contact_email": f"orders.{code.lower()}@example.com"}
            suppliers.append(sup)
            mean, spread = rng.randint(5, 9), (8 if s == len(SUPPLIER_NAMES) else 1)
            for k in range(8):
                ordered = start + timedelta(days=k * 7)
                days = max(1, mean + rng.randint(-spread, spread))
                data["supplier_lead_times"].append({
                    "id": next_id("lt"), "organization_id": org_id, "supplier_id": sup["id"],
                    "ordered_on": ordered.isoformat(), "lead_time_days": days})
        data["suppliers"].extend(suppliers)

        products = rng.sample(PRODUCTS, k=6)
        skus = []
        for p, (name, unit) in enumerate(products, start=1):
            sku = {"id": next_id("sku"), "organization_id": org_id, "code": f"{slug}-SKU{p:03d}", "name": name,
                   "unit": unit, "unit_cost_cents": rng.randint(150, 9000), "reorder_point": rng.randint(10, 30),
                   "preferred_supplier_id": suppliers[(p - 1) % len(suppliers)]["id"]}
            skus.append(sku)
        data["skus"].extend(skus)

        # Ledger: opening receipt, then daily sales that never exceed stock on hand.
        on_hand = {}
        for sku in skus:
            for wh in warehouses:
                qty = rng.randint(60, 140)
                add_event(org_id, sku["id"], wh["id"], "receipt", qty, _ts(start, 8))
                on_hand[(sku["id"], wh["id"])] = qty
        for d in range(1, HISTORY_DAYS):
            day = start + timedelta(days=d)
            for sku in skus:
                for wh in warehouses:
                    key = (sku["id"], wh["id"])
                    sold = min(on_hand[key], rng.randint(0, 3))
                    if sold:
                        add_event(org_id, sku["id"], wh["id"], "sale", -sold, _ts(day, 12 + rng.randint(0, 6)))
                        on_hand[key] -= sold
            if d % 20 == 0:
                sku, wh = rng.choice(skus), rng.choice(warehouses)
                if on_hand[(sku["id"], wh["id"])] > 0:
                    add_event(org_id, sku["id"], wh["id"], "adjustment", -1, _ts(day, 18))
                    on_hand[(sku["id"], wh["id"])] -= 1

        # Purchase orders: one fully received, one partially received, one late and unreceived.
        po_plans = [("received", 40, 1.0), ("partially_received", 30, 0.5), ("approved", 20, 0.0)]
        for i, (status, days_ago, fraction) in enumerate(po_plans):
            sup = suppliers[i % len(suppliers)]
            wh = warehouses[0]
            ordered = reference_date - timedelta(days=days_ago)
            expected = ordered + timedelta(days=10)
            po = {"id": next_id("po"), "organization_id": org_id, "supplier_id": sup["id"], "warehouse_id": wh["id"],
                  "status": status, "ordered_on": ordered.isoformat(), "expected_on": expected.isoformat()}
            data["purchase_orders"].append(po)
            for sku in skus[i * 2:i * 2 + 2]:
                line = {"id": next_id("pol"), "organization_id": org_id, "purchase_order_id": po["id"],
                        "sku_id": sku["id"], "quantity": rng.randint(20, 60)}
                data["purchase_order_lines"].append(line)
                received = int(line["quantity"] * fraction)
                if received:
                    at = _ts(expected - timedelta(days=1), 10)
                    receipt = {"id": next_id("rcpt"), "organization_id": org_id,
                               "purchase_order_line_id": line["id"], "quantity": received, "received_at": at}
                    data["receipts"].append(receipt)
                    add_event(org_id, sku["id"], wh["id"], "receipt", received, at, receipt_id=receipt["id"])
                    on_hand[(sku["id"], wh["id"])] += received

        # Demo scenario: the first SKU in the first warehouse ends below its reorder point.
        low_key = (skus[0]["id"], warehouses[0]["id"])
        excess = on_hand[low_key] - (skus[0]["reorder_point"] - 2)
        if excess > 0:
            add_event(org_id, *low_key, "sale", -excess, _ts(reference_date - timedelta(days=1), 15))
            on_hand[low_key] -= excess

    data["inventory_events"].sort(key=lambda e: (e["occurred_at"], e["id"]))
    data["manifest"] = {
        "fixture_version": FIXTURE_VERSION,
        "seed": seed,
        "reference_date": reference_date.isoformat(),
        "record_counts": {name: len(data[name]) for name in REQUIRED_FIELDS},
    }
    return data


def validate(data: dict) -> list[str]:
    """Return a list of problems; an empty list means the fixture set is valid."""
    problems = []
    for table, fields in REQUIRED_FIELDS.items():
        for record in data.get(table, []):
            for field, kind in fields.items():
                if not isinstance(record.get(field), kind):
                    problems.append(f"{table}.{record.get('id')}: {field} should be {kind.__name__}")
    problems += [f"inventory_events.{e['id']}: unknown type {e['event_type']}"
                 for e in data.get("inventory_events", []) if e.get("event_type") not in EVENT_TYPES]
    problems += [f"purchase_orders.{p['id']}: unknown status {p['status']}"
                 for p in data.get("purchase_orders", []) if p.get("status") not in PO_STATUSES]
    return problems


def _csv_rows(data: dict, table: str) -> list[list]:
    codes = {r["id"]: r["code"] for t in ("skus", "warehouses", "suppliers") for r in data[t]}
    if table == "skus":
        return [[r["code"], r["name"], r["unit"], r["unit_cost_cents"], r["reorder_point"],
                 codes[r["preferred_supplier_id"]]] for r in data["skus"]]
    if table == "suppliers":
        return [[r["code"], r["name"], r["contact_email"]] for r in data["suppliers"]]
    return [[r["id"], codes[r["sku_id"]], codes[r["warehouse_id"]], r["event_type"], r["quantity"],
             r["occurred_at"]] for r in data["inventory_events"]]


def write_fixture_set(data: dict, out_dir: Path | str) -> list[Path]:
    """Write JSON (for seeding) and CSV (import samples) files; return the paths written."""
    out = Path(out_dir)
    (out / "csv").mkdir(parents=True, exist_ok=True)
    written = []
    for name, records in data.items():
        path = out / f"{name}.json"
        path.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        written.append(path)
    for table, columns in CSV_COLUMNS.items():
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(columns)
        writer.writerows(_csv_rows(data, table))
        path = out / "csv" / f"{table}.csv"
        path.write_text(buffer.getvalue(), encoding="utf-8")
        written.append(path)
    return written
