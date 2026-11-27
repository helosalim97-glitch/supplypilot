# SupplyPilot worker

Python FastAPI service for the calculations behind reorder recommendations.
It reads the API's PostgreSQL tables over read-only connections and never
writes domain state; the API stays the only writer (ADR 0001).

The worker is internal. The API calls it with a shared service token and does
the per-user permission checks itself, so the worker should only listen on a
private interface.

## Supplier lead times

A lead-time sample is one approved purchase order: the time from approval
(`decided_at`) to the **first** delivery recorded against it. Later parts of a
split delivery don't add samples. Deliveries backdated to before the approval
can't be real lead times; they are left out and reported as `excludedCount`.

Per supplier the worker reports the sample count, mean, sample standard
deviation (n − 1), min, max, p50 and p90 (linear interpolation), the
coefficient of variation, the on-time rate against `expected_on` (compared in
UTC, orders without an expected date don't count) and a reliability label:

| Label | Rule |
|---|---|
| `insufficient_data` | fewer than 3 samples, or no spread can be computed |
| `consistent` | CV ≤ 0.25 |
| `variable` | 0.25 < CV ≤ 0.5 |
| `erratic` | CV > 0.5 |

The window covers orders whose first delivery falls within `windowDays`
(1–1095, default 365) before `asOf` (default now). Receipts after `asOf` are
ignored, so a fixed `asOf` gives a reproducible answer.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | No token. `configured` is false without a token or database |
| GET | `/v1/organizations/{orgId}/supplier-lead-times` | Every active supplier, plus archived ones with history in the window |
| GET | `/v1/organizations/{orgId}/suppliers/{supplierId}/lead-time` | Statistics plus the 100 most recent samples |
| POST | `/v1/reorder-calculations` | Reorder-point calculator (below); needs no database |

`/v1` routes need `Authorization: Bearer <WORKER_SERVICE_TOKEN>`: 401 for a
missing or wrong token, 503 if the worker has no token configured (or, for the lead-time routes, no
database).
Unknown organizations and suppliers of another organization are 404. Errors
use the API's envelope, `{"error": {"code", "message", "details"?, "requestId"}}`,
and the `X-Request-Id` header is honoured and echoed.

## Reorder-point calculator

`POST /v1/reorder-calculations` takes explicit inputs for one SKU at one
warehouse and returns the reorder decision plus every intermediate value, so a
reviewer can redo the arithmetic. It reads nothing from the database (only the
service token is needed); the API will feed it demand history and the
supplier's lead time when it builds reorder proposals.

```
safety stock  = ceil(z * sqrt(L * sd_d² + d² * sd_L²))
reorder point = ceil(d * L) + safety stock
order-up-to   = ceil(d * (L + R)) + safety stock
```

`d` and `sd_d` are the mean and sample standard deviation of daily demand
(zero days included), `L` and `sd_L` the lead time in days, `R` the review
period and `z` the standard normal quantile for the cycle service level
(0.5–0.999, default 0.95 → z = 1.6449). Results are rounded up to whole units.

When the inventory position (`onHand + onOrder`) is at or below the reorder
point, the raw quantity is `orderUpTo − position`; it is rounded up to
`orderMultiple`, then up to `minOrderQty` (itself rounded to whole packs). With
no demand the calculator never reorders.

| Field | Default | Rules |
|---|---|---|
| `dailyDemand` | — | 1–1095 non-negative numbers, oldest first |
| `leadTime.meanDays` / `stdDevDays` | — / 0 | 0–365 |
| `leadTime.source` | `observed` | `observed` or `nominal` |
| `onHand` / `onOrder` | — / 0 | integers ≥ 0 |
| `serviceLevel` | 0.95 | 0.5–0.999 |
| `reviewPeriodDays` | 0 | 0–90 |
| `minOrderQty` / `orderMultiple` | 1 / 1 | integers ≥ 1 |

Warnings flag thin evidence: `short_demand_history` (fewer than 14 days),
`nominal_lead_time`, `no_demand`, `out_of_stock`. Invalid inputs are 422
`validation_failed` with the offending field in `details`.

## Running

```bash
cd services/worker
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'

export DATABASE_URL=postgres://supplypilot:supplypilot_local@localhost:5432/supplypilot
export WORKER_SERVICE_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
python -m supplypilot_worker          # http://127.0.0.1:8001 (WORKER_PORT)
```

## Tests

```bash
python -m pytest                      # unit and HTTP tests, no database needed
TEST_DATABASE_URL=$DATABASE_URL python -m pytest tests/test_repository_db.py
```

The database tests need the API migrations applied (`pnpm db:migrate`). They
write inside one transaction and roll it back. The fixture test checks that the
synthetic data's erratic supplier is told apart from the steady ones.
