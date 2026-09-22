# PawGrid

A multi-sided pet-care platform. This repository currently contains the project foundation only — no business features are implemented yet.

## Stack

- TypeScript / Node.js
- [Hono](https://hono.dev) (API)
- PostgreSQL + [Drizzle ORM](https://orm.drizzle.team)
- Zod
- React + Vite (web)
- Vitest (unit tests) + Playwright (E2E)
- Docker Compose (local Postgres)

## Structure

```text
apps/
  api/      Hono API service
  web/      React/Vite frontend
packages/
  shared/   Shared types & schemas (Zod)
e2e/        Playwright end-to-end tests
docs/       Project documentation
```

See [docs/getting-started.md](docs/getting-started.md) for setup instructions.

## Status

Foundation only: health check endpoint, database connectivity, and CI-ready test scaffolding. Business features have not been implemented yet.
