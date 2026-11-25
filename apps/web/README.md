# SupplyPilot web

Next.js (App Router) front end. Pages render on the server and call the API
(`apps/api`) with the signed-in user's bearer token; the token sits in an
httpOnly cookie and is never handed to browser JavaScript.

## Screens

| Path | What it does |
|---|---|
| `/sign-in` | Paste an API token; it is checked with `GET /v1/me/organizations` before it is stored |
| `/orgs` | Organizations you belong to, with your role |
| `/orgs/:orgId/purchase-orders` | Purchase orders, newest first, filtered by status, 25 per page |
| `/orgs/:orgId/purchase-orders/:id` | Lines, status actions, receiving, deliveries and the audit trail |

On the order page the buttons follow the same role/status rules as the API
(`src/lib/purchase-orders.ts` mirrors `purchasing.state-machine.ts`): buyers
submit, cancel drafts and reopen rejected orders; managers approve, reject and
cancel approved orders. Reject and cancel need a reason. The API still checks
everything — for example an order cannot be approved by the person who
submitted it — and its error message is shown next to the button.

**Receiving** is shown to buyers and above on approved or partially received
orders. Enter the units that arrived per line (blank = nothing for that line)
plus an optional delivery note. Each form render carries its own
`Idempotency-Key`, so a double submit books the delivery once.

Organizations you are not a member of, and unknown orders, show a 404 page.
An expired or revoked token sends you back to sign-in.

## Run locally

```bash
pnpm install
pnpm --filter @supplypilot/api dev          # API on :3001
SUPPLYPILOT_API_URL=http://localhost:3001 pnpm --filter @supplypilot/web dev   # web on :3000
```

| Variable | Default | |
|---|---|---|
| `SUPPLYPILOT_API_URL` | `http://localhost:3001` | Base URL of the API, used from the server only |

## Checks

```bash
pnpm --filter @supplypilot/web typecheck
pnpm --filter @supplypilot/web test    # Vitest: role/status rules, receiving form, list params
pnpm --filter @supplypilot/web build
```
