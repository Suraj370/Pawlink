# PawLink

A multi-sided pet-care platform connecting pet parents, vets, groomers, boarding providers, and
platform administrators. This repository currently implements the project foundation,
authentication, pet management, provider management, service management, and availability
management — no other business features are implemented yet.

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
  api/      Hono API service (health check, auth, pets, providers, services, availability)
  web/      React/Vite frontend (TanStack Router/Query, Ky, shadcn/Tailwind UI)
packages/
  shared/   Shared types & Zod schemas (health, auth, pets, providers, services, availability)
e2e/        Playwright end-to-end tests
docs/       Project documentation
```

See [docs/getting-started.md](docs/getting-started.md) for setup and environment variables,
[docs/architecture.md](docs/architecture.md) for how each milestone (especially availability's
timezone/scheduling model) actually works, and [docs/testing.md](docs/testing.md) for how to run
and what each layer of the test suite covers.

## Status

- **Foundation**: health check endpoint, database connectivity, CORS, request logging, CI-ready
  test scaffolding.
- **Authentication**: registration, login, logout, `GET /api/auth/me`, cookie-based sessions, role
  support (`PET_PARENT`, `VET`, `GROOMER`, `BOARDING_PROVIDER`, `ADMIN`), password hashing
  (bcrypt), route protection on both the API and the frontend.
- **Pet management**: pet parents can create/list/view/update/delete their own pets
  (`/api/pets`), strictly scoped to the authenticated owner.
- **Provider management**: authenticated users can list a pet-care business (`/api/providers`) —
  vet, groomer, boarding provider, or pet shop. Discovery (`GET`) is public; create/edit/deactivate
  require ownership. Provider status (`ACTIVE`/`INACTIVE`/`SUSPENDED`) is owner-controlled except
  `SUSPENDED`, which is admin-only.
- **Service management**: a provider owner can list one or more bookable services
  (`/api/providers/:providerId/services`) — name, duration, price, currency. Public discovery shows
  only active services of an active provider; deactivation is a soft delete (row kept, `active` set
  to `false`) so a future booking system can still reference the exact service that was selected.
- **Availability management**: a provider owner sets recurring weekly hours (with support for
  split schedules — multiple windows per day) and date-specific exceptions (closed, or custom
  hours). `GET /api/providers/:providerId/availability?date=...&serviceId=...` calculates the
  actual bookable start times for that date and service, respecting the provider's own IANA
  timezone, the service's duration, and provider/service active status. This is a **calculation
  only** — no slot is reserved, locked, or turned into a booking; the same slot can currently be
  seen by more than one customer. See [docs/architecture.md](docs/architecture.md) for the full
  model.

Other product features (bookings, payments, medical records, notifications, AI) are not
implemented yet and are separate milestones.
