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
