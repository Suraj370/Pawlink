# PawLink

A multi-sided pet-care platform connecting pet parents, vets, groomers, boarding providers, and
platform administrators. This repository currently implements the project foundation and
authentication only — no other business features are implemented yet.

## Stack

- TypeScript / Node.js
- [Hono](https://hono.dev) (API)
- PostgreSQL + [Drizzle ORM](https://orm.drizzle.team)
- Zod
- React + Vite (web)
- [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query)
- [Ky](https://github.com/sindresorhus/ky) (HTTP client)
- Vitest (unit/integration tests) + Playwright (E2E)
- Docker Compose (local Postgres)

## Structure

```text
apps/
  api/      Hono API service (health check, auth)
  web/      React/Vite frontend (TanStack Router/Query, Ky, shadcn/Tailwind UI)
packages/
  shared/   Shared types & Zod schemas (health, auth) used by both apps
e2e/        Playwright end-to-end tests
docs/       Project documentation
```

See [docs/getting-started.md](docs/getting-started.md) for setup, environment variables, and the
authentication/TanStack Router/Query/Ky architecture.

## Status

- Foundation: health check endpoint, database connectivity, CORS, request logging, CI-ready test
  scaffolding.
- Authentication: registration, login, logout, `GET /api/auth/me`, cookie-based sessions, role
  support (`PET_PARENT`, `VET`, `GROOMER`, `BOARDING_PROVIDER`, `ADMIN`), password hashing
  (bcrypt), route protection on both the API and the frontend.

Other product features (pets, providers, bookings, payments, medical records, notifications, AI)
are not implemented yet and are separate milestones.
