# PawLink — Architecture

This document describes how each implemented milestone actually works. It documents implemented
behavior only — see the root [README.md](../README.md) for what's implemented vs. not yet started,
and [docs/getting-started.md](getting-started.md) for setup, environment variables, and the
authentication/TanStack Router/Query/Ky patterns shared across every feature.

## Foundation & cross-cutting patterns

Every feature (pets, providers, services, availability) follows the same shape:

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
