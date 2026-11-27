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

`/v1` routes need `Authorization: Bearer <WORKER_SERVICE_TOKEN>`: 401 for a
missing or wrong token, 503 if the worker has no token or database configured.
Unknown organizations and suppliers of another organization are 404. Errors
use the API's envelope, `{"error": {"code", "message", "details"?, "requestId"}}`,
and the `X-Request-Id` header is honoured and echoed.

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
