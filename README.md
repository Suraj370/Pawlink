# PawLink

A multi-sided pet-care platform connecting pet parents, vets, groomers, boarding providers, and
platform administrators. This repository currently implements the project foundation,
authentication, pet management, provider management, service management, availability management,
the booking engine, a payment abstraction with a deterministic mock provider, and a secure, audited
medical-records system — no other business features are implemented yet.

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

## Quickstart

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
npm run db:up
npm run db:migrate
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173
```

Full setup details, environment variables, and prerequisites live in
[docs/getting-started.md](docs/getting-started.md).

## Structure

```text
apps/
  api/      Hono API service (health check, auth, pets, providers, services, availability, bookings, payments, medical records)
  web/      React/Vite frontend (TanStack Router/Query, Ky, shadcn/Tailwind UI)
packages/
  shared/   Shared types & Zod schemas (health, auth, pets, providers, services, availability, bookings, payments, medical records, audit)
e2e/        Playwright end-to-end tests
docs/       Project documentation
```

See [docs/getting-started.md](docs/getting-started.md) for setup and environment variables,
[docs/architecture.md](docs/architecture.md) for how each milestone (especially availability's
timezone/scheduling model) actually works, and [docs/testing.md](docs/testing.md) for how to run
and what each layer of the test suite covers.

## API surface

| Resource       | Endpoints                                                                                   | Auth |
| -------------- | --------------------------------------------------------------------------------------------- | ---- |
| Health         | `GET /health`                                                                                   | public |
| Auth           | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | mixed |
| Pets           | `GET/POST /api/pets`, `GET/PATCH/DELETE /api/pets/:id`                                        | owner |
| Providers      | `GET /api/providers`, `GET /api/providers/:id`, `POST/PATCH/DELETE /api/providers[/:id]`       | GET public, writes owner/admin |
| Services       | `GET/POST /api/providers/:providerId/services`, `GET/PATCH/DELETE .../services/:serviceId`     | GET public, writes owner/admin |
| Availability   | `GET /api/providers/:providerId/availability?date&serviceId`                                   | public |
|                | `GET/POST /api/providers/:providerId/availability/rules[/:ruleId]` (+ `PATCH`/`DELETE`)         | owner/admin |
|                | `GET/POST /api/providers/:providerId/availability/exceptions[/:exceptionId]` (+ `PATCH`/`DELETE`) | owner/admin |
| Bookings       | `POST/GET /api/bookings`, `GET /api/bookings/:id`, `POST /api/bookings/:id/cancel`               | authenticated |
| Payments       | `POST/GET /api/bookings/:bookingId/payment`, `GET /api/payments/:id`, `POST /api/payments/webhook` | authenticated (webhook: signature-verified, not session) |
| Medical records | `GET/POST /api/pets/:petId/medical-records`, `GET/PATCH /api/medical-records/:id`, `POST /api/medical-records/:id/archive` | pet owner (read) / treating provider (read+write) — see below |

Every mutating endpoint derives ownership from the authenticated session, never from a
client-supplied id. Full request/response shapes and the authorization model are documented in
[docs/architecture.md](docs/architecture.md).

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
- **Booking engine**: `POST /api/bookings` turns one specific advisory availability slot into an
  actual reservation — re-validating everything the availability endpoint checks server-side (never
  trusting the client's own availability lookup), deriving the customer from the session and the
  price/duration/service-name from the service *as it exists at booking time* (captured as an
  immutable snapshot). Two customers can never successfully reserve the same overlapping
  appointment: a Postgres `EXCLUDE` constraint makes that impossible at the database level, not just
  in application code, verified under real concurrent requests. Duplicate submissions are protected
  by a persistent `Idempotency-Key` mechanism. A booking starts `PENDING` and is never hard-deleted —
  it becomes `CONFIRMED` only once payment succeeds (see Payments, below), and cancellation is a
  status transition, governed by an explicit state machine. See
  [docs/architecture.md](docs/architecture.md) for the full design.
- **Payments**: `POST /api/bookings/:bookingId/payment` charges a `PENDING` booking through a
  provider-agnostic `PaymentProvider` abstraction (`apps/api/src/lib/payment-provider.ts`) — a
  deterministic **mock provider** today, swappable for a real one (Stripe/Razorpay/etc.) later
  without changing the booking/payment domain logic. The amount is always derived server-side from
  the booking, never the client. A booking becomes `CONFIRMED` only once its payment succeeds
  (`PENDING -> FAILED` cancels it instead) — the browser never sets a booking to `CONFIRMED` directly.
  `POST /api/payments/webhook` processes signed provider events with full webhook idempotency
  (`(provider, event_id)` uniqueness) and correct out-of-order-event handling, all through the same
  authoritative payment/booking state-transition tables. No real payment gateway, credentials, or
  money transfer exists anywhere in this codebase — see [docs/architecture.md](docs/architecture.md),
  "Payments," for the full design, including the exact consistency guarantees.

- **Medical records**: providers with a legitimate, confirmed treating relationship to a pet
  (established from real booking history, never a client-supplied id) can record visits,
  diagnoses, vaccinations, medications, allergies, lab results, and surgeries
  (`POST /api/pets/:petId/medical-records`); the pet's owner can always read their own pet's full
  history (`GET /api/pets/:petId/medical-records`). A pet ID alone is never an authorization
  credential — every read and write is independently re-verified against the caller's session and
  real database state. Records are never hard-deleted (only `ACTIVE -> ARCHIVED`); corrections go
  through `PATCH`, restricted to the exact authoring provider, and every create/view/update/archive
  and every denied attempt is recorded in an append-only audit log
  (`MEDICAL_RECORD_CREATED/VIEWED/UPDATED/ARCHIVED`, `AUTHORIZATION_DENIED`) that never duplicates
  medical content. See [docs/architecture.md](docs/architecture.md), "Medical records," for the
  full authorization model and its rationale.

Other product features (refunds, payouts, subscriptions, wallets, notifications, AI) are not
implemented yet and are separate milestones.

## Testing

```bash
npm run typecheck   # TypeScript checks across all workspaces
npm run test         # backend unit/integration tests (Vitest)
npm run test:e2e     # end-to-end tests (Playwright)
npm run build         # production build of all workspaces
```

Postgres must be running and migrated first (`npm run db:up && npm run db:migrate`). Every
resource has a matching `*-security.spec.ts` Playwright spec that proves authorization directly
against the API, not just through the UI. See [docs/testing.md](docs/testing.md) for what each
test layer covers.
