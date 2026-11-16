# Week 01 acceptance cases: monorepo and synthetic fixtures

Scope: the repository skeleton, local tooling and the synthetic fixture generator
described in [ADR 0001](../adr/0001-monorepo-and-synthetic-fixtures.md).
Each case is written as Given / When / Then and must be verifiable from a clean
checkout.

## Repository and tooling

**AC-01.1 — Clean install**
- Given a fresh clone and the documented Node.js and Python versions
- When the documented install command is run
- Then all workspaces install without errors and without network access to
  anything other than the package registries

**AC-01.2 — Uniform checks**
- Given the installed repository
- When `lint`, `typecheck` and `test` are run from the root
- Then each workspace runs its own check and the root command fails if any
  workspace fails

**AC-01.3 — Local services**
- Given Docker is available
- When the Compose stack in `infra/compose` is started
- Then PostgreSQL and Redis report healthy, and no service needs credentials that
  are not in `.env.example`

**AC-01.4 — No secrets committed**
- Given the repository history
- When a secret scanner runs in CI
- Then no keys, tokens or passwords are found, and `.env` files are ignored by git

## Fixture generator

**AC-01.5 — Deterministic output**
- Given the default seed and reference date
- When the generator runs twice
- Then both runs produce byte-identical files

**AC-01.6 — Different seed, different data**
- Given two different seeds
- When the generator runs with each
- Then the outputs differ, and both pass schema validation

**AC-01.7 — Fixture version recorded**
- Given any generated fixture set
- When its manifest is read
- Then it states the `fixture_version`, seed, reference date and record counts

**AC-01.8 — Tenant isolation coverage**
- Given the default fixture set
- When records are grouped by organization
- Then there are at least two organizations, and every warehouse, SKU, supplier,
  movement and purchase order belongs to exactly one of them

**AC-01.9 — Referential integrity**
- Given the default fixture set
- When references are checked
- Then every movement points to an existing SKU and warehouse in the same
  organization, and every purchase order line points to an existing SKU and supplier

**AC-01.10 — Ledger-consistent stock**
- Given the inventory movements for a SKU and warehouse
- When they are summed in time order
- Then on-hand quantity never goes negative

**AC-01.11 — Demo scenarios present**
- Given the default fixture set
- Then it contains at least: one SKU at or below its reorder point, one supplier
  whose lead times vary widely, one late purchase order and one partially
  received purchase order

**AC-01.12 — Plainly synthetic**
- Given any generated name, email or address
- Then it uses reserved or obviously fictional values (for example the
  `example.com` domain) and matches no real organization

**AC-01.13 — CSV doubles as import sample**
- Given the generated CSV files
- Then they have a header row, UTF-8 encoding and the column names expected by
  the CSV import feature

## Out of scope this week

- Authentication and roles (week 02)
- Persisting fixtures through the API (fixtures are loaded directly for now)
- Performance-sized datasets

## Risks and open questions

- Running both Node.js and Python tooling adds setup steps; the Compose stack and
  a single root script should hide most of this.
- The fixture schema will change as domain models are added in weeks 03–04; the
  generator must be updated in the same change as each schema migration.
- Choosing the default dataset size: large enough to make the dashboard look
  realistic, small enough that the full test suite stays fast.
