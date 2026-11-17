# @supplypilot/api

NestJS HTTP API for SupplyPilot.

## Run locally

```bash
cp .env.example .env          # from the repo root
pnpm services:up              # PostgreSQL and Redis
pnpm db:migrate               # apply pending SQL migrations
pnpm api:dev                  # http://localhost:3001/v1/health
```

| Variable | Default | Purpose |
|---|---|---|
| `API_PORT` | `3001` | HTTP port |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |

## Health

`GET /v1/health` returns `200 {"status":"ok","checks":{"database":"up"}}`, or
`503` with `"status":"degraded"` when PostgreSQL does not answer. Error details
are never included in the response.

## Tenancy and roles

Every user belongs to one or more organizations through a membership with a
role: `owner` > `manager` > `buyer` > `viewer` (a higher role can do everything
a lower one can).

Requests authenticate with `Authorization: Bearer <token>`. Tokens live in
`api_tokens` as SHA-256 hashes only, and can expire or be revoked.

| Route | Access |
|---|---|
| `GET /v1/me/organizations` | Any valid token; lists the caller's organizations and roles |
| `GET /v1/organizations/:orgId/membership` | Member of `:orgId` (any role) |

`TenantGuard` runs on these routes. A missing or invalid token gets `401`.
Routes marked `@RequireRole(role)` also need a membership in `:orgId` with at
least that role; otherwise `403`. Unknown organizations and other tenants'
organizations get the same `403`, so responses don't reveal which
organizations exist.

## Catalog

Migration `0003_catalog` adds `suppliers`, `warehouses` and `skus`. Each row
belongs to one organization, and `code` is unique per organization
(case-insensitive). A SKU's preferred supplier must be in the same
organization (composite foreign key). Unit costs are integer cents. Records are
archived (`archived_at`) instead of deleted, so later stock events and purchase
orders keep their references.

`CatalogRepository` scopes every query by organization id and turns duplicate
codes and unknown references into `DuplicateCodeError` and
`UnknownReferenceError`.

## Migrations

Plain SQL files in `migrations/`, named `NNNN_snake_case_name.sql`, applied in
version order by `pnpm db:migrate`.

- Each file runs in its own transaction together with its row in
  `schema_migrations` (version, name, SHA-256 checksum, applied time), so a
  failing migration leaves no partial schema behind.
- A PostgreSQL advisory lock stops two runners from applying migrations at the
  same time.
- Applied files must not be edited: the runner refuses to continue if a
  checksum changed or an applied file is missing.

**Rollback strategy:** migrations are forward-only. To undo a change, add a new
migration that reverses it, and keep schema changes backward compatible with
the previous API release (add columns as nullable first, backfill, then
tighten) so the API can be rolled back without touching the schema.
