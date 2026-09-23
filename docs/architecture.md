# PawLink — Architecture

This document describes how each implemented milestone actually works. It documents implemented
behavior only — see the root [README.md](../README.md) for what's implemented vs. not yet started,
and [docs/getting-started.md](getting-started.md) for setup, environment variables, and the
authentication/TanStack Router/Query/Ky patterns shared across every feature.

## Foundation & cross-cutting patterns

Every feature (pets, providers, services, availability, bookings) follows the same shape:

- **Backend**: a Drizzle table in `apps/api/src/db/schema.ts`, a Zod schema in
  `packages/shared/src/<feature>.ts` (shared between API validation and frontend form validation —
  never duplicated), a Hono route module in `apps/api/src/routes/<feature>.ts` mounted in
  `apps/api/src/app.ts`, and a DTO mapper in `apps/api/src/lib/<feature>.ts` that turns a raw
  database row into the public response shape (never returning a raw row).
- **Frontend**: `apps/web/src/features/<feature>/{api,hooks,schemas,components}` — `api.ts` calls
  the single centralized Ky client (`lib/api/client.ts`); `hooks.ts` wraps TanStack Query; nothing
  outside `api.ts` ever constructs an HTTP request.
- **Authorization**: ownership is always derived from the authenticated session
  (`requireAuth` middleware, `apps/api/src/middleware/auth.ts`), never from a client-supplied id in
  the request body. A resource that exists but isn't accessible to the caller returns `404`, not
  `403` — this is deliberate: it keeps a non-owner from being able to distinguish "doesn't exist"
  from "exists but isn't yours," which would otherwise let them enumerate other users' resources.

## Pet management

`pets` table, owned by a user (`owner_id`, cascade on user deletion). Every endpoint requires
authentication and is scoped to the caller's own pets. `DELETE` is a real row delete — a pet has no
downstream entity referencing it in this codebase, so there's no historical-record reason to soft
delete it.

## Provider management

`providers` table, owned by a user (`owner_user_id`, cascade). `GET` (list, detail) is public;
`POST`/`PATCH`/`DELETE` require ownership (or an admin). A provider has a `status`
(`ACTIVE`/`INACTIVE`/`SUSPENDED`): an owner may freely toggle `ACTIVE`↔`INACTIVE`, but `SUSPENDED`
is admin-only, enforced in two independent layers (the owner-facing Zod schema doesn't even accept
`SUSPENDED` as a legal shape, and a runtime check additionally blocks anyone but an admin from
changing the status of an already-`SUSPENDED` provider). `DELETE` is a soft deactivation
(`status -> INACTIVE`), not a row delete, because providers are referenced by services (and will be
referenced by future bookings).

## Service management

`services` table, belonging to exactly one provider (`provider_id`, cascade). Public discovery
(`GET /api/providers/:providerId/services`) shows only `active` services of the provider; the owner
additionally sees their own inactive ones. `DELETE` is a soft deactivation (`active -> false`), for
the same historical-reference reason as providers — a future booking needs to be able to point at
the exact service a customer selected, even after the provider has since deactivated or changed it.

**Money representation**: prices are stored and transmitted as `priceMinor`, an **integer** count of
the currency's smallest unit (₹799.00 → `79900` paise) — never a float, so no floating-point
rounding can enter a persisted price. The API's field is deliberately named `priceMinor` (not
`price`) so every consumer is forced to be explicit about the unit.

## Availability management

This is the most involved milestone so far, because it's the first one where getting the date/time
model wrong would produce *silently* incorrect results (a slot offered at the wrong hour, or on the
wrong day) rather than an obvious error.

### The central design principle: availability is not booking

`calculateAvailableSlots` (`apps/api/src/lib/availability.ts`) is a **pure function** — it computes
a list of possible appointment start times from a provider's schedule, a service's duration, and
the current time. It does not reserve, lock, or persist anything. Two different customers can see
(and currently *would* see) the same slot; nothing in this milestone prevents that. The future
booking engine is responsible for turning a chosen slot into an actual reservation and for
preventing double-booking — this milestone deliberately does not simulate that with fake data.

### Timezone decision

A provider has an explicit `timezone` column: a genuine **IANA identifier** (e.g. `Asia/Kolkata`,
`America/New_York`), never a fixed abbreviation (`IST`) or UTC offset (`UTC+5:30`). Fixed
abbreviations and offsets don't observe daylight saving time changes and are frequently ambiguous
(`IST` alone could mean India, Israel, or Ireland Standard Time) — an IANA identifier is the only
representation that lets the system correctly compute what a business's hours mean on any given
date, DST included.

**Validation** (`isValidTimeZone`, `packages/shared/src/availability.ts` — shared by both API and
frontend since `Intl.DateTimeFormat` with an explicit `timeZone` is standard in both Node and
browsers) requires either the literal string `"UTC"` or an `Area/Location` shape, *and* that
`Intl.DateTimeFormat` accepts it. The shape requirement exists because ICU's own alias table is
lenient enough to silently resolve bare abbreviations like `"IST"` or `"PST"` to a real zone
(`"IST"` → `Asia/Calcutta`) — exactly the ambiguous input this field must reject, and
`Intl.DateTimeFormat` alone does not reject it.

New providers default to `timezone = "UTC"` if the owner hasn't set one explicitly yet, so every
provider row always has a valid, explicit timezone — never an implicit dependency on the server's
own timezone.

### Weekly availability model

`provider_availability` table: `(provider_id, day_of_week, start_time, end_time)`. `start_time` and
`end_time` are a Postgres **`time`** column (local wall-clock time-of-day), never a `timestamp` —
"9 AM to 5 PM on Mondays" means the same clock hours every week regardless of DST, which is what a
recurring schedule actually means to a business owner. A provider may have multiple rows for the
same day (a split schedule, e.g. `09:00–13:00` and `14:00–18:00`); there is no unique constraint on
`(provider_id, day_of_week)`. Overlapping windows on the same day **are rejected** (kept
deterministic), checked at the application layer against the other rules for that provider+day —
not as a database exclusion constraint, since that would need the `btree_gist` extension and this
table's write volume (an owner occasionally editing their own hours) doesn't justify the added
dependency. `end_time > start_time` is enforced as both a Zod rule and a Postgres `CHECK`
constraint.

### Date exceptions

`availability_exceptions` table: `(provider_id, date, type, start_time, end_time, reason)`, with a
`UNIQUE(provider_id, date)` constraint (a single date can have at most one exception — there's no
coherent meaning for "closed and custom hours on the same date"). `type` is `CLOSED` or
`CUSTOM_HOURS`. The precedence rule, enforced in `calculateAvailableSlots`:

```text
If a date has a CLOSED exception:        no slots at all, regardless of the weekly schedule.
If a date has a CUSTOM_HOURS exception:  use ONLY the exception's hours — never combined with
                                          the weekly schedule.
If no exception exists for that date:    use the weekly schedule for that date's weekday.
```

A `CLOSED` exception must have `start_time`/`end_time` both `NULL`; a `CUSTOM_HOURS` exception must
have both set with `end_time > start_time`. Enforced by both Zod and a Postgres `CHECK` constraint.

### Slot interval and service duration

The slot interval is a single named domain constant, `SLOT_INTERVAL_MINUTES = 30`
(`apps/api/src/lib/availability.ts`) — not a number scattered through the codebase. A candidate slot
is generated at every interval boundary within a window, and is only included if the **entire**
service duration fits before the window ends (`slotStart + serviceDurationMinutes <= windowEnd`).
Each window (in a split schedule) is evaluated independently — a slot can never straddle the gap
between two windows on the same day.

### Past-slot and current-time behavior

A slot is excluded if its computed start instant is before "now." This single rule handles both
cases the spec calls out separately: it excludes already-passed slots on the current date, *and*
(as a natural consequence, with no separate special case) it produces an entirely empty result for
a date that's wholly in the past. "Now" is compared in the provider's own timezone — a slot's start
instant is computed via the same IANA-aware conversion as everything else, so "is 9 AM in Kolkata
in the past" is never answered using the server's own timezone.

`calculateAvailableSlots` takes `now` as an explicit parameter (never reads `Date.now()` itself),
which is what makes it possible to write deterministic, non-flaky unit tests for past-slot
behavior.

### Date handling

`date` inputs are plain `YYYY-MM-DD` strings, validated to be a *real* calendar date (not just
digit-shaped — `2031-02-30` is rejected, `packages/shared/src/availability.ts`). The weekday for a
date is computed from the calendar date alone (`dayOfWeekForDate`, `apps/api/src/lib/timezone.ts`)
using UTC-based `Date` methods on a UTC-constructed instant, which is timezone-independent by
construction — the weekday of "2026-10-05" is Monday no matter who's asking or from where, so this
deliberately never touches the provider's timezone or the server's own timezone. The provider's
timezone only enters when converting a specific local time-of-day *within* that date to an absolute
UTC instant (`zonedTimeToUtc`), which happens per-slot so a DST transition mid-schedule is handled
correctly for every individual slot rather than assumed constant across the whole day.

### API response

```json
{
  "date": "2026-10-05",
  "timezone": "Asia/Kolkata",
  "slotIntervalMinutes": 30,
  "serviceDurationMinutes": 60,
  "slots": ["2026-10-05T09:00:00+05:30", "2026-10-05T09:30:00+05:30"]
}
```

Each slot is an ISO-8601 timestamp carrying the **provider's own UTC offset** (never a bare `Z`) —
this is what makes a slot's wall-clock meaning unambiguous to any client without the client having
to separately know or look up the provider's timezone.

### Provider/service status gating

`GET /api/providers/:providerId/availability` returns `404` (never partial/empty-but-200 data)
unless the provider's status is `ACTIVE` **and** the requested service is `active` **and** belongs
to that provider. This applies uniformly, not just to unauthenticated callers — the endpoint
answers "what could a customer book right now," which has no meaningful answer for a provider or
service that isn't currently bookable. Availability rows are never deleted when a provider becomes
inactive; provider/service status is the single higher-level visibility switch, checked at query
time.

## Booking engine

### The central boundary: availability is advisory, booking is authoritative

> Availability tells us what *could* be booked. Booking atomically decides what *actually gets
> reserved.* A successful `POST /api/bookings` is the only point at which a slot becomes reserved.

`calculateAvailableSlots` (availability's pure function) knows nothing about bookings, and stays
that way. The one place the two connect is a post-filter:
`excludeBookedSlots` (`apps/api/src/lib/booking.ts`) removes any candidate slot that overlaps an
existing `PENDING`/`CONFIRMED`/`COMPLETED` booking for that provider, applied both by the public
availability endpoint (so an already-taken slot simply isn't offered) and by booking creation
itself (so a client that skipped calling availability first still gets rejected). This is
deliberately *not* a second scheduling algorithm — it's pure interval subtraction over the same
candidate list `calculateAvailableSlots` already produced.

Booking creation never trusts the client's own prior availability lookup. `POST /api/bookings`
independently re-derives and re-checks everything: provider is `ACTIVE`, the service is `active`
and actually belongs to that provider, the pet belongs to the authenticated customer, and — reusing
`calculateAvailableSlots` again, not a duplicate implementation — that the requested `startAt`
instant is genuinely a member of the current legal slot list (which enforces slot-interval
alignment, full-duration-fits-in-window, exception precedence, and not-in-the-past all through that
one reused call).

### Historical snapshots

A booking is created for the pet-care service *as it exists at that moment* — `priceMinor`,
`currency`, `serviceNameSnapshot`, and `serviceDurationMinutesSnapshot` are copied from the service
row once, at creation time, and never recalculated. If the provider later renames the service,
changes its price or duration, or deactivates it entirely, every booking already made against it
keeps showing exactly what the customer actually booked and paid for. `endAt` is likewise computed
once at creation (`startAt + serviceDurationMinutesSnapshot`) and is never client-supplied —
`createBookingSchema` has no `endAt`, `priceMinor`, `currency`, `serviceName`, `status`, or
`customerUserId` field at all, so none of them can be set by the request body regardless of what a
client sends (verified by a test that submits all of them and asserts the server-derived values won
instead).

### Booking lifecycle

```text
PENDING   -> CONFIRMED | CANCELLED
CONFIRMED -> CANCELLED | COMPLETED
CANCELLED, COMPLETED: terminal — no transitions out.
```

Enforced by a single authoritative function, `assertBookingStatusTransition`
(`apps/api/src/lib/booking.ts`), not scattered ad hoc status checks. Every booking created through
today's API starts `PENDING` — see **Payments**, below, for the full explanation: a booking becomes
`CONFIRMED` only once its payment succeeds, never at creation time. `PENDING` already occupies the
provider's calendar (see `BLOCKING_BOOKING_STATUSES` below), so the double-booking guarantee holds
identically whether or not payment has completed yet. `COMPLETED` is a legal transition target with
no endpoint that currently produces it (no "mark completed" action or automatic post-appointment job
exists — deliberately out of scope for this milestone, see Known limitations below). Cancellation
(`POST /api/bookings/:id/cancel`) only ever changes `status`; the row is never deleted, because a
booking is a historical business record. A `PENDING` booking can be cancelled directly by the
customer (before ever paying) through this same endpoint — no special-casing needed, since
`PENDING -> CANCELLED` was already a legal transition before payments existed.

Which statuses occupy a provider's calendar (`BLOCKING_BOOKING_STATUSES`,
`packages/shared/src/bookings.ts`) is `PENDING`, `CONFIRMED`, and `COMPLETED` — `CANCELLED` never
blocks a new booking over the same time range. This single constant is the source of truth for
three independent places that all need to agree with it: `excludeBookedSlots`'s filtering, the
database `EXCLUDE` constraint's `WHERE` clause (see below), and nowhere else — there is no fourth
copy of this list anywhere in the codebase.

### Cancellation race

`POST /api/bookings/:id/cancel` has the same TOCTOU shape as booking creation, at a smaller scale: a
plain read of the booking's current `status`, an application-level check
(`assertBookingStatusTransition`), then a write. Two concurrent cancel requests for the same
booking — e.g. the customer and the provider owner both cancelling at the same moment — could both
read `CONFIRMED`, both pass the transition check, and both unconditionally overwrite the row. The
data would still end up `CANCELLED` either way (there's no worse state to reach), but the API would
incorrectly report `200` to both callers instead of one `200` and one `409`, silently masking that a
second, logically invalid transition attempt happened.

The fix mirrors booking creation: the handler locks the booking row with `SELECT ... FOR UPDATE` as
the first action inside a transaction, then re-checks the transition and performs the update, all
before `COMMIT`. The loser's `SELECT ... FOR UPDATE` blocks until the winner's transaction commits,
so it reads the true, now-`CANCELLED` status and `assertBookingStatusTransition` correctly rejects
`CANCELLED -> CANCELLED` with a `409` — deterministically, not depending on which request's
`UPDATE` statement happened to run last. Verified by a dedicated concurrency test
(`apps/api/src/bookings.test.ts`, "cancellation race") that fires both cancel requests concurrently
and asserts exactly one `200` and one `409`, with the booking ending in `CANCELLED`.

### Time-of-check/time-of-use audit

As part of this hardening pass, every `SELECT` → validate → `INSERT`/`UPDATE` pattern in the booking
engine (`apps/api/src/routes/bookings.ts`) was reviewed for staleness risk between the read and the
write, with an explicit decision recorded for each:

| Read | Risk if stale | Decision |
| --- | --- | --- |
| `provider` (status) | A deactivated/suspended provider could receive a new booking | **Row lock** — `SELECT ... FOR UPDATE` inside the booking transaction (see above) |
| `service` (active, price, duration) | A deactivated service could receive a new booking; a race could snapshot inconsistent price/duration | **Row lock** — `SELECT ... FOR UPDATE` inside the booking transaction |
| `pet` (ownership) | Negligible — no mutable status field, and `bookings.pet_id` is a `RESTRICT` foreign key | **Plain re-read inside the transaction**, no lock needed; a vanished pet surfaces as a foreign-key violation rather than bad data |
| Weekly rules / date exception | A rule change mid-request could theoretically admit a slot the owner just closed | **Advisory, intentionally** — the owner's own schedule edit racing their own customer's booking is a narrow, low-stakes window (worst case: one booking honored against a schedule edited moments later, which is no different from a booking made moments *before* the edit); re-read inside the transaction for freshness, but not lock-guarded |
| Active bookings for the provider (double-booking check) | Two concurrent bookings could both pass the in-app overlap check | **Database constraint is the real authority** — the `bookings_no_overlapping_active` `EXCLUDE` constraint (see below) makes this impossible regardless of what the application-level check sees; the in-app check exists only to produce a clean `409` instead of relying solely on the constraint's error |
| Idempotency claim | Two concurrent requests with the same key could both think they're first | **Database constraint is the real authority** — `INSERT ... ON CONFLICT DO NOTHING` against the composite primary key `(customer_user_id, key)` (see Idempotency below) |
| Booking row on cancel (`status`) | Two concurrent cancels could both apply | **Row lock** — `SELECT ... FOR UPDATE` inside the cancel transaction (see Cancellation race above) |

The same pattern exists elsewhere in the codebase (e.g. `providers.ts`'s `PATCH`/soft-delete
re-validating `status` before an unconditional `UPDATE ... WHERE id = $1`, and
`availability.ts`'s weekly-rule overlap check before an `INSERT`) but those are outside this
milestone's scope — the Booking Engine — and were not modified here; they're noted as a known gap
for a future hardening pass on provider/availability management specifically, not silently ignored.

### Preventing double-booking: a database-enforced invariant, not an application check

A naive "check for a conflict, then insert" is a textbook race: two concurrent requests can both
pass the check before either has inserted. This is solved with a Postgres **`EXCLUDE` constraint**,
not application-level locking or a pre-insert `SELECT`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlapping_active
  EXCLUDE USING gist (
    provider_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  )
  WHERE (status IN ('PENDING', 'CONFIRMED', 'COMPLETED'));
```

This makes "two active bookings for the same provider with overlapping time ranges" a state the
database itself will never contain, regardless of what application code does — including a future
regression that reintroduces a race in application logic. `btree_gist` is required because
`provider_id` (normally compared with plain btree equality) needs a GiST-compatible equality
operator class to combine with the range-overlap operator (`&&`) in one exclusion constraint;
evaluated and introduced specifically for this guarantee, not for general use. The range defaults
to half-open (`[start_at, end_at)`), so a booking ending at 10:00 never conflicts with one starting
at 10:00 — consistent with every other overlap check in the codebase (weekly-window overlap,
`excludeBookedSlots`).

Drizzle-kit 0.24.2 has no API for exclusion constraints at all (and, as with every other migration
in this repository, doesn't emit plain `CHECK` constraints either), so this SQL — along with the
`CHECK (end_at > start_at)` and `CHECK (price_minor >= 0)` constraints — was added to the generated
migration by hand. **Verified directly against Postgres**, bypassing the API entirely: an overlapping
insert is rejected with an `exclusion_violation` (`23P01`), a back-to-back insert (ending exactly
when another starts) succeeds, and an overlapping `CANCELLED` insert succeeds (cancelled bookings
never block). Also verified under real concurrent HTTP requests (two simultaneous `curl` calls for
the same slot, and the equivalent Vitest test firing two `Promise.all`-concurrent requests): exactly
one succeeds (`201`), the other gets a clean `409` — the route catches the `23P01` error code and
returns `{ "error": "This time slot was just booked by someone else" }`, never a raw database error.

### Transaction boundaries and the provider/service status race

Everything `POST /api/bookings` treats as authoritative — provider, service, pet, weekly rules,
date exceptions, and currently-active bookings for the provider — is read **inside** the single
transaction that ultimately performs the `INSERT`, not before it. Nothing computed or read prior to
`BEGIN` is reused for validation or for the values written to the `bookings` row: `BEGIN` →
authoritative reads → authoritative validation → derive booking values from those fresh rows →
insert → rely on database constraints (`EXCLUDE`, idempotency-key uniqueness) → `COMMIT`. This
matters because the naive shape — "load provider / load service / load pet / validate availability
/ *then* `BEGIN` / `INSERT` / `COMMIT`" — looks transactional but isn't: every one of those upstream
reads can go stale between being read and the transaction committing, and the transaction itself
never re-checks them.

Concretely, `provider.status` and `service.active` are mutable and can change out from under an
in-flight booking request (an owner calling `PATCH /api/providers/:id` to deactivate, concurrently
with a customer booking that same provider). To close this, the provider and service rows are locked
with **`SELECT ... FOR UPDATE`** as the first action inside the booking transaction:

```ts
const [provider] = await tx.select().from(providers).where(eq(providers.id, providerId)).for("update");
// ...
const [service] = await tx.select().from(services)
  .where(and(eq(services.id, serviceId), eq(services.providerId, providerId)))
  .for("update");
```

`FOR UPDATE` makes Postgres's ordinary row-lock queuing do the serialization: a concurrent
`UPDATE providers ... WHERE id = $1` (what `PATCH /api/providers/:id` issues) takes the same row
lock, so whichever transaction — the booking or the status change — reaches that specific row first
is the one the other blocks behind, until the first commits or rolls back. The two transactions can
never interleave in a way that lets one observe a value the other has since overwritten but not yet
committed.

**The exact guarantee this establishes**: the observable outcome of "customer books" racing against
"provider becomes inactive" is always equivalent to *some* legal serial ordering of the two — never
anything in between.

- If the booking transaction's `FOR UPDATE` reaches the provider row first, it reads `ACTIVE`,
  passes validation, and commits a `CONFIRMED` booking — equivalent to the booking having been made
  a moment before the deactivation, which is already a documented, correct scenario (see
  *Provider/service change scenarios* below: an existing booking survives a later deactivation).
  The `PATCH` blocks until that commit, then applies as normal.
- If the `PATCH`'s `UPDATE` reaches the row first and commits `INACTIVE`, the booking transaction's
  `FOR UPDATE` — which had been blocked behind that lock — proceeds only after, reads the
  now-committed `INACTIVE` status, and the request is rejected with a clean `409`
  (`"This provider is not currently accepting bookings"`). No booking is ever created.

What can never happen: a booking committed using a provider/service status that a concurrently
committing transaction had already superseded by the time of commit. There is no ordering of the two
operations under which a `CONFIRMED` booking and an already-effective `INACTIVE` status can coexist
as the result of that race. This is verified directly — not just reasoned about — by a dedicated
concurrency test (`apps/api/src/bookings.test.ts`, "provider deactivated while a booking is being
created") that fires the `POST /api/bookings` and the deactivating `PATCH` as genuinely concurrent
`Promise.all` requests and asserts the outcome is always one of the two valid results above, verified
independently against the database, never a `500`, a deadlock, or a booking that outlives an
already-committed deactivation.

**Trade-off, deliberately accepted**: locking the provider row with `FOR UPDATE` serializes *all*
concurrent booking attempts against that same provider — even two requests for non-overlapping time
slots now queue behind each other for the (very short) duration of one transaction, rather than
proceeding fully in parallel. This is the standard, correct cost of a real consistency guarantee at
realistic single-provider booking volume, and it does not extend to other providers: locking is
per-row, so requests against different providers never contend with each other.

The `pets` table is deliberately **not** given `FOR UPDATE` treatment: it has no mutable status field
that could go stale the way `provider.status`/`service.active` can, and `bookings.pet_id` is a
`RESTRICT` (never `CASCADE`) foreign key, so a pet vanishing mid-flight would surface as a foreign
key violation rather than silently producing a bad row. It's still re-read inside the transaction
(for a fresh ownership check), just without lock-strength contention that nothing here needs.
`weeklyRules`, the date exception, and currently-active bookings for the provider are likewise moved
inside the transaction (so the flow matches `BEGIN → authoritative reads → ...` literally), but don't
need `FOR UPDATE` either — double-booking correctness is still ultimately backstopped by the
`EXCLUDE` constraint regardless of any staleness in that particular read.

### Idempotency

`POST /api/bookings` accepts an optional `Idempotency-Key` header. Keys are scoped per customer
(`booking_idempotency_keys`, composite primary key `(customer_user_id, key)`) — one customer can
never collide with or observe another's key. A `request_hash` (SHA-256 of the canonicalized
`{providerId, serviceId, petId, startAt}`) distinguishes a safe replay of the *same* request from
reuse of the same key for a *materially different* one:

- **Same key, same request** (including a genuinely concurrent duplicate): the second request
  receives the *same* booking back (`200`, not a new `201`).
- **Same key, different parameters**: `409 Conflict` — the original booking is never silently
  mutated.
- **No key**: no deduplication at all; every request is independent.
- **No expiry**: a key remains valid to safely retry indefinitely. A time-bounded expiry would need
  a cleanup job, out of scope for this milestone (see Known limitations).

The mechanism is checked in **two places**, deliberately, both inside the same booking transaction
described above: first as a plain read *before* the availability re-validation (so a sequential
replay of an already-succeeded request isn't wrongly rejected by the availability check, since the
booking IT created is now correctly occupying that exact slot), and second as the actual
transactional claim, immediately before the insert. That second check is what makes truly concurrent
same-key requests correct: the claim is `INSERT ... ON CONFLICT DO NOTHING` against the composite
primary key, so a
second concurrent transaction attempting the same insert is blocked by Postgres's ordinary row lock
until the first transaction commits (with the booking id filled in) or rolls back (with the row
gone entirely) — no polling, no manual locking, just relying on standard transactional semantics.
Verified with a real `Promise.all`-concurrent test asserting both responses converge on one booking
id.

### Provider/service change scenarios (verified by test)

| Scenario | Behavior |
| --- | --- |
| Service becomes inactive after availability was shown | Booking attempt fails (`409`) |
| Provider becomes inactive after availability was shown | Booking attempt fails (`409`) |
| Service price/name/duration changes after a booking exists | Existing booking keeps its original snapshot values, unaffected |
| Service is deactivated after a booking exists | Existing booking remains valid and viewable; only *new* bookings against it are blocked |
| A pet has existing booking history | `DELETE /api/pets/:id` is rejected (`409`) rather than leaving a booking pointing at a vanished pet — `bookings.pet_id`/`provider_id`/`service_id` are `RESTRICT` foreign keys, never `CASCADE`, and the pets route now catches that FK violation and returns a clean error instead of a raw `500` |

## Payments

### The central rule: a payment success is processed by the server; the browser never directly changes a booking to CONFIRMED

> A payment success is processed by the server. The browser never directly changes a booking to
> `CONFIRMED`.

Every code path that moves a booking to `CONFIRMED` — the synchronous mock-payment-creation path and
the asynchronous webhook path — lives entirely in `apps/api/src/routes/payments.ts`, inside a
database transaction, driven by the payment outcome the **server** (or, in a real integration, the
provider's signed webhook) observed. No frontend code ever calls anything that sets a booking's
status directly; the React Query cache is only ever populated by refetching the booking from the
API after a mutation, and `PaymentPanel`/`BookingPaymentStep` (`apps/web/src/features/...`) render
whatever status comes back — including staying on a `PENDING` screen indefinitely if that's what the
server still reports.

### Payment state machine

```text
CREATED   -> PENDING | SUCCEEDED | FAILED
PENDING   -> SUCCEEDED | FAILED | CANCELLED
SUCCEEDED, FAILED, CANCELLED: terminal — no transitions out.
```

Enforced by a single authoritative function, `canTransitionPaymentStatus`/`assertPaymentStatusTransition`
(`apps/api/src/lib/payment.ts`), mirroring `assertBookingStatusTransition`'s exact design: no
self-transitions (`X -> X`) are legal. `CREATED` exists as a distinct instant from `PENDING` so a
future real provider whose `createPayment` call can itself fail partway (network error, provider
`5xx`) has somewhere to leave the record — but the mock provider always responds synchronously, so in
practice every payment reaches `PENDING`, `SUCCEEDED`, or `FAILED` within the same request that
created it; `CREATED` is never observed as a resting state through today's API. A duplicate
`payment.succeeded` webhook for an already-`SUCCEEDED` payment is rejected by this same table
(`SUCCEEDED -> SUCCEEDED` isn't a legal transition) — but that rejection is never surfaced as an
error; see **Webhook idempotency and out-of-order events**, below.

### Booking/payment relationship: one booking, many payment attempts, at most one success

```text
booking 1 ─── 0..many payment ATTEMPTS
                       (at most one may ever reach SUCCEEDED)
```

A booking is never limited to a single payment row. A `FAILED` attempt (or a `CREATED` row from a
provider call that itself failed, for a future real provider) stays in the table as a historical
record — the same "never mutate/erase history" principle as `bookings.service_name_snapshot` — so a
retried payment after a failure is a **new row**, not an overwrite of the old one. What's actually
enforced, at the database level, is narrower and more important: **at most one payment for a given
booking may ever be `SUCCEEDED`**. This is a hand-added **partial unique index**
(`payments_one_succeeded_per_booking`, `WHERE status = 'SUCCEEDED'` — see the migration; drizzle-kit
0.24.2 has no schema-builder API for partial indexes, the same category of gap as the booking
engine's `EXCLUDE` constraint) rather than a plain `UNIQUE(booking_id)`, which would have wrongly
also forbidden ever recording a second `FAILED` attempt.

In practice, this milestone's lifecycle design (payment failure immediately cancels the booking — see
below) means a booking can only ever actually reach a second payment ATTEMPT in the narrow window
where the first attempt is still `PENDING` (the mock provider's deterministic "still processing"
scenario) — and that case is handled by returning the existing in-flight attempt rather than creating
a concurrent second one (see **Duplicate payment protection**, below). The partial index is the real,
database-level backstop regardless of what the application layer's read-then-decide logic concludes.

### Amount integrity

The client can request a payment attempt, but never states what it costs. `POST
/api/bookings/:bookingId/payment` accepts only an optional `scenario` field (mock-only, see below) —
no `amountMinor`, `currency`, `bookingId`-in-body, or `customerUserId`. The amount is always derived
inside the same transaction that locks the booking:

```text
payment.amount_minor = booking.price_minor
payment.currency     = booking.currency
```

— read from the booking row `SELECT ... FOR UPDATE`-locked at the start of that transaction, exactly
the same authoritative-read pattern the booking engine itself uses (see **Transaction boundaries**,
above). A client submitting `{"amountMinor": 1}` alongside a ₹799 booking is simply ignored; the
payment is still created for `79900`. Verified directly by test (`apps/api/src/payments.test.ts`,
"derives amount/currency from the booking, ignoring any client-supplied values").

### The provider abstraction and the mock provider

```text
Booking/Payment domain
        ↓
PaymentProvider interface     (apps/api/src/lib/payment-provider.ts)
        ↓
MockPaymentProvider            (the one concrete implementation today)
```

`routes/payments.ts` calls only three methods — `createPayment`, `getPayment`, `verifyWebhook` — and
never anything mock-specific. A future real provider (Stripe/Razorpay/etc.) is a second
implementation of the same interface, swapped in at the composition root (`app.ts`); no change to the
booking/payment domain logic would be needed. **No real payment gateway, real credentials, or real
money transfer exists anywhere in this codebase** — `MockPaymentProvider` is a deterministic,
stateless, local development/test double, clearly labeled as such in its own doc comment and in the
UI (`PaymentPanel` renders a visible "Mock provider — development only" badge).

`MockPaymentProvider` is deterministic by construction, not just by convention: the provider-side
payment id it returns *encodes* the scenario it was created with
(`mock_<scenario>_<ourPaymentId>`), so `getPayment` can report a consistent status purely by decoding
the id it's given — there is no random number anywhere in the class, and no internal state that
wouldn't trivially survive a process restart (there's nothing mutable to lose). The one input this
milestone's mock accepts that a real provider never would is `scenario` (`SUCCESS` | `FAILURE` |
`PENDING`) on the payment-creation request — purely so tests and the UI's demo buttons can choose a
deterministic outcome instead of relying on randomness, and it defaults to `SUCCESS` when omitted.

### Booking confirmation rule

```text
Booking created -> PENDING
       ↓
  payment succeeds
       ↓
     CONFIRMED
```

```text
     PENDING
       ↓
  payment fails / is rejected
       ↓
    CANCELLED
```

Both transitions happen inside the exact same transactional helper, `applyBookingSideEffect`
(`routes/payments.ts`), called identically from the synchronous payment-creation path (the mock
provider resolving `SUCCESS`/`FAILURE` immediately) and the webhook path — expressed once, not
duplicated per call site. The booking row is `SELECT ... FOR UPDATE`-locked before either transition
is attempted, and the transition itself goes through `assertBookingStatusTransition` — so a booking
that was independently cancelled (e.g. the customer cancelled it directly while payment was still
`PENDING`) cannot be silently forced back to `CONFIRMED` by a late-arriving success: the transition
`CANCELLED -> CONFIRMED` isn't legal, `assertBookingStatusTransition` throws
`BookingStatusTransitionError`, and `applyBookingSideEffect` treats that as a deliberate, documented
no-op — the **payment** still genuinely records `SUCCEEDED` (a real system would trigger a refund
here; refunds are explicitly out of scope for this milestone, see Known limitations), but the booking
is not forced out of its already-resolved state. Verified directly
(`apps/api/src/payments.test.ts`, "a success webhook arriving after the booking was independently
cancelled leaves the booking cancelled").

### Duplicate payment protection

Before creating a new payment attempt, the transaction checks for an existing one on that booking: if
it's already `SUCCEEDED`, that payment is returned as-is (never a new one); if it's still `PENDING`
(the mock's "still processing" scenario), that same in-flight attempt is returned rather than
starting a second concurrent one. Combined with the payability gate (a booking must be `PENDING` to
accept a new payment at all — `CANCELLED`/`CONFIRMED`/`COMPLETED` are all rejected with `409`), this
means a customer can never end up with two `SUCCEEDED` payments for the same booking, and the
database's partial unique index (see above) is the final backstop even if the application-level check
were ever bypassed by a bug.

### Idempotency

`POST /api/bookings/:bookingId/payment` accepts the same `Idempotency-Key` header mechanism as
booking creation, backed by a `payment_idempotency_keys` table that's structurally identical to
`booking_idempotency_keys` — scoped per customer via a composite primary key
`(customer_user_id, key)`, with a `request_hash` (here, just a hash of `bookingId`, since amount and
currency can never differ for a fixed booking) distinguishing a safe replay from reuse of the same
key for a materially different request. The idempotency pre-check is deliberately positioned
**before** the payability gate — a legitimate replay of a request that already succeeded (and thus
already moved the booking to `CONFIRMED`) must still return the original payment, not be rejected by
a payability check that only makes sense for a genuinely new attempt. This is the exact same ordering
fix booking creation itself needed for its own idempotency-vs-availability check (see **Idempotency**
under Booking engine, above) — the same class of bug, caught the same way, in a different endpoint.
Persisted in Postgres, never an in-memory map, so it survives an API process restart like every other
idempotency mechanism in this codebase.

### Webhook verification

`POST /api/payments/webhook` is deliberately **not** behind session authentication — a real payment
provider is not an authenticated PawLink user and cannot present a session cookie. Authenticity is
established entirely by a signature: the mock provider computes an HMAC-SHA256 of the raw request
body using a shared secret (`MOCK_PAYMENT_WEBHOOK_SECRET`, defaulted for local dev, clearly documented
as a mock-only value and never a real payment-processor credential), sent in an `X-Mock-Signature`
header. A missing or mismatched signature is rejected with `401` before the body is even parsed as
JSON — a real provider's webhook secret would be verified exactly this way, just with a real
provider's signing scheme instead. A well-signed but structurally invalid or unparseable body is
rejected with `400` — these are two genuinely different failure modes (a security problem vs. a data
problem), and the code deliberately checks the signature strictly before ever attempting to parse the
payload, so an attacker can't use a malformed body to skip authentication. Oversized webhook bodies
(over 64&nbsp;KB) are rejected with `413` before either check runs.

### Webhook idempotency and out-of-order events

Webhook delivery is commonly repeated by real providers (at-least-once delivery), so the exact same
event must be safe to process any number of times. `payment_webhook_events` is unique on
`(provider, event_id)`; processing is `INSERT ... ON CONFLICT DO NOTHING` against that constraint —
the identical technique `booking_idempotency_keys` already relies on for concurrent same-key booking
requests, applied here to concurrent or simply repeated webhook deliveries. If the insert doesn't
claim the row, the event has already been processed: the handler returns `200` immediately with no
further action, not an error (a webhook responder returning a non-2xx just causes a well-behaved
provider to retry pointlessly). Verified with a genuinely concurrent 10-way `Promise.all` of the
identical event, asserting exactly one `applied: true` result.

Out-of-order events are **not** handled by any separate "is this out of order?" check — they go
through the exact same `canTransitionPaymentStatus` table every other transition does. A
`payment.pending` event arriving after a `payment.succeeded` one already committed simply fails
`SUCCEEDED -> PENDING` (not a legal transition) and is treated as a safe no-op, identically to how a
duplicate event with a *different* event id (so it isn't caught by the event-id uniqueness check) but
the *same* already-applied status would also fail `SUCCEEDED -> SUCCEEDED` (no self-transitions). One
transition table is the single place "can this event apply right now?" is decided — there is no
scattered, ad hoc ordering logic anywhere in this codebase.

### Payment failure behavior

A `FAILED` payment (or a `payment.failed` webhook) transitions its booking `PENDING -> CANCELLED` in
the same transaction — a customer cannot retry paying for that exact booking afterward (it's no
longer `PENDING`, so the payability gate rejects a new attempt with `409`); they would need to create
a new booking. The frontend surfaces this plainly: `PaymentPanel` shows "Payment failed" with the
provider's failure message and explicitly states the booking was not confirmed, never a success
screen. No refund flow exists or is implied — see Known limitations.

### Authorization

Only the booking's own customer may initiate or view a payment for it — the same IDOR-hiding
convention as everywhere else (a booking that exists but belongs to someone else, or doesn't exist at
all, both return the same `404`, never `403`). Provider owners initiating payment on a customer's
behalf is explicitly **not** supported in this milestone (the milestone spec calls this out
directly) — a provider owner attempting `POST /api/bookings/:bookingId/payment` for a booking on
their own provider gets the same `404` a stranger would. `GET /api/payments/:id` (payment detail) is
readable by the payment's own customer, the owning provider's owner, or an admin, mirroring
`GET /api/bookings/:id` exactly.

### Response shape

```json
{ "id": "...", "bookingId": "...", "amountMinor": 79900, "currency": "INR", "status": "SUCCEEDED" }
```

`providerPaymentId` is deliberately never exposed in the public API shape (`toPublicPayment`,
`apps/api/src/lib/payment.ts`) — it's an implementation-specific identifier a future real provider's
id format shouldn't leak into, and the customer has no use for it. Signatures, webhook secrets, and
raw webhook payloads are never returned by any endpoint.

### Known limitations

- No endpoint or job currently transitions a booking to `COMPLETED` — it's a legal state in the
  transition table, but nothing produces it yet (would be an automatic post-appointment-time job or
  a provider "mark complete" action; deliberately out of scope here).
- Idempotency keys (both booking and payment) never expire; there's no cleanup job for old key rows.
- **No refunds, payouts, subscriptions, wallets, commissions, taxes, coupons, invoices, or accounting**
  — explicitly out of scope for this milestone. A payment that succeeds after its booking was
  independently cancelled (see **Booking confirmation rule**, above) is the one scenario where a real
  system would need a refund; today it's simply left as a `SUCCEEDED` payment against a `CANCELLED`
  booking, flagged here for whenever a refund milestone exists.
- No real payment provider is integrated — `MockPaymentProvider` is the only implementation, and no
  real payment credentials exist anywhere in this codebase.
- A `PENDING` mock payment has no background job that ever resolves it on its own; resolution only
  happens via an explicit webhook delivery (exercised by tests and, for the mock provider's own
  deterministic model, would be the equivalent of a real provider's async confirmation). The frontend
  reflects this honestly with a "Check again" reload action rather than pretending to resolve it.

## Medical records

Medical records are the first genuinely sensitive data this codebase stores, so this milestone
layers stronger authorization, auditability, and data-isolation guarantees on top of every pattern
above — it is deliberately **not** treated like pets/providers/services CRUD.

**The central rule, stated once so it can be referenced everywhere else: a pet ID is never an
authorization credential.** Knowing a pet's UUID (from a URL, a network request, a support ticket)
grants nothing by itself. Every read and write independently re-derives, from the authenticated
session and real database state, whether the caller is that pet's owner or a provider with a real
treating relationship to that pet — never from anything the client supplies.

### Data model

`medical_records` (`apps/api/src/db/schema.ts`): `pet_id`, `provider_id`, and `created_by_user_id`
are `NOT NULL`; `booking_id` is nullable (a record can exist without being tied to one specific
appointment, e.g. a provider backfilling history). All four are `RESTRICT` foreign keys — never
`CASCADE`, never `SET NULL` — because a medical record is a historical business record and none of
its identity fields may ever be silently orphaned or rewritten by something else being deleted. In
practice this means **a pet with medical history can no longer be hard-deleted** through
`DELETE /api/pets/:id`; that endpoint already turned the equivalent booking-history FK violation into
a clean `409` (see Pet management, above) and now does the same for medical-record history, with an
updated message covering both.

`record_type` is a closed Postgres enum: `VISIT`, `DIAGNOSIS`, `VACCINATION`, `MEDICATION`,
`ALLERGY`, `LAB_RESULT`, `SURGERY`, `OTHER` — never an arbitrary client-supplied string. Each type
has its own small, strictly-shaped `details` object (stored as one JSONB column, validated by the
matching Zod schema — `packages/shared/src/medical-records.ts`'s `detailsSchemaForType` — on every
write and never trusted as pre-validated on read): a `VACCINATION` needs `vaccineName` +
`administeredAt`; a `MEDICATION` needs `medicationName` + `dosage` + `frequency`; and so on. This is
deliberately in between the milestone's two rejected extremes — one giant unstructured text field,
or a dozen sparse nullable columns on the table — and every per-type schema uses `.strict()`, so an
unknown key inside `details` is a validation error, not silently accepted data.

Records are **never hard-deleted**. The only lifecycle transition is `ACTIVE -> ARCHIVED`
(`POST /api/medical-records/:id/archive`), enforced by a hand-added `CHECK` constraint (drizzle-kit
0.24.2 doesn't emit `CHECK` from the schema builder — the same documented gap as the
services/bookings/availability-exceptions migrations) tying `archived_at` to `status`. There is no
un-archive endpoint and no `DELETE` route anywhere in this feature.

### Provider access model — the legitimate-relationship rule

```
caller may read/write a pet's medical records
  <=>  caller owns the pet (read-only), OR
  <=>  caller owns a `providers` row with at least one booking against
       this exact pet whose status is CONFIRMED or COMPLETED
```

This is computed fresh on every request by `findAuthorizedProviderIds`
(`apps/api/src/lib/medical-record.ts`) — a join over `providers` and `bookings` filtered to the
caller's own `ownerUserId` and the target `petId`, never a value read once and reused, and never a
client-supplied `providerId` taken at face value. `PENDING` bookings deliberately do **not** count —
payment hasn't settled yet and the provider may never actually see the pet — and neither do
`CANCELLED` ones. A client-supplied `providerId` in the create body is only ever checked for
**membership** in that independently-derived set (a disambiguator for the rare case where a user
owns more than one eligible provider business, never a credential); the same applies to a
client-supplied `bookingId`, which is independently re-verified to belong to the exact pet and
provider in question and to carry a legitimate status (`loadLegitimateBooking`) — this is the direct
defense against "Provider A + Pet B + a real booking ID that actually belongs to Provider C."

**Continuity of care**: once a provider has a current legitimate relationship with a pet, they see
that pet's **entire** active medical history, including records authored by a different provider who
also legitimately treats the same pet — matching how a real veterinary record system works. What a
co-treating provider still cannot do is **write** to a record they didn't author: `PATCH` and
`POST /:id/archive` additionally require `providers.ownerUserId === caller` **and**
`providers.id === record.providerId` — the exact authoring provider, no exceptions, not even another
provider who currently treats the same pet.

Only a provider may `POST` a new record; a pet owner never can, even for their own pet. If the pet
owner themselves attempts it, they get a `403` with a clear reason — they already know their own pet
exists, so naming the reason leaks nothing. Anyone else (an unrelated provider, an unrelated
customer, a provider whose relationship has since lapsed) gets the same `404` a nonexistent pet id
would — this is the same IDOR-hiding convention used everywhere else in this codebase (see
Foundation, above), now extended to hide *whether a treating relationship exists at all*, not just
whether the pet itself exists.

**Deliberate scope decision — no admin bypass.** Unlike bookings/services/providers, medical-record
routes give `ADMIN` no special access; an admin follows the exact same owner/provider rules as
anyone else. The milestone brief doesn't call for an admin oversight panel, and adding one would
only grow the attack surface without a corresponding requirement — see
`medical-records.test.ts`, "admin has no special medical-record access."

### Record authorship and immutability

`created_by_user_id` and `provider_id` are set from the authenticated session and the
independently-derived authorized provider — there is structurally no field on
`createMedicalRecordSchema` for a client to supply either one. `PATCH /api/medical-records/:id`
(`updateMedicalRecordSchema`) only ever accepts `title`, `description`, `recordedAt`, and `details` —
not `.strict()`, matching this codebase's established Zod policy of silently stripping unknown keys
rather than rejecting the whole request (see `createBookingSchema`'s mass-assignment test) — so a
client attempting to smuggle `petId`/`providerId`/`createdByUserId`/`createdAt` through a `PATCH`
simply has those keys dropped before the route ever sees them, on top of the route itself never
reading those keys off the parsed body. A correction is therefore always an in-place amendment of
content, never a rewrite of identity — full before/after field-level history isn't kept in this
first version (see Known limitations), but *that a correction happened, when, and by whom* always is
(next section).

### Audit logging

`audit_logs` (`apps/api/src/lib/audit.ts`, `recordAuditEvent`) is the **only** place any row is ever
written to that table — every sensitive route calls through this one function rather than inserting
directly. It is **append-only**: there is no `PATCH`/`DELETE` endpoint for an audit log entry
anywhere in this codebase (proven directly in `medical-records-security.test.ts`), and even an admin
cannot rewrite history through any HTTP route in this milestone.

Five actions are recorded: `MEDICAL_RECORD_CREATED`, `MEDICAL_RECORD_VIEWED` (on every authorized
read — both a single-record detail fetch, `GET /api/medical-records/:id`, and a pet's list endpoint,
`GET /api/pets/:petId/medical-records`, which writes **one** event per list request carrying only a
row count in `metadata`, never one event per row — a bulk read of a pet's whole history is exactly
the kind of access this audit trail exists to capture, and skipping it just because it's a list
would leave the single largest read surface in this feature unaudited), `MEDICAL_RECORD_UPDATED`,
`MEDICAL_RECORD_ARCHIVED`, and `AUTHORIZATION_DENIED` (written for denied writes and denied
detail-record reads, capturing probing attempts without changing the response the caller sees). A
write's audit event is inserted
inside the **same database transaction** as the write itself (`db.transaction` in
`routes/medical-records.ts`) — either both commit or neither does, which a separate post-commit write
could never guarantee.

`metadata` carries only small structural context — e.g. `{"recordType":"VISIT"}` on create, or
`{"changedFields":["title","recordedAt"]}` on update — **never** medical content, verified directly
in tests by asserting the metadata never contains the record's actual title/diagnosis text. Ordering
and attribution rely entirely on the database's own `id`/`created_at`, never in-process JavaScript
timing, so a concurrent create+update+read against the same record still produces a fully
attributable, deterministically queryable trail.

### Why no locking transaction around create (and why that's fine here)

Booking creation (`routes/bookings.ts`) locks the `providers`/`services` rows with
`SELECT ... FOR UPDATE` inside a transaction because those rows carry mutable state
(`provider.status`, `service.active`) that a concurrent request can change between an unlocked read
and commit, and because two concurrent bookings can race for the *same slot* — a real conflict this
codebase must resolve deterministically. Medical-record creation has no equivalent: the "legitimate
relationship" a create depends on is derived from **existing, already-committed** booking rows (a
`CONFIRMED`/`COMPLETED` booking that already exists), and there is no endpoint anywhere in this
codebase that revokes a booking's `CONFIRMED`/`COMPLETED` status once reached (cancellation only
applies to still-blocking states, and there's no "undo a confirmed booking" action) — so there is no
window in which the authorization check performed at the top of the handler could become stale by
the time the `INSERT` runs. Two concurrent creates for the same pet+provider don't conflict with each
other the way two bookings for the same slot do; each simply inserts its own row.

### Response shape

```json
{
  "id": "...", "petId": "...", "providerId": "...", "providerName": "Riverside Vet Clinic",
  "bookingId": "...", "recordType": "VACCINATION", "title": "Rabies vaccine",
  "description": null, "details": { "vaccineName": "Rabies", "administeredAt": "2026-01-20" },
  "recordedAt": "2026-01-20T09:00:00.000Z", "status": "ACTIVE",
  "archivedAt": null, "archivedReason": null, "createdByUserId": "...",
  "createdAt": "...", "updatedAt": "..."
}
```

Every field here is either identity/structural metadata or exactly what an authorized provider
entered — there is no computed medical inference, recommendation, or AI-generated content anywhere
in this response, matching the milestone's explicit non-goals below.

### Frontend

`apps/web/src/features/medical-records/` follows the same `{api,hooks,schemas,components}` shape as
every other feature. `MedicalRecordsSection` is the single mount point used by both surfaces: the
pet owner's own pet page (`/pets/$petId`, `canCreate={false}` — read-only, no archive action ever
rendered) and a provider's patient view (`/provider-medical-records/$petId`, reached only from a
`CONFIRMED`/`COMPLETED` booking row in `ProviderBookingsPanel`, never by a typed-in pet id). The
provider route is deliberately keyed by `petId` alone, not `providerId` — the server derives the
acting provider from the session exactly as every API route does, so the frontend never asserts a
provider identity the backend would have to double-check anyway. `canCreate` and `canManage` only
toggle which controls render; the server re-checks authorization independently on every request
regardless of what the UI offers, so there's no client-side gate a direct API call could bypass.

### Non-goals (explicitly out of scope for this milestone)

Real medical diagnosis, AI-generated diagnosis or medical advice, prescription recommendations,
pharmacy integration, insurance, laboratory system integrations, telemedicine, and notifications are
all explicitly not implemented — this milestone is about **secure record storage and access**, not
medical decision-making, matching the milestone brief precisely.

### Known limitations

- **No field-level amendment history.** A `PATCH` is audited (actor, timestamp, which field *names*
  changed) but the previous *values* aren't separately retained — a future milestone wanting a full
  diff/redline view would need an explicit revision table. What's guaranteed today is that a change
  happened, when, and by whom, never that it happened silently.
- **Attachments are deferred.** The repository has no existing safe file-storage abstraction (no
  upload endpoint, no object-storage client — `pets.photoUrl` is just a freeform URL field, not a
  storage integration) to build on, and the milestone brief explicitly says not to build arbitrary
  file uploads to local disk or accept unvalidated external URLs as attachments. `medical_records`
  has no attachment column; adding one is a clean, additive extension once a real storage
  abstraction exists elsewhere in the codebase.
- **No un-archive.** Archiving is one-directional through the API; reactivating a mistakenly-archived
  record isn't supported yet (would need its own audited action, deliberately not added
  speculatively).

## Reviews & ratings

**A review is earned through a completed booking, not created merely by knowing a provider ID.**
That single rule is the entire authorization model for this milestone; everything below is either a
consequence of it or the plumbing needed to make it enforceable.

### Booking completion — the necessary prerequisite

Before this milestone, nothing in the codebase ever moved a booking to `COMPLETED` — it was a legal
transition in the state table (`CONFIRMED -> COMPLETED`, see Booking engine, above) that nothing
produced. This milestone adds the one thing that does: `POST /api/bookings/:id/complete`, callable
only by the booking's own provider owner (or an admin) — **never the customer**, since `COMPLETED`
is an attestation that the service was actually delivered, and only the provider is in a position to
know that. It uses the exact same `SELECT ... FOR UPDATE`-inside-a-transaction locking `POST
/:id/cancel` already uses, for the same reason: a plain read-then-write would let a concurrent
cancel and complete both read `CONFIRMED` and both "succeed," when at most one legal transition
should actually win. A customer attempting to complete their own booking gets a `403` (they already
know it exists — no information leak); anyone with no relationship to the booking at all gets the
usual `404`.

### The eligibility rule

```
customer may review a provider
  <=>  customer owns a booking
  AND  that booking.status = COMPLETED
  AND  that booking has no review yet (UNIQUE(booking_id))
```

`PENDING` (payment not settled), `CONFIRMED` (appointment hasn't happened yet), and `CANCELLED`
bookings are all rejected with a `409` — not a `404` and not silently accepted — because the caller
in every one of these cases already owns the booking in question and knows perfectly well what state
it's in; there's nothing to hide. A booking belonging to someone else is a different matter and
returns the usual `404` (see `POST /api/bookings/:bookingId/review` in `routes/reviews.ts`).

### Identity is always derived from the booking and the session, never the client

`createReviewSchema` (`packages/shared/src/reviews.ts`) has no `bookingId`, `customerUserId`, or
`providerId` fields at all — structurally, a client cannot supply any of them as part of a review.
The route derives `customerUserId` from the authenticated session and `providerId` from the
**booking row itself** (`booking.providerId`), in the same request that validates the booking is the
caller's own and is `COMPLETED` — never a value read earlier, never trusted from anywhere else. This
is the direct defense against a malicious body like
`{"bookingId": "my-booking", "providerId": "someone-else's-provider", ...}`: the `providerId` key, if
present, is simply never read.

### One review per booking — enforced by the database, not just application logic

`reviews.booking_id` is `UNIQUE` (see the migration) and `RESTRICT` (never `CASCADE`) — a review can
never silently disappear because its booking did, and a booking can never end up with two reviews no
matter how the requests are timed. `POST /api/bookings/:bookingId/review` does an ordinary `INSERT`
and catches Postgres's unique-violation error code (`23505`) as a clean `409`, exactly the same
pattern `booking_idempotency_keys` and the bookings `EXCLUDE` constraint already use elsewhere in
this codebase — **the database is what makes two genuinely concurrent submissions for the same
booking safe**, not a `SELECT`-then-`INSERT` check (which has an inherent race window an app-level
check alone cannot close). Verified directly with a real concurrent `Promise.all` of two review
submissions for the same booking, asserting exactly one `201`/one `409` and exactly one row in the
database afterward.

### Rating validation

An integer 1–5, nothing else — `0`, `6`, `-1`, `3.5`, and `999999` are all rejected. Enforced at the
Zod layer (`ratingSchema`) **and** the database layer (a hand-added `CHECK` constraint, since
drizzle-kit 0.24.2 doesn't emit `CHECK` from the schema builder — the same documented gap as every
other `check()`-declared constraint in this codebase). Both layers matter: Zod protects the normal
API path with a helpful field-level error; the `CHECK` constraint protects the invariant even from a
bug in application code or a future direct-database write.

### Editing — content only, identity never

`PATCH /api/reviews/:id` accepts `rating`/`title`/`comment` and nothing else (`updateReviewSchema`
has no other fields) — a client sending `bookingId`/`customerUserId`/`providerId`/`createdAt` simply
has those keys silently stripped by Zod before the route ever sees them, matching this codebase's
established mass-assignment policy (see Foundation, above). Only the reviewing customer may edit
their own review; not the reviewed provider, not another customer, and — a deliberate scope decision
matching the milestone brief's "do not add complicated admin workflows yet" — not even an admin. An
id that doesn't resolve to the caller's own review returns the same `404` a nonexistent one would.

### Deletion — deliberately not implemented

There is no `DELETE /api/reviews/:id` endpoint. A review is a piece of historical business record
the same way a booking or a medical record is; the milestone brief explicitly prefers a soft/
moderation state over physical deletion. `reviews.status` (`PUBLISHED`/`HIDDEN`) exists today purely
as that forward-compatible hook — every review created through this milestone is `PUBLISHED`, and
nothing in this codebase currently sets it to `HIDDEN` or exposes a way to. Building the actual
moderation workflow (who can hide a review, an admin surface, an appeals path) is explicitly out of
scope here, matching "do not add complicated admin workflows yet" and "Admin / Operations" being a
later, separate milestone.

### Public visibility and reviewer privacy

`GET /api/providers/:providerId/reviews` is public (no session required) and returns only
`PUBLISHED` reviews, deliberately **not** gated on the provider's own current status
(`ACTIVE`/`INACTIVE`/`SUSPENDED`) — unlike services/availability, a review is a record of service
already received and stays visible even after a provider later deactivates. Every review in the
response carries a `reviewerDisplayName` (`lib/review.ts`'s `toReviewerDisplayName`) derived from
the reviewing customer's stored account name — "Suraj Panda" becomes "Suraj P." — **never** the raw
full name, and never the email or the customer's internal user id, either of which would be a new
PII exposure this codebase hasn't had before. A provider can see reviews for their own provider the
same way anyone else can (the public list); they get no elevated view of reviewer identity and
cannot alter another customer's review through any endpoint.

### "Verified booking"

Every review in this system was, by construction, created from a booking that had already reached
`COMPLETED` — there is no code path that creates one any other way. The frontend labels every review
"Verified booking" unconditionally (see `ReviewPanel`/`ProviderReviewsList`) rather than storing a
redundant boolean that could only ever be `true`; the guarantee lives in the schema (the `NOT NULL`,
`RESTRICT` `booking_id` foreign key and the eligibility check above), not in a flag that could
theoretically drift from it.

### Provider aggregate rating

`averageRating`/`reviewCount` are computed fresh from the `reviews` table on every request that
needs them (`lib/review.ts`'s `getReviewAggregate`/`getReviewAggregates`) — never a cached/stale
column on the `providers` row itself. A single grouped SQL query computes the aggregate for an
entire page of providers at once (`GET /api/providers`), never one query per provider, and only
`PUBLISHED` reviews are ever counted, so a future `HIDDEN` review can never inflate or deflate a
rating. A provider with zero (or zero *published*) reviews gets `averageRating: null`, never `0` — a
provider that has simply never been reviewed is not the same thing as a one-star provider, and the
frontend renders that distinction explicitly ("No ratings yet" vs. a numeric average). The average is
rounded to 2 decimal places in application code after the `SUM`/`COUNT` aggregation happens in
Postgres — `[5, 5, 4]` -> `4.67`, not `4.666666...` and not a float-accumulation artifact from
summing many rows in JavaScript.

### Injection / XSS safety

Review `title`/`comment` are stored and returned as plain strings; nothing in this codebase ever
renders them through `dangerouslySetInnerHTML` or any other raw-HTML sink — `ReviewPanel`,
`ReviewForm`, and `ProviderReviewsList` all render review text as ordinary JSX text children, which
React escapes by construction. A stored `<script>alert(1)</script>` payload round-trips through the
API exactly as submitted (proven directly in `reviews.test.ts`) and renders as inert visible text in
the browser, never executes.

### Frontend

`apps/web/src/features/reviews/` follows the same `{api,hooks,schemas,components}` shape as every
other feature. `ReviewPanel` mounts on the booking detail page only once `booking.status ===
"COMPLETED"` and reflects, never decides: it fetches `GET /api/bookings/:bookingId/review`, shows a
write form on a `404` (no review yet) or a read view with an edit action once one exists — the same
"server decides, UI reflects" discipline `PaymentPanel` already established. `ProviderReviewsList`
is the public, unauthenticated view mounted on the provider profile page, alongside a one-line
rating headline computed from the same aggregate the API already returns on the provider object
itself (no second round trip needed for that summary line). `ProviderBookingsPanel` gained a "Mark
complete" action for `CONFIRMED` bookings, the UI entry point for the provider-side completion flow
above.

### Known limitations

- **Moderation is admin-only, not community-driven.** `reviews.status` (`PUBLISHED`/`HIDDEN`) is now
  actually used — see "Admin & operations," below — but only an admin can transition it; there's no
  flagging/reporting mechanism for customers or providers to request moderation.
- **No review deletion**, by the pet-owner-equivalent policy of "historical record, not silently
  erased" — see "Deletion," above.
- **No automatic/time-based completion.** A booking only reaches `COMPLETED` when the provider
  explicitly marks it so; there's no job that completes a booking automatically once its scheduled
  end time has passed. Providers who never mark an appointment complete leave that booking's
  customer permanently unable to review it — an accepted trade-off for this milestone rather than
  building a background job.

## Admin & operations

**Admin access is operational access, not unrestricted access to all customer data.** Every design
decision in this milestone follows from that one sentence — most visibly in what an `ADMIN` account
still *cannot* do: see medical records, mutate payment state, or rewrite audit history.

### The admin role and its provisioning

`ADMIN` is not a new role — it was already the fifth value in `ROLES`
(`packages/shared/src/auth.ts`) since authentication was first built, already used for
booking/provider-status bypasses elsewhere in this codebase. This milestone is the first time it
gets a dedicated, first-class surface. There is, and has never been, any API endpoint that sets a
user's role to `ADMIN` — registration always assigns `PET_PARENT`
(`packages/shared/src/auth.ts`'s `registerSchema` has no `role` field), and there is no role-change
endpoint anywhere in this milestone either, a deliberate scope decision the milestone brief
explicitly allows ("it is acceptable to make role changes unavailable and provision admins through a
controlled database/seed mechanism"). In practice this means the *only* way an account ever becomes
`ADMIN` is a direct database write — exactly the same mechanism this codebase's own test suite has
relied on since the very first milestone (`apps/api/src/test-helpers.ts`'s `promoteToAdmin`, and its
Playwright-side equivalent added in this milestone, `e2e/db.ts`'s `promoteToAdminByEmail`). This is
not a stopgap that happens to work for tests — it *is* the production admin-provisioning model for
this version of the platform.

### Server-side authorization — the one gate every admin route shares

`createRequireAdmin` (`apps/api/src/middleware/auth.ts`) is the single reusable authorization
primitive every one of the seven `/api/admin/*` route groups mounts as `app.use("*", ...)` before any
handler runs. It layers directly on top of the existing session-resolution logic
(`resolveUser`/`createRequireAuth`) so an unauthenticated caller still gets a `401` — never a
misleading `403` that would imply the caller is merely unauthorized rather than not logged in at
all — and only once authenticated does it check `role === "ADMIN"`, rejecting anyone else with a
plain `403`.

This deliberately does **not** follow this codebase's usual pets/bookings/medical-records/reviews
convention of hiding a resource's existence behind a `404` for an unauthorized caller. That
convention exists because those resources' *existence itself* can be sensitive (a stranger
shouldn't learn whether a particular pet or booking id is real). The `/api/admin/*` namespace has no
such secret — every authenticated user already knows an admin surface exists, in the same way every
web app has *some* login page — so a plain, honest `403 Forbidden` is the correct response, and
using `404` here would just be needless obscurity without a real security benefit.

The admin role itself is read from the authenticated user's own database row
(`resolveUser` → `toPublicUser` → `users.role`), via the same session-cookie resolution every other
authenticated route already uses — never a client-supplied header, request-body field, query
parameter, or frontend flag. A request that sends `{"role": "ADMIN"}` in its body, or an
`X-User-Role: ADMIN` header, is simply never read for authorization purposes by any code path in
this codebase.

**Frontend route protection is UX only.** `apps/web/src/routes/_authenticated/admin/route.tsx`
redirects a non-admin to `/dashboard` before rendering anything under `/admin`, so a customer or
provider never even sees the admin shell — but this is purely so a non-admin isn't shown a confusing
"Forbidden" page instead of a normal one. Nothing about that redirect is load-bearing for security:
every admin API call an admin page makes would independently return `403` to a non-admin caller
regardless of whether the frontend redirect fired, proven directly (not just asserted) by
`admin-security.test.ts` hitting every `/api/admin/*` route group directly as an anonymous, a
customer, and a provider-owner caller, and by `e2e/admin.spec.ts`'s dedicated security spec driving
`page.request.get(...)` straight at the API from a non-admin browser session.

### API namespace

```
GET  /api/admin/dashboard
GET  /api/admin/providers            GET /api/admin/providers/:id
POST /api/admin/providers/:id/status
GET  /api/admin/users
GET  /api/admin/bookings             GET /api/admin/bookings/:id
GET  /api/admin/payments             GET /api/admin/payments/:id
GET  /api/admin/reviews
POST /api/admin/reviews/:id/hide     POST /api/admin/reviews/:id/publish
GET  /api/admin/audit
```

Every list endpoint takes `page`/`pageSize` (capped, same `z.coerce.number().max(N).catch(default)`
pattern every other paginated list in this codebase already uses — an absurdly large `pageSize`
value fails schema validation and silently falls back to the default rather than being honored or
rejected with an error) and resource-appropriate filters — `search`/`status`/`providerType` for
providers, `search`/`role` for users, `status`/`providerId`/`paymentStatus`/`dateFrom`/`dateTo` for
bookings, `status`/`bookingId` for payments, `status`/`providerId` for reviews, `action`/
`resourceType` for audit entries — all validated by Zod (`packages/shared/src/admin.ts`) before ever
reaching a query. Search filters use Drizzle's `ilike(column, \`%${term}%\`)`, which always binds the
term as a parameter, never concatenates it into SQL text — a search string shaped like a SQL
injection payload (`' OR '1'='1`) is treated as a completely inert literal value, never as SQL
syntax (proven directly in `admin-security.test.ts`).

### Provider management and status transitions

`GET /api/admin/providers` reuses `toPublicProvider` (the exact same DTO shape a provider owner sees
for their own listing — id, contact fields, `status`, `averageRating`, `reviewCount`) but, unlike
public discovery, returns providers of **every** status, since an admin specifically needs to find
an `INACTIVE` or `SUSPENDED` listing to act on it.

`POST /api/admin/providers/:id/status` is the only mutation in this route group, and it does exactly
one thing: change `providers.status`. It reuses `assertStatusTransitionAllowed`
(`apps/api/src/lib/provider.ts`) — the SAME transition table the owner-facing
`PATCH /api/providers/:id` route has relied on since the provider-management milestone — rather than
inventing a second, parallel status-transition rule; since the actor is always `ADMIN` here, every
transition is legal, including out of `SUSPENDED` (which an owner alone can never do — see Provider
management, above, and `admin.test.ts`'s "the provider owner cannot unsuspend themselves"). The
request body accepts exactly one field (`{"status": "..."}` — `adminProviderStatusSchema` has no
other fields, so `ownerId`/`createdAt`/any other key sent alongside it is silently discarded before
the route ever sees it, proven directly by a mass-assignment test). The status update and its audit
event (`PROVIDER_STATUS_CHANGED`, `metadata: {previousStatus, newStatus}`) happen inside one
`db.transaction`, with the provider row locked via `SELECT ... FOR UPDATE` first — either both writes
land or neither does, and no concurrent status change can race past it unnoticed (see the milestone
brief's explicit "do not create: provider suspended but no audit record").

### Suspension does not touch historical data

Suspending a provider writes to exactly one row — `providers.status` (plus the audit_logs insert).
Nothing about this endpoint, or anything it calls, touches `bookings`, `payments`, `medical_records`,
`services`, or `reviews`. The *effect* of suspension on future activity comes entirely from
mechanisms that already existed before this milestone and needed no changes:

- **New bookings are blocked** because `POST /api/bookings` already re-reads `provider.status` inside
  its own transaction and rejects with `409` unless it's `ACTIVE` (see Booking engine, above) — a
  suspended provider simply fails that existing check the same way an owner-deactivated one always
  has.
- **Public discovery hides it** because `GET /api/providers`/`GET /api/providers/:id` already only
  show `ACTIVE` providers to non-owner/non-admin callers (see Provider management, above) — a
  customer visiting a just-suspended provider's page gets the same "not found" a nonexistent
  provider id would.
- **Historical bookings, their payments, their medical records, and their reviews are all left
  completely untouched** — proven directly in `admin.test.ts`, "suspension does not corrupt
  historical data": a `COMPLETED` booking, its `SUCCEEDED` payment, and its review all still exist,
  unchanged, immediately after the provider that fulfilled them is suspended.
- **No mass-cancellation workflow exists or is implied.** A `CONFIRMED` future booking against a
  newly-suspended provider is left exactly as it was — still visible to its customer, still
  cancellable through the ordinary cancel flow, still completable by the (suspended) provider if the
  appointment still goes ahead in practice. This is a deliberate scope decision, not an oversight:
  the milestone brief explicitly says "do not invent a mass-cancellation workflow," and a real
  product would need a considered policy here (automatic refund? manual review? customer
  notification?) that's out of scope for this milestone.

### User visibility — data minimization

`GET /api/admin/users` (`toAdminUser`, `apps/api/src/lib/admin.ts`) returns exactly four fields per
user: `id`, `name`, `role`, `createdAt`. Never `email`, never `phone`, never `passwordHash` (obviously
never returned anywhere in this codebase), never a session token. This is a literal reading of the
milestone brief's own example field list, not an accidental omission — search is by display name
only (`ilike(users.name, ...)`), never by email, so there's no way to even probe for a matching
account by email through this endpoint. There is no user-detail endpoint beyond the list, since the
list already carries everything an operational view needs.

### Booking and payment visibility — read-only

`GET /api/admin/bookings` and `GET /api/admin/payments` are both entirely read-only: **no mutation
endpoint of any kind exists for either resource under `/api/admin`.** This is deliberate and
explicitly called out in the milestone brief ("operational visibility does not automatically mean
mutation permission" for bookings; "an admin dashboard must not bypass payment invariants" for
payments) — a booking's state still only ever changes through the existing customer/provider-facing
lifecycle endpoints (create, cancel, complete), and a payment's state still only ever changes through
the existing payment-provider/webhook flow. There is, in particular, **no way for an admin to
manually mark a payment `SUCCEEDED`** — proven directly in `admin-security.test.ts` by hitting
`PATCH`/`PUT`/`POST` on `/api/admin/payments/:id` and confirming every one of them is a plain `404`
(the route simply doesn't exist), with the payment's actual status in the database unchanged.

A booking's admin-facing `paymentStatus` (`SUCCEEDED`/one of the other payment states/`NONE`) is a
**derived** value, not a column — computed from a booking's own payment attempt rows by
`derivePaymentStatusForBooking` (`apps/api/src/lib/admin.ts`): the `SUCCEEDED` attempt if one exists,
otherwise the most recently updated attempt's status, otherwise `NONE` if payment was never
attempted at all. Filtering the booking list by `paymentStatus` can't be pushed into the same single
indexed SQL query the other filters use (there's no `payment_status` column on `bookings` to filter
on), so that one filter path computes the derived status in application code over a bounded candidate
set (capped at `PAYMENT_STATUS_FILTER_CANDIDATE_CAP = 1000` rows) rather than the database — a
documented, deliberate simplification appropriate to an admin tool's scale, not a claim this
approach scales to an unbounded dataset (see the comment on that code path in
`apps/api/src/routes/admin/bookings.ts`).

`providerPaymentId` is exposed in the admin payment view (`adminPaymentSchema`) even though the
customer-facing `publicPaymentSchema` deliberately omits it — judged safe for operational visibility
because it's a correlation id, never a credential, signature, or secret (see Payments, above, for why
it's hidden from customers: it's provider-implementation-specific, not because it's sensitive).
Webhook secrets, signatures, and raw webhook payloads are never returned by any endpoint, admin or
otherwise.

### Review moderation

`GET /api/admin/reviews` sees reviews of **every** status (`PUBLISHED` and `HIDDEN`), unlike the
public provider review list, which only ever shows `PUBLISHED` ones — an admin specifically needs to
find a `HIDDEN` review to republish it. `POST /api/admin/reviews/:id/hide` and
`POST /api/admin/reviews/:id/publish` are the only two review mutations this route group offers, each
using the exact same locked-transaction-plus-audit-event pattern as the provider-status endpoint
(`SELECT ... FOR UPDATE`, then update `reviews.status`, then insert an `ADMIN_REVIEW_HIDDEN` or
`ADMIN_REVIEW_PUBLISHED` audit event with `metadata: {previousStatus}` — never the review's actual
`rating`/`title`/`comment`). Hiding an already-hidden review (or publishing an already-published one)
is a clean `409`, not a silent no-op and not a duplicate audit event.

No one but an admin can reach either action. The reviewing customer's own
`PATCH /api/reviews/:id` (see Reviews & ratings, above) can amend `rating`/`title`/`comment` but has
no `status` field at all — a customer cannot hide or publish their own review through any endpoint,
let alone someone else's. A provider — even the one the review is about — has no path to either
action either.

### Audit log viewer

`GET /api/admin/audit` reads from the **same** `audit_logs` table the medical-records milestone
introduced — there is no second, admin-specific audit mechanism. It is read-only: there is no
`PATCH`/`DELETE` route for an individual audit entry anywhere in this codebase, for any actor,
including an admin (proven directly in `admin-security.test.ts`) — audit logs remain append-only and
tamper-proof exactly as originally documented in Medical records, above, and every new
admin-generated event (`PROVIDER_STATUS_CHANGED`, `ADMIN_REVIEW_HIDDEN`, `ADMIN_REVIEW_PUBLISHED`)
is subject to that same invariant.

This endpoint deliberately surfaces **every** action value, including the medical-records ones
(`MEDICAL_RECORD_CREATED`/`VIEWED`/`UPDATED`/`ARCHIVED`). This is not a carve-out of the
medical-record boundary described below — an audit row's `metadata` never carries clinical content
in the first place (enforced where those rows are written, in `routes/medical-records.ts`, not
re-validated here), so what this endpoint reveals is that an access happened, by whom, and when —
the entire point of an audit trail — never what was actually recorded or viewed. Proven directly in
`admin-security.test.ts`: a medical record is created with a deliberately distinctive
title/diagnosis, and the resulting `MEDICAL_RECORD_CREATED` entry, read back through
`/api/admin/audit`, is asserted to never contain that title or diagnosis text anywhere in its
`metadata`.

`actorName` is the one place in the entire admin surface that shows a full, un-minimized account
name (resolved server-side via a batch join, never client-supplied) — a deliberate, narrow exception
to the data-minimization stance everywhere else in this milestone, because attributing an audit
event to a real actor is the entire point of an audit trail, not an incidental detail to hide.

### Medical-record isolation — the hardest boundary to get right

**Admin operational access does not imply medical-record access.** There is no
`/api/admin/medical-records` route, no `/api/admin/pets` route, and no other admin endpoint anywhere
in this codebase that returns a medical record's `title`, `description`, `details`, or any other
clinical field. An admin who has never legitimately treated a pet (no provider relationship, per the
medical-records milestone's own authorization model) still gets a plain `404` from the *existing*
`GET /api/pets/:petId/medical-records` endpoint — being `ADMIN` grants no special bypass there either
(a deliberate decision already made in the medical-records milestone, re-verified here rather than
re-litigated: `admin-security.test.ts`'s "an admin who never treated a pet still cannot read its
medical records through the existing medical-records API"). If a future milestone ever needs
operational medical-record access for a genuine support case, the milestone brief is explicit that
it "should have a dedicated audited workflow" of its own — not a side effect of general admin
privilege, and not implemented here.

### Frontend

`apps/web/src/features/admin/{api,hooks,components}` follows the same shape every other feature
does — `api.ts` calls the single centralized Ky client, nothing outside it constructs an HTTP
request. `apps/web/src/routes/_authenticated/admin/route.tsx` is a pathless-adjacent layout (an
actual `/admin` URL prefix, unlike `_authenticated` itself) whose `beforeLoad` redirects anything but
`role === "ADMIN"` straight to `/dashboard` before any child route renders, with a small local nav
(Dashboard/Providers/Users/Bookings/Payments/Reviews/Audit Log — deliberately no "Medical Records"
entry, matching the boundary above). The dashboard's own "Admin" link
(`apps/web/src/routes/_authenticated/dashboard.tsx`) only renders for `role === "ADMIN"` — again, UX
convenience, not the actual security boundary, which lives entirely server-side as described above.

### Known limitations

- **No role-change endpoint.** Promoting/demoting a user is a direct-database operation only — see
  "The admin role and its provisioning," above. A future milestone wanting self-service admin
  provisioning would need to design that carefully (in particular, preventing an admin from
  accidentally revoking their own last-admin status, which the milestone brief explicitly flags as a
  risk to guard against whenever this is built).
- **No mass-cancellation or refund workflow** for a suspended provider's future bookings — see
  "Suspension does not touch historical data," above.
- **The `paymentStatus` booking filter is bounded, not infinitely scalable** — see "Booking and
  payment visibility," above. Fine for this milestone's admin-tool scale; would need a proper
  SQL-level derivation (a materialized column, or a correlated subquery) at real production booking
  volume.
- **No dedicated payment-reconciliation workflow.** The milestone brief explicitly defers this
  ("if an operational correction is eventually needed, that belongs in a separately designed
  reconciliation workflow. Do not implement that now.") — this admin surface is visibility-only for
  payments, by design, not a stopgap reconciliation tool.

## Production hardening, observability & security

This section documents the last milestone: making PawLink demonstrably production-minded, not a
new business feature. Nothing below changes what the application *does* — every change here is
about how it behaves as a deployed, operated system: how it fails, what it logs, what it validates
at startup, how it's built, and what protects it from abuse.

### Architecture

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
              ▼  HTTPS (WEB_ORIGIN ↔ VITE_API_URL, CORS-restricted)
        ┌─────────────────────────────────────────────┐
        │                Hono API                      │
        │  requestId → requestLogging → securityHeaders │
        │  → CORS → rateLimit → [route handlers]        │
        │              │                                 │
        │        requireAuth / requireAdmin              │
        │        (session cookie → users.role)            │
        │              │                                 │
        │            Zod validation                       │
        └───────────────┬───────────────┬─────────────┘
                         │               │
                         ▼               ▼
                     Drizzle ORM      ioredis
                  (parameterized     (rate-limit
                   queries only)      counters only
                         │            — no session/
                         ▼             app data)
                    PostgreSQL          Redis
```

Domain boundaries inside the API (see their own sections above for each): **Bookings** (concurrency
via a Postgres `EXCLUDE` constraint, idempotency via a persisted key table) → **Payments** (a
provider-agnostic state machine, webhook signature + idempotency) → **Medical Records** (booking-
derived provider authorization, its own audit trail) → **Reviews** (completed-booking eligibility, a
database-enforced one-per-booking invariant) → **Admin** (role-gated operational visibility, no
medical-record bypass) → **Audit** (one shared, append-only table every sensitive action across
every domain writes to, never mutated by any HTTP route).

### Security model — a consolidated summary

Every one of these is implemented and tested in an earlier section of this document; this is the
index, not a restatement:

| Concern | Enforced by | See |
|---|---|---|
| Authentication | Hashed opaque session tokens, `httpOnly`/`secure`(prod)/`SameSite=Lax` cookies | Foundation |
| Authorization | Server-derived ownership on every mutation, never a client-supplied id | every feature section |
| IDOR resistance | 404 (not 403) for a resource that exists but isn't the caller's | Foundation |
| Booking concurrency | Postgres `EXCLUDE` constraint (`tstzrange` over provider+time) | Booking engine |
| Idempotency | Persisted `(customer_user_id, key)` claim tables, not in-memory | Booking engine, Payments |
| Payment invariants | A single transition table; amount/currency always server-derived | Payments |
| Medical privacy | Booking-derived relationship check; no admin bypass anywhere | Medical records, Admin |
| Review integrity | `UNIQUE(booking_id)`, `CHECK(rating BETWEEN 1 AND 5)`, server-derived identity | Reviews & ratings |
| Admin authorization | `createRequireAdmin` on every `/api/admin/*` route, independently of the UI | Admin & operations |
| Audit immutability | Append-only table; no `PATCH`/`DELETE` route exists for it, anywhere | Medical records, Admin |
| Mass assignment | Every mutation reads only `parsed.data` from a Zod schema, never the raw body | Foundation |
| SQL injection | Drizzle's parameterized query builder exclusively — see "Dependency audit," below | this section |
| XSS | React's default text-node escaping; zero uses of `dangerouslySetInnerHTML`/`innerHTML` | Reviews & ratings |

### Environment configuration and secret hygiene

`apps/api/src/env.ts` is the single source of truth for configuration, Zod-validated at startup —
a production process that's missing a required value, or that's still carrying a checked-in
development default for something that's supposed to be a real per-deployment secret, fails loudly
before it ever accepts a request, rather than running silently misconfigured:

- `DATABASE_URL` — always required, in every environment; there has never been a default.
- `MOCK_PAYMENT_WEBHOOK_SECRET` — defaults to a known dev value locally, but production **must**
  override it; a `.refine()` rejects the checked-in default whenever `NODE_ENV === "production"`.
- `REDIS_URL` — optional outside production (rate limiting simply runs as a no-op without it — see
  "Rate limiting," below); **required** in production by the same kind of refinement, so a real
  deployment can't silently ship without rate limiting.
- `APP_VERSION` — optional everywhere; a safe, non-secret build identifier (see "Deployment
  version," below).

`loadEnv()`'s failure path only ever logs Zod's field-level messages (which field, why) — never a
secret's actual value. `apps/api/.env`, `apps/web/.env`, and every `.env.*` variant are gitignored;
only `.env.example` files (fake/example values, explicitly documented as safe to leave for local
dev) are committed. A repo-wide search for `password|secret|token|api_key|private_key` at this
milestone's audit turned up nothing accidentally committed — the only "secret"-shaped strings in the
whole codebase are the mock payment webhook secret (explicitly documented as not a real credential)
and the field *names* themselves in Zod schemas and comments.

**Server-only configuration never reaches the client bundle.** The frontend's only environment
variable is `VITE_API_URL` (`apps/web/src/lib/api/client.ts`) — Vite only ever inlines variables
explicitly prefixed `VITE_*`, and this codebase has exactly one. There is no `DATABASE_URL`,
`MOCK_PAYMENT_WEBHOOK_SECRET`, `REDIS_URL`, or session-related secret anywhere that a client bundle
could reference even by mistake.

### API error handling

Every route in this codebase already returned a predictable `{"error": "message"}` shape with a
correctly-classified status code (`400` invalid input, `401` unauthenticated, `403` forbidden, `404`
hidden/missing resource, `409` domain conflict) before this milestone — established and tested
across ten prior milestones and hundreds of tests. This hardening pass deliberately did **not**
restructure that into the brief's illustrative `{"error": {"code", "message"}}` shape: doing so would
mean touching every route handler and every frontend error-reading call site
(`apps/web/src/lib/api/errors.ts`'s `toErrorMessage`) for a payload-shape change with no correctness
benefit — the milestone brief's own "preserve existing API semantics where already correct" and "do
not restructure the project unnecessarily" apply directly here. What *did* need hardening, and got
it:

- **Unexpected errors never leak internals.** `app.onError` (`apps/api/src/app.ts`) logs the full
  error (message, stack) plus the request id to the server-side structured log, and returns the
  client a fixed `{"error": "Internal Server Error"}` — never a stack trace, a raw SQL error, a
  filesystem path, or any exception message. Proven directly: `production-hardening.test.ts` throws
  a deliberately secret-shaped error message and asserts the HTTP response is exactly the fixed JSON,
  nothing else.
- **Known failure modes never fall through to a generic 500.** This was already true — a booking
  conflict is `409`, a duplicate idempotency key with a different request body is `409`, invalid Zod
  input is `400` with field-level detail, a missing/hidden resource is `404` — re-verified, not
  rebuilt, during this milestone's audit.

### Request IDs and structured logging

Every request gets a correlation id (`apps/api/src/middleware/requestId.ts`): an incoming
`X-Request-ID` header is used if it matches a conservative allowlist (`[A-Za-z0-9_-]{8,128}`) —
protecting against a client injecting something unsafe into logs or the echoed response header —
otherwise a fresh UUID is generated. It's set on the response (`X-Request-ID`) and threaded through
every log line for that request, including the `app.onError` handler's own log line, so a
production incident can always be traced from "which request failed" to "what that request's full
access-log entry looked like."

`apps/api/src/middleware/requestLogging.ts` replaces Hono's own dev-oriented `logger()` entirely
with one structured JSON line per request:

```json
{"timestamp":"...","level":"info","request_id":"...","method":"GET","route":"/api/pets/:petId/medical-records","path":"/api/pets/abc.../medical-records","status":200,"duration_ms":12,"user_id":"..."}
```

`route` is Hono's own matched-pattern string (never the raw id-bearing path used as a metric
dimension); `user_id` is included only when the request was authenticated. **Never logged, by any
code path in this codebase, anywhere**: request bodies, passwords, session cookies, Authorization
headers, payment secrets, webhook secrets, or medical-record content — matching the same "structural
context only" discipline the audit-log system (Medical records, above) already established.
`level` is `error` for `5xx`, `warn` for `4xx`, `info` otherwise, so a log aggregator can filter on it
without parsing the body.

### Authentication and session hardening

Re-audited, not rebuilt — this was already solid from the first milestone:

- Session tokens are 32 random bytes (`crypto.randomBytes`), never a predictable value; only their
  SHA-256 hash is ever persisted (`sessions.id`), so reading the database can't yield a usable
  credential.
- Cookies are `httpOnly` (never readable from JS — an XSS payload, even if one existed, couldn't
  exfiltrate a session), `secure` in production (never sent over plain HTTP), `SameSite=Lax`, and
  scoped to `path: "/"` with a 7-day `maxAge`.
- **Logout genuinely invalidates the session** — `POST /api/auth/logout` deletes the session row
  server-side (not just the cookie), so a stolen/replayed cookie value stops working immediately, not
  just once the cookie happens to expire client-side.
- An expired session (`expiresAt` in the past) is deleted and treated as unauthenticated on its very
  next use — never silently accepted.
- **No CSRF token exists, and none was added.** `SameSite=Lax` already blocks the cookie from being
  sent on a cross-site state-changing request (POST/PATCH/DELETE via a normal `<form>` or `fetch`
  from another origin), and CORS is restricted to exactly `WEB_ORIGIN` with credentials — the two
  together already close the practical CSRF surface for a cookie-only, single-trusted-origin API.
  Adding an explicit CSRF token on top would be genuine, documented defense-in-depth for a future
  milestone, but isn't the gap this audit found worth closing now.

### TanStack Query cache isolation (a real bug found and fixed)

This milestone's audit found a genuine cross-user data-leak bug, not a hypothetical one:
`useLogout` (`apps/web/src/features/auth/hooks.ts`) only ever removed the `auth/me` query from the
cache — every OTHER cached query (bookings, pets, medical records, admin lists, anything) survived a
logout untouched. On a shared browser/device, logging out and logging back in as someone else (or a
different account logging in without an intervening logout) could render a PREVIOUS session's cached
data for a moment before the corresponding refetch resolved — exactly the milestone brief's "second
user must not see cached private data from the first user."

**Fixed**: `useLogin`, `useRegister`, and `useLogout` now all call `queryClient.clear()` — wiping the
*entire* cache, not an allowlist of "sensitive" keys someone would have to remember to maintain —
before re-seeding the fresh `auth/me` value (login/register) or leaving it empty (logout). Every
other query simply refetches fresh on next mount; there is no meaningful cost to clearing
unconditionally on an auth transition, which happens rarely compared to ordinary navigation.

### Rate limiting

Redis-backed, fixed-window counters (`apps/api/src/middleware/rateLimit.ts`), applied to exactly the
endpoints the milestone brief prioritizes — login, registration, booking creation, payment
initiation, the payment webhook, admin search, and public provider search/list — via a small,
explicit rules table, not a blanket per-route limit:

| Rule | Method + path | Window | Max |
|---|---|---|---|
| `auth-login` | `POST /api/auth/login` | 60s | 10 |
| `auth-register` | `POST /api/auth/register` | 60s | 5 |
| `booking-create` | `POST /api/bookings` | 60s | 20 |
| `payment-create` | `POST /api/bookings/:id/payment` | 60s | 20 |
| `payment-webhook` | `POST /api/payments/webhook` | 60s | 120 (server-to-server, higher ceiling) |
| `admin-search` | `GET /api/admin/*` | 60s | 60 |
| `public-search` | `GET /api/providers`, `GET /api/providers/:id/{services,reviews}` | 60s | 120 |

Keyed by client IP (`apps/api/src/lib/clientIp.ts`), gated by a `TRUST_PROXY` env flag (`env.ts`,
default `false`) — a per-session/per-user key would be trivially bypassed by registering a new
account per attempt for exactly the endpoints (login, registration) that matter most, so IP is the
right key, but *which* IP is trustworthy depends entirely on the deployment topology in front of this
process:

- **`TRUST_PROXY=false` (the default, and what `docker-compose.prod.yml` actually ships today)** —
  `X-Forwarded-For` is never read; the key is the raw socket address instead. This repo's shipped
  production compose file publishes the `api` container's port directly to the host with **no**
  reverse proxy in front of it, so the socket address genuinely is the real client's address, and
  trusting a client-supplied header here would let any anonymous caller bypass every rate limit in
  this table by sending a different `X-Forwarded-For` value per request. (An earlier draft of this
  doc — and the code's own comment — incorrectly assumed a proxy fronted the API; there wasn't one.
  Caught during this milestone's own adversarial security review, fixed by adding this flag rather
  than by leaving the header trusted unconditionally.)
- **`TRUST_PROXY=true`** — `X-Forwarded-For`'s first hop is trusted instead. Only flip this if a real
  reverse proxy is added in front of the `api` service that is itself the sole public entry point and
  sets/overwrites that header before forwarding (not currently true of anything this repo ships).

See `apps/api/src/env.test.ts` and `apps/api/src/production-hardening.test.ts`'s `TRUST_PROXY`
describe block for tests proving both the default-off spoof-resistance and the opt-in behavior.

**Fails open, not closed**: a Redis error (timeout, connection refused, temporary outage) is caught,
logged, and the request proceeds unlimited for that one attempt — a rate limiter must never be able
to take down real traffic just because its own backing store had a bad moment. Disabled entirely
(not an error) when `REDIS_URL` is unset, which is the default in development/test — the existing
fast local test workflow (hundreds of tests registering users, creating bookings, looping over admin
endpoints) was never built around requiring a Redis container, and a global rate limit across that
suite would need per-test resets to avoid false failures. `REDIS_URL` is required in production (see
"Environment configuration," above), so a real deployment can't silently ship without this.

Fixed-window, not a true sliding window — a documented, deliberate trade-off: a client can burst up
to ~2x `max` across a window boundary. A sliding-window-log or token-bucket implementation is
meaningfully more complex for a single-Redis-instance, portfolio-scale deployment, and a fixed window
already stops the abuse patterns these rules actually target (credential stuffing, registration spam,
booking/payment hammering, scraping).

Unit-tested against a minimal in-memory fake store (`production-hardening.test.ts`) rather than
requiring a real Redis server for the test suite — proves the actual counting/threshold/`Retry-After`
logic, the per-rule bucket isolation, the fail-open behavior on a store error, and the no-op behavior
with no store configured, all without adding a hard Redis dependency to `npm test`.

### Webhook hardening (re-audited)

Already solid from the Payments milestone, re-verified rather than rebuilt: signature verification
happens strictly before the body is even parsed as JSON (so a malformed body can't be used to skip
authentication), a missing/mismatched signature is `401`, an oversized body is rejected with `413`
before either check runs, and `(provider, event_id)` uniqueness makes a genuinely duplicated or
replayed delivery a safe, idempotent no-op — proven directly by 2x and 10x-concurrent identical-event
tests. Out-of-order events go through the exact same payment-status transition table every other
change does, never a separate ad hoc "is this out of order?" check. See Payments, above, for the full
design; nothing here changed.

### CORS and security headers

CORS (`apps/api/src/app.ts`) has always been a single explicit origin from `WEB_ORIGIN` with
`credentials: true` — never a wildcard `*`, which the browser wouldn't even honor alongside
credentials anyway. Re-verified, not changed.

`apps/api/src/middleware/securityHeaders.ts` adds, on every response: `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a strict
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` — safe to be this strict
because the API only ever returns JSON, never HTML. `Strict-Transport-Security` is only set in
production, where the deployment's reverse proxy actually terminates TLS — asserting HTTPS-only over
plain `http://localhost` in development would just break local testing for no benefit.

The frontend's headers are configured at the deployment layer (`apps/web/vercel.json` — see
"Deployment," below) rather than in application code, since a static SPA has no server of its own to
add them: the same `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy` set, plus a CSP
(`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ...; connect-src 'self'
*`) — `style-src` allows `'unsafe-inline'` because Tailwind's generated styles and a handful of
inline style attributes rely on it; `connect-src` allows any origin because `VITE_API_URL` is baked
in at build time and can point anywhere the deployer configures, already independently protected by
the API's own CORS allowlist. This app loads no third-party scripts and no CDN fonts (see
`@fontsource-variable/inter`, self-hosted) — a strict CSP is genuinely safe here, not a policy full of
exceptions.

### Frontend production audit

- **Source maps are explicitly disabled** for the production build (`apps/web/vite.config.ts`,
  `build: { sourcemap: false }`) — an explicit, documented choice, not an implicit default someone
  could accidentally flip.
- **No server-only configuration reaches the client bundle** — see "Environment configuration,"
  above.
- **No debug data or test credentials** are baked into the build — `apps/web/.env.example`'s only
  variable is a public API URL.
- **TanStack Query cache isolation** — see the dedicated section above; this is as much a frontend
  production concern as a security one.
- **Route guards are UX only** — `apps/web/src/routes/_authenticated/route.tsx` and
  `.../admin/route.tsx` redirect before rendering, but every API call those pages make independently
  re-enforces the same authorization server-side (proven throughout: every `*-security.test.ts` and
  `*-security.spec.ts` file in this codebase drives the API directly, not just through the UI).

### Health, readiness, and deployment version

`GET /health` stays deliberately cheap — "is the process alive," nothing that touches Postgres,
Redis, or any other dependency (verified directly: `health.test.ts` asserts it responds in under
200ms). `GET /ready` (new this milestone) additionally runs a trivial `SELECT 1` against Postgres and
reports `200 {"status":"ok","checks":{"database":"ok"}}` or `503 {"status":"degraded","checks":
{"database":"unreachable"}}` — enough for an orchestrator's readiness probe to know whether to route
traffic to this instance, without ever exposing the connection string, credentials, or any other
configuration (verified directly in both endpoints' tests). Neither endpoint reflects Redis
reachability — rate limiting already fails open on a Redis outage (see above), so a Redis blip isn't
a readiness concern the way a Postgres outage is.

Both responses carry `version` — a safe, non-secret build identifier (a commit SHA in a real
deployment, `"dev"` when `APP_VERSION` is unset locally — see `apps/api/src/lib/version.ts`). Set via
a Docker build arg (`apps/api/Dockerfile`'s `ARG APP_VERSION`) so an operator can always answer "what
build is actually running" from `curl /health` alone.

### Docker

`apps/api/Dockerfile` is a three-stage build (`deps` → `build` → `runtime`) from the **repo root**
context (an npm-workspaces monorepo — `apps/api` depends on `packages/shared`, so a build needs the
whole tree). `npm ci --ignore-scripts` in the `deps` stage installs deterministically from the
committed lockfile without running the root `postinstall` (which needs source that isn't copied in
until the `build` stage); `npm prune --omit=dev` after building strips devDependencies before the
runtime image is assembled. The final `runtime` stage contains only compiled output
(`apps/api/dist`), the migration SQL (`apps/api/drizzle`), production `node_modules`, and the two
`package.json` files npm's workspace symlink resolution needs — no source, no devDependencies, no
`.env` file of any kind (secrets are injected as real environment variables by the orchestrator, never
baked into the image). It runs as `node:20-alpine`'s built-in unprivileged `node` user, exposes only
port 3000, and ships a `HEALTHCHECK` against `GET /health` (never `/ready`, to keep the healthcheck
itself cheap). `CMD` uses exec form (`["node", ...]`), so the Node process is PID 1 and receives
`SIGTERM` directly for a clean shutdown — no shell wrapper to swallow the signal.

The migration script (`apps/api/src/db/migrate.ts`) was fixed during this milestone's own Docker
verification: it previously resolved its migrations folder as `"./drizzle"`, relative to
`process.cwd()` — which only ever worked locally because `npm run db:migrate --workspace apps/api`
happens to run with `apps/api/` as the working directory. The Docker image's `WORKDIR` is the repo
root, not `apps/api`, so that same relative path silently pointed at a nonexistent folder and the
migrator failed with "Can't find meta/_journal.json file." Fixed to resolve relative to the
**module's own compiled location** (`fileURLToPath(new URL("../../drizzle", import.meta.url))`) —
correct regardless of the invoking working directory. Caught by actually building and running the
image end-to-end against real Postgres/Redis containers during this milestone (see "Deployment
verification," below), not by inspection alone — the exact kind of bug that inspection-only "the code
looks right" review reliably misses.

**The frontend does *not* have a Dockerfile.** It deploys as a static Vite build to Vercel instead
(`apps/web/vercel.json` — SPA rewrite so every client-side TanStack Router path serves `index.html`,
plus the security headers described above). See "Deployment," below.

`docker-compose.yml` (development) gained an optional `redis` service — `npm run dev`/`npm test`
never require it (see "Rate limiting," above); start it explicitly
(`docker compose up -d redis`) only to exercise rate limiting locally.
`docker-compose.prod.yml` (new) is the real backend production stack: Postgres + Redis + the API,
built from the real Dockerfile, run with `NODE_ENV=production` so every hardening decision in
`env.ts` actually takes effect. Postgres and Redis publish no host port (reachable only from other
containers on the compose network); the API is the one publicly-facing piece. Required secrets
(`POSTGRES_PASSWORD`, `WEB_ORIGIN`, `MOCK_PAYMENT_WEBHOOK_SECRET`) use Compose's `${VAR:?message}`
syntax — the stack refuses to start with a clear error if any of them is missing, the same
fail-loudly discipline `env.ts` already enforces inside the process itself.

### CI

`.github/workflows/ci.yml` (new — none existed before this milestone) runs on every push/PR to
`main`, as three jobs: **build** (typecheck + lint + production build, no external services needed),
**api-tests** (the full backend Vitest suite against a real ephemeral Postgres service container,
never mocked — exactly what local development already does via `docker compose up -d postgres`), and
**e2e-tests** (the full Playwright suite against real dev servers and a real Postgres service
container). A second push to the same branch/PR cancels the previous run rather than letting both
finish. The e2e job uploads the Playwright HTML report as an artifact on failure, and runs with
`--retries=1` specifically to absorb the documented CI-runner timing sensitivity described in
"Test reliability," below — not a blanket "retry until green," and not something that hides a
genuine, reproducible failure (a real bug still fails on retry too).

**Lint didn't exist in this codebase before this milestone either.** `eslint.config.js` (new) is
deliberately minimal: `typescript-eslint`'s non-type-aware `recommended` rules (type-aware linting
would need a project reference per workspace and would meaningfully slow CI down, for a benefit this
codebase's already-thorough `tsc --noEmit` typecheck step largely already covers) plus
`eslint-plugin-react-hooks` and `eslint-plugin-react-refresh` for the frontend workspace only. This
is a correctness gate, not a style/format enforcer — no Prettier, no import-ordering, nothing
retrofitted onto an already-large, already-internally-consistent codebase purely for stylistic
uniformity. Running it against the entire existing codebase at introduction found **zero errors** and
exactly one warning (a pre-existing, framework-inherent pattern in a shadcn-generated UI component) —
the codebase was already this disciplined before any lint tooling existed to enforce it.

### Dependency audit

`npm audit --omit=dev` reports two findings against production dependencies, both investigated
individually per the milestone brief's own process (is the package actually used; is the vulnerable
*path* reachable; upgrade only where that's actually true) rather than blindly running
`npm audit fix --force`:

- **`drizzle-orm` — SQL injection via unescaped identifiers (high, GHSA-gpj5-g38j-94v9).** The
  vulnerable pattern is specifically `sql.identifier()` or a dynamically-constructed `.as()` alias
  built from untrusted input (e.g. a client-supplied sort-field name used as a raw identifier). A
  repository-wide search confirms **zero uses of either API anywhere in this codebase** — every
  dynamic filter (search terms, admin sort/filter parameters) in this app uses Drizzle's ordinary
  parameterized query builder (`eq`, `ilike`, `and`, `inArray`, ...) against a fixed, hardcoded
  column reference; user input is only ever bound as a *value*, never interpolated as an *identifier*.
  The vulnerable code path is not reachable. The available fix (`drizzle-orm@0.45.3`) is a major
  version jump from the currently-pinned `^0.33.0` with real breaking-change risk across the entire
  data layer (query builder API changes, `drizzle-kit` compatibility) and no corresponding security
  benefit for this codebase — deliberately not applied, matching the brief's own "avoid unrelated
  dependency churn."
- **`esbuild` (via `vite`) — dev server request forwarding (moderate, GHSA-67mh-4wv8-2f99).** Only
  affects Vite's *development* server, which is never what's deployed — production is a static build
  served by Vercel (see "Deployment," below), not `vite`'s dev server. The fix would mean a major
  `vite` version jump (5.x → 8.x) with real risk to the existing Tailwind v4/TanStack Router Vite
  plugin integration, for a vulnerability that has no production exposure at all. Deliberately not
  applied.

Both decisions are re-evaluable whenever either package's next reachable, low-risk patch becomes
available — this is a point-in-time judgment call, documented rather than silently deferred.

### Performance sanity check

No load-testing platform was introduced (the milestone brief explicitly doesn't ask for one) — a
targeted review of the endpoints most likely to have an N+1 or unbounded-query problem:

- **Dashboard aggregates** (`GET /api/admin/dashboard`) — eight independent `count(*)` queries run
  via a single `Promise.all`, never one row fetched per entity.
- **Provider/booking/payment/review/audit lists** — every one of them is a single paginated query
  (`limit`/`offset`, capped `pageSize`) plus, where names need resolving (a booking's customer/
  provider name, a review's reviewer display name), one batched `inArray(...)` lookup per page, never
  a lookup per row.
- **Availability calculation** — already a pure, in-memory function over a handful of weekly-rule and
  exception rows per provider (see Availability management, above); no database access inside the
  hot loop at all.
- **Booking creation** — already reads exactly the rows its transaction needs (the locked
  provider/service, the pet, the relevant weekly rules and exceptions, active bookings for that
  provider), nothing broader.

Indexes already exist for every access pattern these queries actually use (see "Database integrity,"
below, and each feature's own migration comments) — this audit found no missing index worth adding.

### Test reliability

Two genuine issues were found and fixed during this milestone, not papered over:

- **A real race condition in `BookingPaymentStep`** (`apps/web/src/features/bookings/components/`):
  it previously watched the booking query independently via `useEffect` and advanced to the
  confirmation view whenever it happened to observe `CONFIRMED` — racing against the SAME payment
  mutation's own synchronous `setQueryData` (which lets `PaymentPanel` paint "Payment successful").
  Under load, React could coalesce both resulting re-renders into one commit and paint only the
  later one, skipping the intermediate state's render entirely. **Fixed** by driving the sequence
  explicitly off `PaymentPanel`'s own `onSettled` callback and an *awaited* booking refetch, which
  guarantees a real render boundary between the two states rather than racing two independently
  invalidated queries.
- **A `migrate.ts` cwd-relative path bug** — see "Docker," above.

**What remains, documented honestly rather than hidden:** a handful of Playwright specs share a
timing-sensitive assertion (`PaymentPanel`'s "Payment successful" state) that can occasionally need
more than a few seconds to paint under this specific development machine's load (Docker Desktop +
Postgres + the API's `tsx watch` process + Vite + multiple concurrent browser instances, all
competing for the same CPU cores) — confirmed, by repeated testing, to persist even running fully
serially (`--workers=1`), which rules out cross-worker Playwright contention as the cause and points
to genuine host-level resource contention instead. This is **not** a logic bug in the application —
the underlying invariant (payment succeeds → booking becomes `CONFIRMED` → the UI correctly reflects
it) held in every single run, including the ones where the transient success message itself wasn't
observed in time. The affected assertions already carry a generous explicit timeout (`15_000ms`,
matching a pattern already established in this codebase before this milestone) rather than the
default `5_000ms`, and CI runs the suite with `--retries=1` for the same reason. This is stated here
rather than silently worked around further, per the milestone brief's own "state remaining
limitations honestly."

### Deployment

PawLink deploys as two independently-deployable pieces, matching how they're actually built and
scaled:

1. **Backend** (API + Postgres + Redis) — `docker-compose.prod.yml`, built from
   `apps/api/Dockerfile`. Bring up: set `POSTGRES_PASSWORD`, `WEB_ORIGIN` (the deployed frontend's
   real origin), and `MOCK_PAYMENT_WEBHOOK_SECRET` (a real, non-default value), then
   `docker compose -f docker-compose.prod.yml up -d --build`, then run migrations once:
   `docker compose -f docker-compose.prod.yml run --rm api node apps/api/dist/db/migrate.js`.
2. **Frontend** — a static Vite build deployed to Vercel, with the project's Root Directory set to
   `apps/web` (Vercel's own monorepo support handles the npm-workspaces install/build from the true
   repo root automatically) and one environment variable, `VITE_API_URL`, pointing at wherever the
   backend from step 1 is actually reachable. `apps/web/vercel.json` supplies the SPA rewrite (every
   client-side route serves `index.html`) and the security headers described above.

A real production deployment of the backend would additionally put a TLS-terminating reverse proxy
or load balancer in front of the API container rather than exposing it directly — `docker-
compose.prod.yml` deliberately doesn't attempt to reproduce that layer (see "Known limitations,"
below), and `Strict-Transport-Security` is only meaningful once it exists.

### Known limitations (production hardening)

Stated honestly rather than glossed over, per the milestone brief's own instruction not to claim
zero vulnerabilities:

- **No TLS termination in `docker-compose.prod.yml`.** The API container serves plain HTTP; a real
  deployment needs a reverse proxy/load balancer in front of it for TLS. Not reproduced here.
- **Rate limiting is IP-keyed; `X-Forwarded-For` is untrusted by default (`TRUST_PROXY=false`).**
  Correct for the no-reverse-proxy topology this repo actually ships, but it means the key is the
  TCP peer address of whatever sits directly in front of the API — if a real reverse proxy is later
  added, `TRUST_PROXY=true` must be set at the same time or every client behind that proxy will share
  a single rate-limit bucket (the proxy's own address). See "Rate limiting," above.
- **No horizontal-scaling story for rate limiting beyond what Redis already provides** — the counters
  themselves are already shared/correct across multiple API instances (that's the whole point of
  using Redis instead of in-memory state), but nothing here addresses session affinity, connection
  pooling limits, or other multi-instance concerns beyond rate limiting specifically.
- **No CSRF token** — see "Authentication and session hardening," above, for why `SameSite=Lax` +
  restricted CORS is judged sufficient for this app's shape rather than an oversight.
- **`drizzle-orm` and `vite`/`esbuild` have known advisories against older major versions** —
  investigated and deliberately not upgraded; see "Dependency audit," above.
- **A handful of Playwright specs have a documented, understood, environment-driven timing
  sensitivity** — see "Test reliability," above. Not a correctness bug in the application.
- **This backend stack has not been proven under real production traffic/load** — the milestone
  brief explicitly scopes this to a "performance sanity check," not a load-testing platform; see
  that section, above.
