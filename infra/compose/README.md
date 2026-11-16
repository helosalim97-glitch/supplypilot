# Local services

PostgreSQL 16 and Redis 7 for local development. Ports are bound to `127.0.0.1` only.

```bash
cp .env.example .env
pnpm services:up     # starts both and waits until they report healthy
pnpm services:down   # stops them; data stays in named volumes
```

To reset all local data: `docker compose -f infra/compose/docker-compose.yml down -v`.
