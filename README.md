# SupplyPilot

**Inventory intelligence for multi-location merchants.** SupplyPilot shows which stockouts come from late suppliers, which purchase orders are delayed, and what a proposed reorder would do to inventory and cash, with the numbers behind every recommendation.

> **Status:** early development. The project is being built over a 12-week roadmap (see below). It uses only synthetic data and local mocks.

## The problem

Merchants that run more than one warehouse struggle to answer basic questions:

- Was this stockout caused by demand, or by a supplier that delivered late?
- Which purchase orders are delayed, and by how much?
- If I reorder now, what happens to stock levels and cash next month?

SupplyPilot puts stock movements, supplier lead times and purchase orders in one place and answers these questions with deterministic calculations. AI can explain those calculations but never replaces them.

## Who it's for

- **Inventory planners:** monitor stock and run demand scenarios
- **Purchasing managers:** review reorder proposals and approve purchase orders
- **Warehouse operators:** receive shipments, including partial ones
- **Administrators:** manage organizations, warehouses and permissions

## Demo workflow

1. Import synthetic SKUs and supplier lead times
2. Reconcile warehouse balances
3. Simulate a demand spike
4. Review reorder recommendations with numerical evidence
5. Approve a purchase order
6. Receive a partial shipment
7. Inspect the audit trail

## Planned features

- Organization and warehouse permissions
- SKU catalog, units and stock movements
- CSV import with field mapping and deduplication
- Supplier profiles and lead-time history
- Purchase orders, approvals and receipts
- Deterministic reorder-point calculator
- Demand scenario sandbox
- AI explanations of reorder recommendations that cite the actual calculations
- Alerts and exceptions dashboard
- Inventory audit trail and exports

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, TypeScript |
| API | NestJS |
| Forecasting worker | Python, FastAPI |
| Database | PostgreSQL |
| Queue and cache | Redis, BullMQ |
| Local environment | Docker Compose |
| CI | GitHub Actions |

## Architecture

The system starts as a modular monolith for transactional writes. Slow work such as imports, forecasting and AI explanations runs in background jobs. PostgreSQL is the single source of truth; caches are never authoritative.

```mermaid
flowchart LR
  User[Web user] --> Web[Next.js frontend]
  Web --> API[NestJS domain API]
  API --> DB[(PostgreSQL)]
  API --> Queue[Redis / BullMQ]
  Queue --> Worker[FastAPI forecasting worker]
  Worker --> DB
  Worker --> AI[Optional AI adapter]
  API --> Audit[(Audit trail)]
```

### Planned repository layout

```text
supplypilot/
├── apps/web/              # Next.js frontend
├── services/api/          # NestJS domain API
├── services/worker/       # FastAPI forecasting worker
├── packages/contracts/    # OpenAPI contracts and generated clients
├── packages/fixtures/     # synthetic demo data
├── infra/compose/         # local services
├── tests/                 # integration and end-to-end tests
└── docs/                  # architecture decisions and progress notes
```

## Design rules

- Stock movements are append-only; corrections use compensating events.
- Receiving the same shipment twice never increases stock twice.
- Reorder proposals never become purchase orders without human approval.
- AI output is a draft that must cite real calculations; it never acts on its own.
- Every business action is authorized on the server, not just in the UI.
- Retries are safe through idempotency keys and unique constraints.

## Roadmap

| Weeks | Focus |
|---|---|
| 1–2 | Monorepo setup, synthetic fixtures, tenant identity and roles |
| 3–4 | SKU, warehouse and supplier models; stock ledger and balances |
| 5–7 | CSV import, purchase order approvals, receiving and partial shipments |
| 8–9 | Reorder-point calculator, scenario simulation, versioned snapshots |
| 10 | AI explanation adapter with citation checks |
| 11–12 | Hardening, deployment and the end-to-end demo |

## Documentation

- [Architecture decisions](docs/adr/README.md)
- [Week 01 acceptance cases](docs/acceptance/week-01-monorepo-and-fixtures.md)
- [Progress notes](docs/progress/week-01.md)

## Getting started

Setup instructions will be added once the first services are in place.
