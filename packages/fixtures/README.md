# supplypilot-fixtures

Deterministic synthetic supply chain data for demos and tests, following
[ADR 0001](../../docs/adr/0001-monorepo-and-synthetic-fixtures.md). Python 3.11+,
standard library only.

```bash
cd packages/fixtures
python3 -m supplypilot_fixtures --out ../../.fixtures            # default seed 1042, reference date 2026-01-05
python3 -m supplypilot_fixtures --out /tmp/fx --seed 7 --reference-date 2026-03-01
python3 -m unittest discover -s tests -t .                         # acceptance tests AC-01.5 to AC-01.13
```

## What the default set contains

- 2 organizations, 5 warehouses, 6 suppliers, 12 SKUs
- 60 days of inventory events (opening receipts, daily sales, small adjustments, PO receipts)
- 8 lead-time records per supplier; the third supplier of each organization is erratic
- Per organization: one fully received, one partially received and one late purchase order
- Per organization: one SKU that ends below its reorder point in its first warehouse

Stock is only expressed as events; balances come from summing the ledger, and no
SKU ever goes below zero. All names are invented and all emails use `example.com`.

## Output

| File | Purpose |
|---|---|
| `<table>.json` | One file per table, for seeding the database |
| `manifest.json` | `fixture_version`, seed, reference date and record counts |
| `csv/skus.csv`, `csv/suppliers.csv`, `csv/inventory_events.csv` | Sample files for the CSV import feature |

The same seed and reference date always produce byte-identical files.
