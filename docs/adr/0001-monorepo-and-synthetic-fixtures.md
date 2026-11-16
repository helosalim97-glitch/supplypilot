# 0001. Monorepo layout and synthetic fixture strategy

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

SupplyPilot has a Next.js frontend, a NestJS domain API and a Python FastAPI
forecasting worker. All three depend on the same domain vocabulary (organizations,
warehouses, SKUs, suppliers, purchase orders) and the same demo data. The project
must run as a repeatable offline demo, and it may only use synthetic data.

Two early choices shape everything that follows:

1. How the code is split across repositories and deployable units.
2. Where demo data comes from and how it stays reproducible.

## Decision

### Repository and service layout

- **One repository** containing every app, service and shared package.
- **Modular monolith for writes.** `services/api` is the only component that changes
  domain state. It is organized by module (inventory, purchasing, suppliers, audit)
  with explicit module boundaries instead of separate network services.
- **Background work is separate.** Slow or bursty work (CSV import, forecasting, AI
  explanations) runs as queued jobs. The Python worker in `services/worker` reads
  inputs and writes results back through well-defined tables or API calls; it never
  bypasses domain invariants.
- **Contracts are the boundary.** `packages/contracts` holds the OpenAPI document
  for the `/v1` API. TypeScript clients are generated from it, and the Python worker
  validates against the same schemas.
- **Tooling.** TypeScript workspaces use pnpm workspaces. The Python worker is a
  self-contained project with its own `pyproject.toml`. Each workspace exposes the
  same script names (`lint`, `typecheck`, `test`) so CI can call them uniformly.

```text
supplypilot/
├── apps/web/              # Next.js frontend
├── services/api/          # NestJS domain API (only writer of domain state)
├── services/worker/       # FastAPI forecasting worker and background jobs
├── packages/contracts/    # OpenAPI contract and generated clients
├── packages/fixtures/     # synthetic demo data and its generator
├── infra/compose/         # local PostgreSQL, Redis and services
├── tests/integration/     # database and cross-service tests
├── tests/e2e/             # browser workflows
└── docs/                  # ADRs, acceptance cases, progress notes
```

### Synthetic fixtures

- **Generated, not hand-written.** A generator in `packages/fixtures` produces the
  demo dataset from a fixed seed and a fixed reference date. The same seed always
  produces byte-identical output.
- **Versioned.** Each fixture set carries a `fixture_version`. Tests and snapshots
  record which version they ran against.
- **Plainly fake.** Organization, supplier and product names are invented and
  clearly synthetic. No real companies, people, addresses, prices or credentials.
- **Covers the demo and the edge cases.** The default set includes at least two
  organizations (to test tenant isolation), several warehouses per organization,
  suppliers with consistent and erratic lead times, SKUs near their reorder point,
  a late purchase order and a partially received shipment.
- **Stock is expressed as events.** Fixtures provide inventory movements, not
  pre-computed balances, so the seeded state goes through the same append-only
  ledger as real usage.
- **Plain formats.** Output is JSON for seeding and CSV for the import workflow, so
  fixtures double as sample files for the CSV ingestion feature.

## Consequences

- One pull request can change the contract, the API and the UI together, and CI
  checks them together.
- Module boundaries inside `services/api` must be enforced by convention and lint
  rules, since nothing at the network level stops cross-module calls.
- Contributors need both Node.js and Python installed. Docker Compose covers the
  databases, so no other local services are required.
- Deterministic fixtures make test failures reproducible and let demo screenshots
  be regenerated, at the cost of maintaining the generator alongside the schema.

## Alternatives considered

- **Separate repositories per service.** Rejected: early on the contract changes
  often, and keeping several repositories in sync would slow every change.
- **Microservices from the start.** Rejected: there is no scaling need yet, and
  distributed transactions would complicate the core stock-ledger invariants.
- **Hand-written seed files.** Rejected: they drift from the schema, are hard to
  scale to realistic volumes and are easy to break silently.
- **Anonymized real data.** Rejected: the project is limited to synthetic data, and
  anonymization carries re-identification risk.
