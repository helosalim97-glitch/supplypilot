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
| Catalog routes (below) | Member of `:orgId`; writes need `manager` |

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

### Endpoints

All routes are under `/v1/organizations/:orgId`. Any member can read; creating
records needs `manager` or higher. Successful responses are `{ "data": ... }`.

| Route | Role | Notes |
|---|---|---|
| `GET /suppliers`, `GET /warehouses`, `GET /skus` | viewer | Active (non-archived) records, ordered by code |
| `GET /suppliers/:id`, `GET /warehouses/:id`, `GET /skus/:id` | viewer | `404` for unknown, malformed or other-tenant ids |
| `POST /suppliers` | manager | `code`, `name`, optional `contactEmail` |
| `POST /warehouses` | manager | `code`, `name` |
| `POST /skus` | manager | `code`, `name`, `unit`, `unitCostCents`, optional `reorderPoint` (default 0) and `preferredSupplierId` |

Validation mirrors the database constraints: codes are 1–40 letters, digits,
`.`, `_` or `-`; names are trimmed and must not be blank; `unit` is lowercase
(`each`, `case_12`); amounts are whole numbers ≥ 0. Unknown fields are
rejected. A duplicate code in the same organization (any case) returns `409`;
a preferred supplier from another organization returns `422`.

## Errors

Every error response has the same shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some fields are invalid",
    "details": [{ "field": "unitCostCents", "message": "must be a whole number from 0 to 2147483647" }],
    "requestId": "3f0c5c3e-6d0e-4a59-9a43-2b1f0f8a7c11"
  }
}
```

| Status | `code` |
|---|---|
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `duplicate_code` |
| 422 | `validation_failed` (with `details`) |
| 500 | `internal_error` |

Each request gets a correlation id: the caller's `X-Request-Id` if it is 8–128
characters of letters, digits, `.`, `_` or `-`, otherwise a new UUID. It is
returned in the `X-Request-Id` header and in `error.requestId`. Unexpected
errors are logged with that id; their details are never sent to the client.
`GET /v1/health` keeps its own report body for both `200` and `503`.

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
