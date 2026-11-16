# Week 01 progress — Monorepo and synthetic supply chain fixtures

| Day | Task | Status | Evidence |
|---|---|---|---|
| D01 | Acceptance cases and ADR | Done | [ADR 0001](../adr/0001-monorepo-and-synthetic-fixtures.md), [acceptance cases](../acceptance/week-01-monorepo-and-fixtures.md) |
| D02 | Core data schema and migration | Not started | Repo skeleton, Compose stack and fixture generator done first (see notes) |
| D03 | API endpoint and validation | Not started | |
| D04 | UI workflow with error states | Not started | |
| D05 | Unit and integration tests | Not started | |
| D06 | Observability and security checks | Not started | |
| D07 | Demo, regressions and next risks | Not started | |

## Notes

- Repository conventions added: `.editorconfig` and `.gitignore`.
- pnpm workspace skeleton and Compose stack (PostgreSQL 16, Redis 7) added in
  `infra/compose/`. Not yet started on a machine with Docker; the Compose file
  has only been reviewed, not run.
- Fixture generator added in `packages/fixtures` (Python, standard library).
  Its 11 acceptance tests (AC-01.5 to AC-01.13) pass, and the same checks pass
  for seeds 0–199.
- AC-01.1 to AC-01.4 (install, uniform checks, healthy services, secret scan)
  are still open: they need Node, Docker and CI.
