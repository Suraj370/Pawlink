# PawLink — Testing

## Running the suite

```bash
npm run typecheck      # TypeScript checks across all workspaces
npm run test            # backend unit/integration tests (Vitest) — requires Postgres running and migrated
npm run test:e2e        # end-to-end tests (Playwright) — requires Postgres running and migrated
npm run build            # production build of all workspaces
```

Postgres must be running and migrated first (`npm run db:up && npm run db:migrate` — see
[docs/getting-started.md](getting-started.md)). Playwright's config starts both the API and web dev
servers automatically but cannot start PostgreSQL itself.

`playwright.config.ts` caps `workers` at 4 rather than using Playwright's CPU-count default. Every
spec drives a real browser against one shared dev API/Postgres instance (nothing is mocked), and the
booking specs in particular run multi-step, multi-context workflows; at full default parallelism on
a typical dev machine, that single shared backend gets oversubscribed badly enough that the heavier
specs can time out from pure contention — the same spec that timed out at 90s under full parallelism
completed in ~5s run in isolation. Raise the cap if running on a beefier machine or a dedicated CI
runner.

## Test layers

### 1. Pure unit tests (`apps/api/src/lib/*.test.ts`)

Business logic that doesn't touch HTTP or the database is tested in isolation. The most extensive
example is availability:

- `apps/api/src/lib/timezone.test.ts` — the timezone utilities alone: IANA validation (including
  that abbreviations like `"IST"` are rejected despite ICU aliasing them to a real zone), the
  local-time ↔ UTC-instant conversion, and DST offset correctness either side of a known transition.
- `apps/api/src/lib/availability.test.ts` — `calculateAvailableSlots` with no database or HTTP
  involved at all: it's called directly with plain objects (weekly rules, an exception, an
  injected `now`) and asserted against exact expected slot lists. This is what makes it practical to
  test boundary conditions precisely — a slot exactly at opening, a slot whose service would finish
  exactly at closing (included) vs. one interval past closing (excluded), a zero-width window,
  multiple independent windows never bridging a closed gap, CLOSED/CUSTOM_HOURS exception
  precedence, the current-date past-slot filter (with an injected `now` so it's deterministic, not
  wall-clock-dependent), and invariant checks (every returned slot fits entirely within one window,
  no duplicates, every slot belongs to the requested calendar date even for a timezone offset far
  from UTC).

Because `now` and every schedule input are plain parameters, none of these tests depend on real
wall-clock time, sleep, or network — they're fast and can't flake.

### 2. API/integration tests (`apps/api/src/*.test.ts`, one file per resource)

Each resource (`auth`, `pets`, `providers`, `services`, `availability`, `bookings`) has a test file that drives
the real Hono app (`app.request(...)`) against the real Postgres database (no mocking) — this
exercises routing, Zod validation, database constraints, and authorization together. Every resource
file follows the same shape:

- **Creation**: valid input succeeds; each validation rule is tested individually (e.g. for
  availability: end ≤ start, invalid day, invalid time format, malformed provider id).
- **Reading**: public visibility rules (what an anonymous caller sees vs. an authenticated
  owner/admin).
- **Update/delete**: owner can, a different user cannot (see Authorization below).
- **Cross-resource IDOR**: a child resource (a service under a provider, a rule under a provider)
  reached through the *wrong* parent's URL resolves to nothing, even though the child id itself is
  real — see `services.test.ts`'s `cross-provider IDOR` block and `availability.test.ts`'s
  `prevents accessing a rule through a different provider's URL`.

`apps/api/src/test-helpers.ts` provides `registerAndLogin()` (returns a ready-to-use session
cookie) and `promoteToAdmin()` (direct database write — there is no API path to become an admin, by
design, so tests that need an admin actor use this instead of pretending one exists through the
API).

### 3. Authorization/security tests

These are not a separate file — they're woven into every resource's test file and are the
tests most worth reading in isolation: `unauthenticated -> 401`, `different owner -> 404` (never
`403` — see [docs/architecture.md](architecture.md) for why), client-supplied ownership fields
(`ownerId`, `providerId` in a request body) are ignored rather than honored, and — for
availability specifically — that a rule/exception id from Provider A is unreachable through
Provider B's URL even by Provider A's own owner using the wrong URL.

### 4. Playwright E2E (`e2e/*.spec.ts`)

Real browser tests against the real running app (API + web + Postgres), one pair of files per
resource: a customer/owner workflow spec and a `*-security.spec.ts` spec. The security specs are
**mandatory** and deliberately go further than the UI: `pets-security`, `providers-security`,
`services-security`, and `availability-security` each have User A create something, then have User
B — logged in as themselves in a separate browser context — first confirm the UI offers no owner
controls, and *then* attack the API directly (`page.request.patch/delete/post(...)`) with their own
valid session cookie, asserting the same `404`/`400` the API tests already proved. A passing UI
test alone never demonstrates the API rejects unauthorized access, since a well-behaved UI simply
never asks for another user's data — the direct API calls are what actually prove it.

`e2e/helpers.ts` provides `uniqueTestUser()` and `registerViaUI()` so every spec uses fresh,
randomly-suffixed accounts and can be re-run indefinitely without colliding with previous runs or
each other (Playwright runs specs in parallel by default).

`e2e/availability.spec.ts` covers the full owner workflow (set weekly hours, add a second
split-schedule window, create a date exception, view the generated slots and confirm they match the
configured schedule exactly, confirm a slot click doesn't create anything) and the customer
workflow (select a service and date on a public provider page with no login, see slots matching the
configured schedule), plus a dedicated case confirming an inactive provider/service exposes no
`SlotPicker` at all.

`e2e/bookings.spec.ts` covers the full customer workflow end to end (register, add a pet, pick a
service and slot on a real provider another user set up, review, confirm, see the confirmation, find
it in "My Bookings", then reload availability and confirm the exact slot — and any other slot that
would now overlap it — no longer appears) and cancellation (cancel from the booking detail page,
confirm the slot becomes bookable again). `e2e/bookings-security.spec.ts` is the mandatory
cross-user proof: User B gets "not found" in the UI and a `404` directly against
`GET/POST /api/bookings/:id`(`/cancel`) for User A's booking, and a `404` attempting to book using
User A's own pet id.

### 5. Concurrency and idempotency tests (`apps/api/src/bookings.test.ts`)

Two categories of test exist nowhere else in this codebase, because no earlier milestone had a
genuine race condition to prove correct:

- **The mandatory double-booking race test**: two `Promise.all`-concurrent `POST /api/bookings`
  requests for the exact same provider/slot from two different customers. Asserts exactly one `201`
  and one clean `409` (never two `201`s, never a raw database error surfacing), and then
  independently re-queries the database (via the provider owner's booking list) to confirm exactly
  one `CONFIRMED` booking actually exists for that appointment — the HTTP responses alone aren't
  trusted as the proof. The same scenario is also verified with real concurrent `curl` processes
  against the live dev server (not just Vitest's in-process request calls), confirming the guarantee
  holds under actual concurrent network requests, not just concurrent JavaScript promises.
- **Idempotency tests**: same key + same request replays the original booking (`200`, not a second
  `201`); same key + different request is a `409` conflict; a genuinely concurrent pair of requests
  sharing one key converge on a single booking id; a request with no key at all is never
  deduplicated. One real bug was caught and fixed by this suite during development: the availability
  re-validation originally ran *before* the idempotency check, so a legitimate sequential replay was
  incorrectly rejected as "slot no longer available" (because the original request's own booking was
  now correctly occupying that slot) — fixed by checking for an existing idempotency claim first.
- **Provider-status race test** (`concurrency — provider deactivated while a booking is being
  created`): a hardening-pass regression test that fires `POST /api/bookings` concurrently with the
  owner's `PATCH /api/providers/:id {status:"INACTIVE"}` for that same provider, via `Promise.all`.
  Asserts the outcome is always one of exactly two valid results — the booking is cleanly created
  (`201`, deactivation applies right after) or cleanly rejected (`409`) — never a `500`, a deadlock,
  or (checked independently against the database, not just the HTTP response) a `CONFIRMED` booking
  coexisting with a provider that had already committed as `INACTIVE` before the booking did. This
  exists because the booking route previously read `provider.status` once, outside any transaction,
  and never re-checked it before the `INSERT` — see docs/architecture.md, "Transaction boundaries and
  the provider/service status race," for the `SELECT ... FOR UPDATE` fix and the exact guarantee it
  establishes.
- **Cancellation race test** (`cancellation race`): fires two concurrent
  `POST /api/bookings/:id/cancel` requests for the same `CONFIRMED` booking — one from the customer,
  one from the provider owner. Asserts exactly one `200` and one `409` (never two `200`s), with the
  booking ending in `CANCELLED`. See docs/architecture.md, "Cancellation race," for why the plain
  read-then-write shape needed the same `SELECT ... FOR UPDATE` treatment as booking creation.
- **10-way concurrency stress test** (`concurrency stress`): strengthens the mandatory double-booking
  race test from 2 to 10 concurrent `POST /api/bookings` requests, from 10 different customers, for
  the exact same provider/service/slot. Asserts exactly one `201` and nine `409`s, and independently
  re-queries the database for exactly one `CONFIRMED` booking — proving the `EXCLUDE` constraint (and
  the availability re-check) holds under a wider field, not just a two-way race.
- **Idempotency hardening tests**: two different customers using the identical key string never
  collide (keys are scoped per `(customer_user_id, key)`); a request that fails application-level
  validation (e.g. the slot is already taken) leaves no idempotency claim behind at all, so the same
  key can be legitimately reused for a new, valid request afterward — proven directly by retrying
  with the same key and a different, available slot and asserting a clean `201`, not a stale
  conflict.
- **Transaction-failure / no-partial-records test**: after a booking attempt is rejected (slot
  already taken, with an `Idempotency-Key` attached), asserts the rejected customer has zero bookings
  and that the same key is provably unclaimed — confirming the whole transaction (including the
  idempotency claim insert) rolled back atomically, never leaving a booking-less claim or a
  claim-less booking behind.

## What "passing" actually means here

Every milestone's final verification runs the *entire* existing suite, not just the new resource's
tests — each report documents the exact test count and pass/fail result actually observed from
running `npm run test` and `npx playwright test`, not an assumption that earlier milestones still
work. Regressions are caught this way: adding availability's `timezone` field to the provider form,
for example, was verified not to break the pre-existing provider-creation E2E tests before being
considered done.
