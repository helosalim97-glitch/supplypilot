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
| `IMPORT_WORKER_POLL_MS` | `2000` | How often the import worker looks for queued imports (0–60000; `0` turns it off) |
| `IMPORT_STALE_AFTER_SECONDS` | `600` | An import stuck in `applying` this long is taken over (30–86400) |

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
| `POST /v1/organizations/:orgId/inventory/movements` | `manager` |
| Purchase order routes (below) | Member of `:orgId`; drafts, submitting, cancelling and reopening need `buyer`; approving and rejecting need `manager` |

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

## Inventory ledger

Migration `0004_inventory_events` adds `inventory_events`, the stock ledger.
Every change to on-hand stock is one event for a SKU in a warehouse, with a
signed `quantity_delta`. The table is append-only: a trigger rejects `UPDATE`,
`DELETE` and `TRUNCATE`. A wrong event is fixed with a `correction` event that
points at it (`correctsEventId`), so the history stays auditable. SKU,
warehouse and corrected event must belong to the same organization (composite
foreign keys).

### `POST /v1/organizations/:orgId/inventory/movements`

Needs `manager`. Requires an `Idempotency-Key` header (8–100 letters, digits,
`.`, `_`, `:` or `-`), unique per organization.

| Field | Notes |
|---|---|
| `skuId`, `warehouseId` | Active (non-archived) records of this organization |
| `type` | `receipt`, `issue`, `adjustment` or `correction` |
| `quantity` | Receipts and issues: whole number ≥ 1 (an issue is stored as a negative delta). Adjustments and corrections: signed, non-zero |
| `reason` | Optional, up to 500 characters; required for adjustments |
| `reference` | Optional, up to 120 characters (e.g. a PO or order number) |
| `occurredAt` | Optional ISO 8601 date-time with a time zone, not in the future; defaults to now |
| `correctsEventId` | Required for corrections, not allowed otherwise; must be an event for the same SKU and warehouse |

Responses:

- `201` with `{ "data": event }` and `Idempotent-Replayed: false` for a new movement.
- `200` with the original event and `Idempotent-Replayed: true` when the same
  key is retried with the same body, so a retried request never counts stock
  twice.
- `409 idempotency_conflict` when the key was already used for a different
  movement.
- `409 insufficient_stock` when the movement would take on-hand stock below
  zero (see below). Nothing is recorded; the error says how much is on hand.
- `422` for invalid fields, or a SKU, warehouse or corrected event that is
  not in this organization.

## Stock balances

Migration `0005_stock_balances` adds `stock_balances`, one row per SKU and
warehouse with the current `on_hand` quantity. It is a projection of the
ledger: an `AFTER INSERT` trigger on `inventory_events` updates it in the same
transaction as the event, so the two cannot drift apart. The migration
backfills balances for events recorded before it, and the
`stock_balance_drift` view lists any balance that differs from the sum of its
events (it should always be empty).

**Negative-stock rule:** `on_hand` can never go below zero. An issue, negative
adjustment or correction that would do so fails as a whole and returns
`409 insufficient_stock`. Concurrent movements for the same SKU and warehouse
are serialized by the balance row lock, so two issues cannot both spend the
same stock. The rule checks the current total; a back-dated `occurredAt` is
not replayed against older balances.

### `GET /v1/organizations/:orgId/inventory`

Any member (`viewer` and up). Lists balances with SKU and warehouse details,
ordered by SKU code then warehouse code. Archived SKUs and warehouses are left
out.

| Query parameter | Notes |
|---|---|
| `skuId`, `warehouseId` | Optional UUID filters |
| `limit` | 1–500, default 100 |
| `offset` | 0–100000, default 0 |

Each balance has `skuId`, `skuCode`, `skuName`, `unit`, `warehouseId`,
`warehouseCode`, `warehouseName`, `onHand`, `reorderPoint`,
`atOrBelowReorderPoint`, `eventCount`, `lastEventId`, `lastMovementAt` and
`updatedAt`. The response is `{ "data": [...], "page": { "skuId", "warehouseId",
"limit", "offset", "hasMore" } }`. Unknown or invalid query parameters return
`422`.

## CSV imports

Migration `0006_import_batches` adds `import_batches` and `import_rows`.
Uploading a CSV of stock movements stores a **preview**: every data row with
its original cells, the values picked out by the column mapping and either the
movement it would record or the reasons it cannot. Nothing is written to the
stock ledger at this stage.

### `POST /v1/organizations/:orgId/imports`

Needs `manager`. JSON body:

| Field | Notes |
|---|---|
| `fileName` | Up to 255 characters, shown back in the batch |
| `content` | The CSV text. The JSON body is limited to 100 kB; split bigger files |
| `mapping` | Optional `{ field: "Column name" }`; `null` leaves a field out. Fields not given are matched automatically |
| `defaultType` | Optional `receipt`, `issue` or `adjustment`, used when there is no type column or a type cell is empty |

**Reading the file:** cells are separated by `,` or `;` (detected from the
header line), quoted cells may hold delimiters, `""` and line breaks, and a
UTF-8 byte order mark and blank lines are ignored. Limits: 2,000 data rows,
30 columns, 500 characters per cell. Header names must be non-empty and
unique (ignoring case). A file that breaks these rules is rejected with
`422` on `content`, naming the row (`row 7: has a quoted cell that is never
closed`).

**Column mapping:** header names are compared lowercase with spaces and
punctuation removed.

| Field | Required | Matched automatically from |
|---|---|---|
| `skuCode` | yes | `sku code`, `sku`, `item code`, `item`, `product code`, `product` |
| `warehouseCode` | yes | `warehouse code`, `warehouse`, `location code`, `location`, `site` |
| `quantity` | yes | `quantity`, `qty`, `units` |
| `type` | no | `type`, `movement type`, `movement`, `event type` |
| `reason` | no | `reason`, `note`, `notes`, `comment` |
| `reference` | no | `reference`, `ref`, `po number`, `po`, `order number`, `document` |
| `occurredAt` | no | `occurred at`, `occurred`, `date`, `datetime`, `timestamp` |

A required field without a column, a column that is not in the file or one
column used for two fields is a `422` on `mapping.<field>`.

**Row checks** follow the movement endpoint: SKU and warehouse codes must be
active records of this organization (case-insensitive), the type must be
`receipt`, `issue` or `adjustment` (corrections need an event id and are
recorded one by one), receipts and issues take a whole number ≥ 1,
adjustments a signed non-zero one with a `reason`, and `occurredAt` is an ISO
8601 date-time with a time zone or a plain date (`2026-11-19`, read as
midnight UTC), not in the future. A row whose cell count differs from the
header is invalid too. Invalid rows do not fail the upload.

`201` returns the batch (`id`, `fileName`, `fileSha256`, `delimiter`,
`columns`, `mapping`, `defaultType`, `status: "previewed"`, `rowCount`,
`validCount`, `invalidCount`, `createdBy`, `createdAt`) with the first 50
rows in `data.rows`. Each row has `rowNumber` (the header is row 1),
`status` (`valid` or `invalid`), `cells`, `values`, `movement` (with resolved
`skuId`, `warehouseId` and signed `quantityDelta`, or `null`) and `errors`.

### `GET /v1/organizations/:orgId/imports/:importId`

Any member. The batch with a page of its rows in file order.

| Query parameter | Notes |
|---|---|
| `status` | Optional `valid` or `invalid` |
| `limit` | 1–500, default 50 |
| `offset` | 0–2000, default 0 |
| `outcome` | Optional `applied`, `duplicate` or `rejected` (rows of an applied batch) |

`404` for an import of another organization.

### `POST /v1/organizations/:orgId/imports/:importId/apply`

Needs `manager`. Migration `0007_import_apply_jobs` adds the apply states.
Applying runs as a background job: the request only queues the batch and
answers `202` with it in `queued`.

```
previewed -> queued -> applying -> applied
                ^          |
                +- failed <+
```

The **import worker** runs inside the API process. Every
`IMPORT_WORKER_POLL_MS` it claims the oldest queued batch with
`FOR UPDATE SKIP LOCKED`, so several API instances can poll the same table
without taking the same batch. A batch left in `applying` for longer than
`IMPORT_STALE_AFTER_SECONDS` is taken over by another worker; each claim
bumps `apply.attempts`, and only the latest attempt can write outcomes or
close the batch.

The worker records every valid row through the stock ledger, in file order
and as the user who asked to apply, and stores the outcome on the row:

| `outcome.outcome` | Meaning |
|---|---|
| `applied` | Recorded; `outcome.eventId` is the new ledger event |
| `duplicate` | Not recorded: same movement as an earlier row of the file (`outcome.duplicateOfRow`), or already in the ledger (`outcome.eventId`) |
| `rejected` | The ledger refused it; `outcome.message` says why (not enough stock, SKU or warehouse archived since the preview) |

**Deduplication.** Two rows are the same movement when SKU, warehouse, type,
quantity, reason, reference and `occurredAt` all match. A row without a date
is stamped with the upload time, so its movement is fixed by the batch. Each
row is recorded with the idempotency key `import:<SHA-256 of the movement>`:
importing a dated movement again, from the same file or another one, finds
the existing event instead of recording it twice. Undated rows of a file
uploaded again count as new movements (they get a new upload time). Add a
date or reference column to files where identical lines are really separate
movements.

Rejected rows do not stop the batch. An unexpected error (for example the
database going away) stops the attempt and marks the batch `failed` with
`apply.failureReason`; applying it again resumes after the last row with an
outcome. When every valid row has an outcome the batch is `applied`, with
`apply.appliedCount`, `apply.duplicateCount` and `apply.rejectedCount`.

Every batch response carries `apply` (`requestedBy`, `queuedAt`, `startedAt`,
`finishedAt`, `attempts`, the three counts and `failureReason`). Rows carry
`outcome`: `null` until applied, and always `null` for invalid rows.

| Response | When |
|---|---|
| `202` | Queued, or already `queued`/`applying` (nothing changes) |
| `404` | Unknown import or one of another organization |
| `409 import_already_applied` | The batch was applied already |
| `422 nothing_to_apply` | The batch has no valid rows |

## Purchase orders

Migration `0008_purchase_orders` adds `purchase_orders` and
`purchase_order_lines`. An order is raised against one supplier for delivery
to one warehouse; supplier, warehouse and SKUs must be active records of the
same organization (composite foreign keys, checked and share-locked when the
order is written). Orders are numbered per organization (`PO-000001`, ...)
from `purchase_order_numbers`; the counter row lock keeps numbers unique when
buyers create orders at the same time.

Each line is one SKU (at most once per order) with `quantityOrdered`
(1–1,000,000) and `unitCostCents`. The unit cost defaults to the SKU's
catalog cost at the time the line is written, so later price changes don't
rewrite existing orders. `lineTotalCents` is a generated column, capped at
10^13 cents per line, so order totals are always exact numbers.

New orders are `draft`. A trigger only lets lines be added, removed or
re-priced while the order is a draft. Orders and lines are never deleted.

All routes are under `/v1/organizations/:orgId/purchase-orders`.

| Route | Role | Notes |
|---|---|---|
| `GET /` | viewer | Newest first, without lines but with `lineCount`, `totalUnits`, `totalCents`; filters `status`, `supplierId`, `warehouseId`; `limit` 1–200 (default 50), `offset`, `page.hasMore` |
| `GET /:id` | viewer | Order with its lines (SKU code, name and unit included); `404` for unknown, malformed or other-tenant ids |
| `POST /` | buyer | Creates a draft: `supplierId`, `warehouseId`, optional `expectedOn` (`YYYY-MM-DD`) and `notes`, `lines` (1–200 of `{ skuId, quantity, unitCostCents? }`); `201` |
| `PUT /:id/lines` | buyer | `{ lines }` replaces every line of a draft; `409 purchase_order_not_editable` once the order left draft |
| `POST /:id/submit` | buyer | `draft` → `submitted`; optional `{ reason }` |
| `POST /:id/approve` | manager | `submitted` → `approved`; optional `{ reason }` |
| `POST /:id/reject` | manager | `submitted` → `rejected`; `{ reason }` required |
| `POST /:id/cancel` | buyer | `draft` or `submitted` → `cancelled`; `approved` → `cancelled` needs a manager; `{ reason }` required |
| `POST /:id/reopen` | buyer | `rejected` → `draft`, so the lines can be fixed and the order submitted again |
| `GET /:id/events` | viewer | The order's audit trail, oldest first |

```json
{
  "supplierId": "1f4b…",
  "warehouseId": "8a02…",
  "expectedOn": "2026-12-04",
  "lines": [
    { "skuId": "c3d9…", "quantity": 400 },
    { "skuId": "52ae…", "quantity": 24, "unitCostCents": 225 }
  ]
}
```

Invalid fields are reported with their line, e.g. `lines[1].quantity`. A SKU
listed twice, or a supplier, warehouse or SKU that is archived or belongs to
another organization, returns `422`.

### Approval workflow

Migration `0009_purchase_order_approvals` adds the approval columns and the
audit trail.

```
draft ──submit──▶ submitted ──approve──▶ approved ──(receipts)──▶ partially_received ──▶ received
  │                 │   └──reject──▶ rejected ──reopen──▶ draft
  └──cancel──▶ cancelled ◀──cancel── submitted / approved
```

- The rules live in `src/purchasing/purchasing.state-machine.ts`. A step that
  doesn't apply to the current status gets `409 invalid_status_transition`; a
  role that is too low gets `403 forbidden`.
- Four-eyes rule: whoever submitted an order can't approve or reject it, even
  as an owner (`403 self_decision_not_allowed`). They can still cancel it.
- The order row is locked while a step runs, so two managers deciding at the
  same time are serialized: one wins, the other gets `409`.
- Orders show `submittedBy`/`submittedAt`, `decidedBy`/`decidedAt` and
  `decisionReason`. Reopening clears them; the history stays in the audit trail.
- The database backs this up: a trigger refuses any status change that isn't
  an edge of the diagram (including the receiving edges used later), and a
  check constraint refuses a decision by the submitter.

Every change to an order (created, lines replaced, each status step) appends
a row to `audit_events` in the same transaction: action (e.g.
`purchase_order.approved`), actor, from/to status, reason and the order
number, line count and total. The table is tenant-scoped and append-only
(`UPDATE`, `DELETE` and `TRUNCATE` are refused by triggers).

```json
{
  "data": [
    { "action": "purchase_order.submitted", "actorId": "…", "fromStatus": "draft", "toStatus": "submitted", "reason": null, "details": { "number": "PO-000001", "lineCount": 2, "totalCents": 39400 }, "occurredAt": "…" },
    { "action": "purchase_order.approved", "actorId": "…", "fromStatus": "submitted", "toStatus": "approved", "reason": "Covers the December demand spike", "details": { "number": "PO-000001", "lineCount": 2, "totalCents": 39400 }, "occurredAt": "…" }
  ]
}
```

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
| 403 | `forbidden`, `self_decision_not_allowed` |
| 404 | `not_found` |
| 409 | `duplicate_code`, `idempotency_conflict`, `insufficient_stock`, `import_already_applied`, `purchase_order_not_editable`, `invalid_status_transition` |
| 422 | `validation_failed` (with `details`), `nothing_to_apply` |
| 500 | `internal_error` |

Each request gets a correlation id: the caller's `X-Request-Id` if it is 8–128
characters of letters, digits, `.`, `_` or `-`, otherwise a new UUID. It is
returned in the `X-Request-Id` header and in `error.requestId`. Unexpected
errors are logged with that id; their details are never sent to the client.
`GET /v1/health` keeps its own report body for both `200` and `503`.

## Tests

`pnpm --filter @supplypilot/api test` runs the unit and HTTP specs. They use
fake repositories and need no database.

Specs named `*.db.spec.ts` run the repositories against a real PostgreSQL and
are skipped unless `TEST_DATABASE_URL` is set. Each run applies the migrations
to a new throwaway schema and drops it at the end, so the local development
database is fine:

```bash
pnpm services:up
TEST_DATABASE_URL=postgres://supplypilot:supplypilot_local@localhost:5432/supplypilot \
  pnpm --filter @supplypilot/api test:db
```

`inventory-ledger.db.spec.ts` covers retried and concurrent requests with the
same `Idempotency-Key` (one event, the rest replayed), key conflicts and
per-organization keys, the negative-stock rule for issues, adjustments and
corrections, concurrent issues racing for the same stock, and the
append-only ledger with an empty `stock_balance_drift` view.

`purchase-order-approvals.db.spec.ts` covers the approval flow end to end,
the reopen/resubmit cycle, two managers deciding at once, the status-transition
trigger, the four-eyes constraint and the append-only audit trail.

`test:db` runs the specs one at a time (`--runInBand`), since each migrates
its own schema from scratch.

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
