"""Acceptance tests for the fixture generator (docs/acceptance/week-01, AC-01.5 to AC-01.13)."""

import csv
import json
import statistics
import tempfile
import unittest
from collections import defaultdict
from datetime import date
from pathlib import Path

from supplypilot_fixtures import CSV_COLUMNS, FIXTURE_VERSION, generate, validate, write_fixture_set

OWNED_TABLES = ["warehouses", "suppliers", "supplier_lead_times", "skus", "purchase_orders",
                "purchase_order_lines", "receipts", "inventory_events"]


def read_all(directory: Path) -> dict:
    return {p.relative_to(directory).as_posix(): p.read_bytes() for p in sorted(directory.rglob("*")) if p.is_file()}


class GeneratorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = generate()
        cls.by_id = {r["id"]: r for t in OWNED_TABLES + ["organizations"] for r in cls.data[t]}

    def balances(self):
        totals = defaultdict(int)
        for event in sorted(self.data["inventory_events"], key=lambda e: (e["occurred_at"], e["id"])):
            key = (event["sku_id"], event["warehouse_id"])
            totals[key] += event["quantity"]
            self.assertGreaterEqual(totals[key], 0, f"negative stock at {event['id']}")
        return totals

    # AC-01.5
    def test_same_seed_writes_identical_bytes(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            write_fixture_set(generate(), a)
            write_fixture_set(generate(), b)
            self.assertEqual(read_all(Path(a)), read_all(Path(b)))

    # AC-01.6
    def test_different_seed_gives_different_valid_data(self):
        other = generate(seed=7)
        self.assertNotEqual(other["inventory_events"], self.data["inventory_events"])
        self.assertEqual(validate(other), [])
        self.assertEqual(validate(self.data), [])

    # AC-01.7
    def test_manifest_records_version_seed_date_and_counts(self):
        manifest = generate(seed=99, reference_date=date(2026, 3, 1))["manifest"]
        self.assertEqual(manifest["fixture_version"], FIXTURE_VERSION)
        self.assertEqual(manifest["seed"], 99)
        self.assertEqual(manifest["reference_date"], "2026-03-01")
        for table, count in self.data["manifest"]["record_counts"].items():
            self.assertEqual(count, len(self.data[table]))

    # AC-01.8
    def test_every_record_belongs_to_one_of_several_organizations(self):
        org_ids = {o["id"] for o in self.data["organizations"]}
        self.assertGreaterEqual(len(org_ids), 2)
        for table in OWNED_TABLES:
            for record in self.data[table]:
                self.assertIn(record["organization_id"], org_ids, f"{table}.{record['id']}")

    # AC-01.9
    def test_references_point_to_records_in_the_same_organization(self):
        refs = {
            "inventory_events": ["sku_id", "warehouse_id"],
            "purchase_order_lines": ["purchase_order_id", "sku_id"],
            "purchase_orders": ["supplier_id", "warehouse_id"],
            "receipts": ["purchase_order_line_id"],
            "skus": ["preferred_supplier_id"],
            "supplier_lead_times": ["supplier_id"],
        }
        for table, fields in refs.items():
            for record in self.data[table]:
                for field in fields:
                    target = self.by_id.get(record[field])
                    self.assertIsNotNone(target, f"{table}.{record['id']}.{field} is dangling")
                    self.assertEqual(target["organization_id"], record["organization_id"])

    # AC-01.10
    def test_stock_never_goes_negative(self):
        self.balances()

    def test_receipt_events_match_receipts(self):
        linked = {e["receipt_id"]: e["quantity"] for e in self.data["inventory_events"] if "receipt_id" in e}
        self.assertEqual(linked, {r["id"]: r["quantity"] for r in self.data["receipts"]})

    # AC-01.11
    def test_demo_scenarios_are_present(self):
        ref = self.data["manifest"]["reference_date"]
        balances = self.balances()
        self.assertTrue(any(qty <= self.by_id[sku]["reorder_point"] for (sku, _), qty in balances.items()),
                        "no SKU at or below its reorder point")

        spreads = defaultdict(list)
        for row in self.data["supplier_lead_times"]:
            spreads[row["supplier_id"]].append(row["lead_time_days"])
        self.assertTrue(any(statistics.pstdev(v) >= 3 for v in spreads.values()), "no erratic supplier")

        received = defaultdict(int)
        for receipt in self.data["receipts"]:
            received[self.by_id[receipt["purchase_order_line_id"]]["purchase_order_id"]] += receipt["quantity"]
        ordered = defaultdict(int)
        for line in self.data["purchase_order_lines"]:
            ordered[line["purchase_order_id"]] += line["quantity"]
        pos = self.data["purchase_orders"]
        self.assertTrue(any(p["expected_on"] < ref and received[p["id"]] == 0 for p in pos), "no late PO")
        self.assertTrue(any(0 < received[p["id"]] < ordered[p["id"]] for p in pos), "no partial receipt")

    # AC-01.12
    def test_names_and_emails_are_plainly_synthetic(self):
        for org in self.data["organizations"]:
            self.assertIn("(Synthetic)", org["name"])
        for supplier in self.data["suppliers"]:
            self.assertTrue(supplier["contact_email"].endswith("@example.com"))

    # AC-01.13
    def test_csv_files_have_expected_headers_and_rows(self):
        with tempfile.TemporaryDirectory() as out:
            write_fixture_set(self.data, out)
            for table, columns in CSV_COLUMNS.items():
                path = Path(out) / "csv" / f"{table}.csv"
                with path.open(encoding="utf-8", newline="") as handle:
                    rows = list(csv.reader(handle))
                self.assertEqual(rows[0], columns)
                self.assertEqual(len(rows) - 1, len(self.data[table]))
            manifest = json.loads((Path(out) / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["fixture_version"], FIXTURE_VERSION)

    def test_validate_reports_bad_records(self):
        broken = generate()
        broken["skus"][0]["reorder_point"] = "ten"
        broken["inventory_events"][0]["event_type"] = "teleport"
        self.assertEqual(len(validate(broken)), 2)


if __name__ == "__main__":
    unittest.main()
