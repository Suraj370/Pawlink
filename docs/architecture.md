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
today's API goes directly to `CONFIRMED` — there is no payment or manual-provider-approval gate yet
that would justify holding it in `PENDING` first — but `PENDING` remains a fully legal, tested state
in the schema and transition table rather than a stub, since it's the natural hook for a future
payment-hold or manual-confirmation flow. `COMPLETED` is a legal transition target with no endpoint
that currently produces it (no "mark completed" action or automatic post-appointment job exists —
deliberately out of scope for this milestone, see Known limitations below). Cancellation
(`POST /api/bookings/:id/cancel`) only ever changes `status`; the row is never deleted, because a
booking is a historical business record.

Which statuses occupy a provider's calendar (`BLOCKING_BOOKING_STATUSES`,
`packages/shared/src/bookings.ts`) is `PENDING`, `CONFIRMED`, and `COMPLETED` — `CANCELLED` never
blocks a new booking over the same time range. This single constant is the source of truth for
three independent places that all need to agree with it: `excludeBookedSlots`'s filtering, the
database `EXCLUDE` constraint's `WHERE` clause (see below), and nowhere else — there is no fourth
copy of this list anywhere in the codebase.

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

The mechanism is checked in **two places**, deliberately: first as a plain read *before* the
availability re-validation (so a sequential replay of an already-succeeded request isn't wrongly
rejected by the availability check, since the booking IT created is now correctly occupying that
exact slot), and second as the actual transactional claim, inside the same database transaction
that creates the booking. That second check is what makes truly concurrent same-key requests
correct: the claim is `INSERT ... ON CONFLICT DO NOTHING` against the composite primary key, so a
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

### Known limitations

- No endpoint or job currently transitions a booking to `COMPLETED` — it's a legal state in the
  transition table, but nothing produces it yet (would be an automatic post-appointment-time job or
  a provider "mark complete" action; deliberately out of scope here).
- `PENDING` is unreachable through today's API — every booking is created directly as `CONFIRMED`,
  since there is no payment or manual-approval gate yet. The state remains fully defined for when
  one is added.
- Idempotency keys never expire; there's no cleanup job for old key rows.
- No payment integration — creating a booking has no cost to the customer in this milestone.
