# PawLink

**A production-minded pet-care marketplace prototype** — customers book vets, groomers, and boarding
providers; providers manage their own availability and treat pets; admins operate the platform. Built
end to end as a portfolio project: real database concurrency guarantees, a real (mocked) payment
state machine, an audited medical-records system, and an authorization model that assumes the
frontend is never trusted, backed by 496 backend tests and 27 real-browser Playwright workflows.

> A pet ID, a provider ID, a booking ID — none of them are authorization credentials in this codebase.
> Every read and write re-derives who's allowed to do what from the authenticated session and real
> database state, never from an id the client happened to supply.

## Architecture

```
Customer / Provider / Admin (browser)
              │
              ▼
        React (Vite SPA)
              │
      TanStack Router  ── client-side route guards (UX only)
              │
      TanStack Query   ── server-state cache, cleared on every auth transition
              │
             Ky         ── the one HTTP client; nothing calls fetch() directly
              │
              ▼  HTTPS, CORS-restricted to one trusted origin
        ┌─────────────────────────────────────────────┐
        │                Hono API                      │
        │  requestId → structured logging → security   │
        │  headers → CORS → rate limiting → routes       │
        │              │                                 │
        │        requireAuth / requireAdmin              │
        │        (session cookie → users.role)            │
        │              │                                 │
        │            Zod validation                       │
        └───────────────┬───────────────┬─────────────┘
                         │               │
                         ▼               ▼
                     Drizzle ORM      ioredis
                (parameterized only)  (rate limiting)
                         │
                         ▼
                    PostgreSQL
```

**Domain boundaries**: Bookings (concurrency-safe, idempotent) → Payments (a real state machine, no
real money) → Medical Records (booking-derived provider authorization, its own audit trail) →
Reviews (completed-booking eligibility, database-enforced uniqueness) → Admin (role-gated
operational visibility, explicitly *not* a medical-record bypass) → Audit (one append-only table
every sensitive action across every domain writes to).

## Core engineering problems solved

This isn't a CRUD-app portfolio piece — the interesting parts are the invariants that had to hold
under concurrency, under adversarial input, and under "what happens when the client lies":

- **Booking concurrency.** Two customers racing for the same provider/slot must never both win. A
  Postgres `EXCLUDE` constraint over `(provider_id, tstzrange(start_at, end_at))` makes double-booking
  impossible *at the database level*, not just in application code — proven with real concurrent
  requests (2-way, 10-way, and via actual parallel `curl` processes against a live server, not just
  in-process promises).
- **Idempotency.** A retried "Confirm booking" or "Pay now" click must never create a second booking
  or a second charge. Persisted `(customer_user_id, key)` claim tables — not an in-memory cache that
  forgets on restart — with request-hash comparison so reusing a key for a genuinely different
  request is a `409`, never a silent overwrite.
- **Availability calculation.** Recurring weekly hours (with split schedules), date-specific
  exceptions, IANA timezones, and DST — computed as a pure function with zero database or wall-clock
  dependency in the hot path, tested against exact boundary cases (a slot exactly at closing, a
  timezone offset far from UTC, a DST transition).
- **Payment state.** A single authoritative transition table decides what's legal; the amount and
  currency are always derived from the booking server-side, never trusted from the client. Webhook
  signature verification happens strictly before the body is even parsed, so a malformed payload
  can't be used to skip authentication — and `(provider, event_id)` uniqueness makes a duplicated or
  replayed webhook delivery a safe no-op.
- **Medical privacy.** A provider may read or write a pet's medical records only when a real,
  `CONFIRMED`/`COMPLETED` booking establishes a treating relationship — derived from the database on
  every request, never accepted as a client-supplied claim. Records are never hard-deleted; every
  create/view/update/archive writes to an append-only audit log that never duplicates the actual
  clinical content.
- **Review integrity.** A review can only be created from a booking that's actually reached
  `COMPLETED`, and a database `UNIQUE(booking_id)` constraint — not a check-then-insert race — is
  what actually prevents two reviews for the same booking under real concurrent submission.
- **Admin authorization.** Every `/api/admin/*` route independently enforces the `ADMIN` role
  server-side; the frontend route guard is UX only. Admin gets full operational visibility across
  bookings/payments/reviews/providers/users, but **explicitly no medical-record access** — that
  boundary is tested directly, not just asserted in a comment.
- **Audit logging.** One shared, append-only table every sensitive action across every domain writes
  to (medical-record access, provider suspension, review moderation) — there is no `PATCH`/`DELETE`
  route for an audit entry anywhere in this codebase, for any actor, including an admin.

## Security

- **Server-side authorization, always.** Ownership is derived from the authenticated session on
  every mutation — a client-supplied `ownerId`/`providerId`/`customerUserId` is structurally absent
  from every write schema, not just ignored by convention.
- **Database constraints as the final authority**, not just application checks: an `EXCLUDE`
  constraint prevents double-booking, `UNIQUE` constraints prevent duplicate reviews/idempotency
  claims/webhook events, `CHECK` constraints enforce rating ranges and price non-negativity, and
  every foreign key is deliberately `RESTRICT` (never a silent `CASCADE`) wherever a row represents
  historical business/medical record that must never be silently orphaned.
- **IDOR resistance as a house style**: a resource that exists but isn't the caller's returns the
  same `404` a nonexistent one would — never a `403` that would confirm "this id is real, just not
  yours," which is itself an information leak an attacker can use to enumerate other users' data.
- **Mass-assignment protection**: every mutation reads only `parsed.data` from an explicit Zod
  schema — never a raw request body spread into a database update — so a server-owned field
  (`role`, `price`, `paymentStatus`, `createdAt`, an author id) is structurally unwritable by a
  client, not just filtered by a runtime check that could be forgotten on the next endpoint.
- **Input validation** on every mutation and every filter/search/pagination parameter via Zod,
  parsed before any query runs; every dynamic filter uses Drizzle's parameterized query builder —
  a SQL-injection-shaped search string is a completely inert literal value, proven directly with an
  adversarial test.
- **Medical isolation**: no admin endpoint, anywhere, returns clinical content — verified with a
  dedicated test that creates a medical record with deliberately distinctive content and asserts it
  never appears in any admin-surfaced response, including the audit log's own metadata.
  Rate limiting fails open (a Redis outage never blocks real traffic) and is disabled — not an
  error — when no `REDIS_URL` is configured.

## Testing

```
496 backend tests (Vitest)  ·  27 Playwright end-to-end workflows  ·  0 known SQL/mass-assignment/IDOR gaps
```

- **Unit** — pure functions with zero I/O (availability calculation, timezone conversion, booking/
  payment state transitions) tested against exact boundary cases, deterministic and unaffected by
  wall-clock time.
- **API/integration** — every resource's full CRUD + authorization matrix, driven against a real
  Postgres database, never mocked.
- **Security** — a dedicated `*-security.test.ts`/`*-security.spec.ts` per sensitive resource:
  cross-customer, cross-provider, forged-role, forged-actor-id, cross-booking, and enumeration
  attempts, all asserted to fail the same way a nonexistent resource would.
- **Concurrency** — the mandatory double-booking race (2-way, 10-way, and real parallel processes),
  idempotency-key races, cancellation races, and concurrent duplicate-review submission — each one
  independently re-queries the database afterward rather than trusting the HTTP responses alone.
- **Playwright** — full real-browser workflows for customer, provider, and admin, each with a
  matching security spec that drives the API directly (`page.request.get(...)`) with another user's
  session to prove the server rejects it, not just that the UI doesn't offer the option.

Full breakdown of what each test file covers: [docs/testing.md](docs/testing.md).

## Production hardening

Added as its own milestone, not bolted on as an afterthought:

- **Typed, fail-loud environment configuration** — a production process that's missing a required
  secret, or is still carrying a checked-in development default for one, refuses to start.
- **Structured JSON request logging** with a correlation id on every request and every error,
  threaded through the response header (`X-Request-ID`) — never a request body, password, session
  cookie, or medical-record content logged, anywhere.
- **`GET /health`** (liveness, never touches a dependency) and **`GET /ready`** (a real, cheap
  Postgres reachability check) — both carry a safe, non-secret build identifier.
- **Redis-backed rate limiting** on login, registration, booking/payment creation, the payment
  webhook, and admin/public search — fails open on a Redis outage, disabled (not broken) when Redis
  isn't configured.
- **Security headers and CORS** — a strict `Content-Security-Policy`, `X-Frame-Options`,
  `X-Content-Type-Options`, restricted-origin CORS with credentials (never a wildcard).
- **A real, tested Docker production image** — a three-stage build, a non-root runtime user, no
  secrets baked in, a `HEALTHCHECK`, correct `SIGTERM` handling — built and actually run end to end
  against real Postgres/Redis containers as part of this milestone (which is how a real cwd-relative
  migration-path bug got caught and fixed).
- **CI** (GitHub Actions) running typecheck, lint, the full backend test suite against a real
  Postgres service container, the full Playwright suite, and a production build on every push.
- **A dependency audit** that investigated each finding's actual reachability rather than blindly
  force-upgrading — see [docs/architecture.md](docs/architecture.md), "Dependency audit," for the
  specific reasoning.
- **A real bug found and fixed**: `TanStack Query`'s cache wasn't fully cleared on logout, which
  could let a second user on a shared device briefly see a first user's cached data — fixed by
  clearing the entire cache on every auth transition, not an allowlist of "sensitive" keys.

Full detail: [docs/architecture.md](docs/architecture.md), "Production hardening, observability &
security."

## Deployment

```
build → typecheck/lint/test → commit → push → merge → deploy → smoke test
```

Two independently-deployable pieces:

- **Backend** (API + Postgres + Redis) — `docker-compose.prod.yml`, a real multi-stage Docker build,
  `NODE_ENV=production` so every hardening decision actually takes effect.
- **Frontend** — a static Vite build deployed to Vercel (`apps/web/vercel.json`), talking to the
  backend via `VITE_API_URL`.

Full deployment instructions: [docs/architecture.md](docs/architecture.md), "Deployment."

## Stack

- TypeScript / Node.js
- [Hono](https://hono.dev) (API)
- PostgreSQL + [Drizzle ORM](https://orm.drizzle.team)
- Redis ([ioredis](https://github.com/redis/ioredis)) — rate limiting only
- Zod
- React + Vite (web)
- [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query)
- [Ky](https://github.com/sindresorhus/ky) (HTTP client)
- Vitest (unit/integration tests) + Playwright (E2E)
- Docker / Docker Compose (backend), Vercel (frontend)
- GitHub Actions (CI)

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
  api/      Hono API service (health check, auth, pets, providers, services, availability, bookings, payments, medical records, reviews, admin)
  web/      React/Vite frontend (TanStack Router/Query, Ky, shadcn/Tailwind UI)
packages/
  shared/   Shared types & Zod schemas (health, auth, pets, providers, services, availability, bookings, payments, medical records, audit, reviews, admin)
e2e/        Playwright end-to-end tests
docs/       Project documentation
.github/    CI workflow
```

See [docs/getting-started.md](docs/getting-started.md) for setup and environment variables,
[docs/architecture.md](docs/architecture.md) for how each milestone (including production hardening,
security, and deployment) actually works, and [docs/testing.md](docs/testing.md) for how to run and
what each layer of the test suite covers.

## API surface

| Resource       | Endpoints                                                                                   | Auth |
| -------------- | --------------------------------------------------------------------------------------------- | ---- |
| Health         | `GET /health`, `GET /ready`                                                                    | public |
| Auth           | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | mixed |
| Pets           | `GET/POST /api/pets`, `GET/PATCH/DELETE /api/pets/:id`                                        | owner |
| Providers      | `GET /api/providers`, `GET /api/providers/:id`, `POST/PATCH/DELETE /api/providers[/:id]`       | GET public, writes owner/admin |
| Services       | `GET/POST /api/providers/:providerId/services`, `GET/PATCH/DELETE .../services/:serviceId`     | GET public, writes owner/admin |
| Availability   | `GET /api/providers/:providerId/availability?date&serviceId`                                   | public |
|                | `GET/POST /api/providers/:providerId/availability/rules[/:ruleId]` (+ `PATCH`/`DELETE`)         | owner/admin |
|                | `GET/POST /api/providers/:providerId/availability/exceptions[/:exceptionId]` (+ `PATCH`/`DELETE`) | owner/admin |
| Bookings       | `POST/GET /api/bookings`, `GET /api/bookings/:id`, `POST /api/bookings/:id/{cancel,complete}`   | authenticated |
| Payments       | `POST/GET /api/bookings/:bookingId/payment`, `GET /api/payments/:id`, `POST /api/payments/webhook` | authenticated (webhook: signature-verified, not session) |
| Medical records | `GET/POST /api/pets/:petId/medical-records`, `GET/PATCH /api/medical-records/:id`, `POST /api/medical-records/:id/archive` | pet owner (read) / treating provider (read+write) — see below |
| Reviews         | `GET/POST /api/bookings/:bookingId/review`, `PATCH /api/reviews/:id`, `GET /api/providers/:providerId/reviews` | booking's own customer (write) / public (provider list) — see below |
| Admin           | `GET /api/admin/{dashboard,providers,users,bookings,payments,reviews,audit}`, `POST /api/admin/providers/:id/status`, `POST /api/admin/reviews/:id/{hide,publish}` | `ADMIN` role only — see below |

Every mutating endpoint derives ownership from the authenticated session, never from a
client-supplied id. Full request/response shapes and the authorization model are documented in
[docs/architecture.md](docs/architecture.md).

## Status

- **Foundation**: health/readiness endpoints, database connectivity, CORS, structured request
  logging, request ids, security headers, rate limiting, CI.
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
  timezone, the service's duration, and provider/service active status.
- **Booking engine**: `POST /api/bookings` turns one specific advisory availability slot into an
  actual reservation — re-validating everything the availability endpoint checks server-side, deriving
  the customer from the session and the price/duration/service-name from the service *as it exists at
  booking time* (captured as an immutable snapshot). A Postgres `EXCLUDE` constraint makes
  double-booking impossible at the database level. Duplicate submissions are protected by a
  persistent `Idempotency-Key` mechanism. A booking starts `PENDING`, becomes `CONFIRMED` once
  payment succeeds, `COMPLETED` once the provider marks the appointment done, and is never
  hard-deleted.
- **Payments**: `POST /api/bookings/:bookingId/payment` charges a `PENDING` booking through a
  provider-agnostic `PaymentProvider` abstraction — a deterministic **mock provider** today, swappable
  for a real one later without changing the domain logic. `POST /api/payments/webhook` processes
  signed provider events with full webhook idempotency and correct out-of-order-event handling. No
  real payment gateway, credentials, or money transfer exists anywhere in this codebase.
- **Medical records**: providers with a legitimate, confirmed treating relationship to a pet can
  record visits, diagnoses, vaccinations, medications, allergies, lab results, and surgeries; the
  pet's owner can always read their own pet's full history. Records are never hard-deleted; every
  access is recorded in an append-only audit log that never duplicates medical content.
- **Reviews & ratings**: a customer may review a provider only through their own `COMPLETED`
  booking. A database `UNIQUE(booking_id)` constraint enforces one review per booking. Provider
  profiles show a live aggregate rating and review count computed fresh from the `reviews` table.
- **Admin & operations**: an `ADMIN` account (provisioned only through a controlled database
  mechanism, never through any API) gets operational visibility across every customer, provider,
  booking, payment, and review, plus two audited mutations (provider status, review moderation) —
  with **no admin bypass for medical records anywhere**.
- **Production hardening**: typed/fail-loud environment config, structured logging, request ids,
  health/readiness endpoints, Redis-backed rate limiting, security headers, a real multi-stage
  Docker production image, GitHub Actions CI, and a documented dependency audit.

Other product features (refunds, payouts, subscriptions, wallets, notifications, AI) are not
implemented and are explicitly out of scope for this project.

## Testing

```bash
npm run typecheck   # TypeScript checks across all workspaces
npm run lint         # ESLint across all workspaces
npm run test          # backend unit/integration tests (Vitest)
npm run test:e2e      # end-to-end tests (Playwright)
npm run build          # production build of all workspaces
```

Postgres must be running and migrated first (`npm run db:up && npm run db:migrate`). Every
resource has a matching `*-security.spec.ts` Playwright spec that proves authorization directly
against the API, not just through the UI. See [docs/testing.md](docs/testing.md) for what each
test layer covers.
