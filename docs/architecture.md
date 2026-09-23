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

- **No moderation workflow.** `reviews.status` exists as a schema-level hook (`PUBLISHED`/`HIDDEN`)
  but nothing sets it to `HIDDEN` yet — flagging/hiding abusive reviews is explicit follow-up work
  for the later "Admin / Operations" milestone, not this one.
- **No review deletion**, by the pet-owner-equivalent policy of "historical record, not silently
  erased" — see "Deletion," above.
- **No automatic/time-based completion.** A booking only reaches `COMPLETED` when the provider
  explicitly marks it so; there's no job that completes a booking automatically once its scheduled
  end time has passed. Providers who never mark an appointment complete leave that booking's
  customer permanently unable to review it — an accepted trade-off for this milestone rather than
  building a background job.
