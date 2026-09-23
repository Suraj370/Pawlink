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
service and slot on a real provider another user set up, review, confirm — which creates a `PENDING`
booking — then pay via the mock provider's "Pay now" button on the payment step, see the payment
succeed and the booking confirmation appear only after that, find it in "My Bookings", then reload
availability and confirm the exact slot — and any other slot that would now overlap it — no longer
appears) and cancellation (cancel from the booking detail page, confirm the slot becomes bookable
again). `e2e/bookings-security.spec.ts` is the mandatory cross-user proof: User B gets "not found" in
the UI and a `404` directly against `GET/POST /api/bookings/:id`(`/cancel`) for User A's booking, and
a `404` attempting to book using User A's own pet id (User A still pays via the mock provider before
the cross-user assertions run, so the booking under attack is a real, `CONFIRMED` one).

`e2e/payments.spec.ts` covers what `bookings.spec.ts`'s happy path doesn't: a failed mock payment
(clicking "Simulate: payment fails") leaves the booking `CANCELLED`, never shows the booking
confirmation screen, and explains clearly that the booking was not confirmed; a `PENDING` mock
payment (clicking "Simulate: still processing") shows a processing state with a "Check again" reload
action, never a premature confirmation; and once a booking is genuinely paid, revisiting its detail
page never renders the payment panel again (the `CONFIRMED` status alone hides it) — proving
duplicate-payment protection is visible in the UI, not just enforced server-side (the deeper
concurrent-duplicate guarantee is proven directly against the API, see below).

### 5. Concurrency and idempotency tests (`apps/api/src/bookings.test.ts`)

Two categories of test exist nowhere else in this codebase, because no earlier milestone had a
genuine race condition to prove correct:

- **The mandatory double-booking race test**: two `Promise.all`-concurrent `POST /api/bookings`
  requests for the exact same provider/slot from two different customers. Asserts exactly one `201`
  and one clean `409` (never two `201`s, never a raw database error surfacing), and then
  independently re-queries the database (via the provider owner's booking list) to confirm exactly
  one `PENDING` booking actually exists for that appointment (bookings start `PENDING`, not
  `CONFIRMED` — see docs/architecture.md, "Booking confirmation rule") — the HTTP responses alone
  aren't trusted as the proof. The same scenario is also verified with real concurrent `curl`
  processes against the live dev server (not just Vitest's in-process request calls), confirming the
  guarantee holds under actual concurrent network requests, not just concurrent JavaScript promises.
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
  `POST /api/bookings/:id/cancel` requests for the same booking — one from the customer,
  one from the provider owner. Asserts exactly one `200` and one `409` (never two `200`s), with the
  booking ending in `CANCELLED`. See docs/architecture.md, "Cancellation race," for why the plain
  read-then-write shape needed the same `SELECT ... FOR UPDATE` treatment as booking creation.
- **10-way concurrency stress test** (`concurrency stress`): strengthens the mandatory double-booking
  race test from 2 to 10 concurrent `POST /api/bookings` requests, from 10 different customers, for
  the exact same provider/service/slot. Asserts exactly one `201` and nine `409`s, and independently
  re-queries the database for exactly one `PENDING` booking — proving the `EXCLUDE` constraint (and
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

### 6. Payment tests (`apps/api/src/payments.test.ts`, `apps/api/src/lib/payment.test.ts`, `apps/api/src/lib/payment-provider.test.ts`)

- **Pure unit tests**: `payment.test.ts` exhaustively tests `canTransitionPaymentStatus`/
  `assertPaymentStatusTransition` for every valid transition and every invalid one (including every
  self-transition and every out-of-terminal-state transition), mirroring `booking.test.ts`'s own
  exhaustive style. `payment-provider.test.ts` tests `MockPaymentProvider` in isolation: every
  scenario (`SUCCESS`/`FAILURE`/`PENDING`) resolves deterministically (never randomly — run 5 times,
  assert the identical result every time), and `verifyWebhook` correctly separates a signature
  failure from a payload-shape failure from a valid event, including proving a signature computed
  with the wrong secret is rejected even though the body itself is well-formed.
- **Creation tests**: the default scenario (`SUCCESS`) confirms the booking; `FAILURE` cancels it;
  `PENDING` leaves it `PENDING`; the amount/currency are always the booking's own values regardless of
  what the client sends; `providerPaymentId` is never exposed in the response; a different customer or
  the provider owner attempting to pay for someone else's/a customer's booking gets `404`; paying for
  an already-`CONFIRMED` or `CANCELLED` booking is rejected with `409`; malformed JSON is rejected;
  retrying while a payment is already `PENDING` returns the SAME payment, not a second one.
- **Idempotency tests**: same key + same booking replays the original payment (`200`); same key +
  a different booking is a `409` conflict; a genuinely concurrent pair of requests sharing one key
  converge on a single payment id. The idempotency pre-check had to be moved BEFORE the payability
  gate during development — the exact same class of ordering bug booking creation's own idempotency
  fix caught, in a different endpoint (see docs/architecture.md, "Idempotency," under Payments).
- **The mandatory concurrency test**: two `Promise.all`-concurrent `POST /api/bookings/:bookingId/payment`
  requests (no idempotency key) for the same booking. Asserts exactly one `201` and one `409`, and
  independently re-queries the database for exactly one `SUCCEEDED` payment and a `CONFIRMED` booking.
- **Webhook tests**: a missing or tampered signature is rejected with `401`; a well-signed but
  malformed/unparseable body is rejected with `400` (proving these are two genuinely separate checks,
  by signing the exact garbage body being sent, not a well-formed one); an oversized body (>64 KB) is
  rejected with `413` before signature verification even runs; an unknown `providerPaymentId` is
  rejected with `404`; a `PENDING` payment is correctly resolved to `SUCCEEDED` (confirming its
  booking) by a webhook constructed with the exported `buildMockWebhookRequest` test helper; the
  identical event delivered 2× and 10×-concurrently produces exactly one applied transition, the rest
  reported as `duplicate: true`; an out-of-order `payment.pending` event arriving after
  `payment.succeeded` already committed does not regress the payment (`applied: false`); a success
  webhook arriving after the booking was independently cancelled leaves the payment `SUCCEEDED` but
  the booking `CANCELLED` (the documented, intentional no-op — see docs/architecture.md).

### 7. Medical records tests (`apps/api/src/medical-records.test.ts`, `apps/api/src/medical-records-security.test.ts`)

Split into two files because the security/audit matrix is large enough to deserve its own file
rather than being woven into the general CRUD tests, unlike every earlier resource — this is the one
feature where authorization and auditability *are* the feature, not a secondary property of it.

- **`medical-records.test.ts`** — the general shape every other resource's test file has: valid
  creation, per-record-type `details` validation (a `VACCINATION` missing `vaccineName` is rejected;
  an unknown key inside `details` is rejected — no arbitrary data dumping ground), oversized-field
  rejection, listing with `recordType`/`includeArchived` filters, `PATCH` amendment (content changes
  accepted, identity fields silently ignored), the archive lifecycle (`ACTIVE -> ARCHIVED`, archiving
  twice is `409`, there is no `DELETE` route at all — asserted both by hitting the endpoint and by
  independently re-querying the database row is still there), and that deleting a pet with medical
  history now returns the same clean `409` deleting one with booking history already did. It also
  proves the deliberate no-admin-bypass decision directly: an admin with no treating relationship
  still gets `404` for an unrelated pet's records.
- **`medical-records-security.test.ts`** — the mandatory authorization matrix and the audit trail,
  each as their own `describe` block:
  - **Authorization matrix**: every scenario the milestone brief calls out by name — customer→own
    pet (allowed), customer→another customer's pet (`404`, never `403`), provider→legitimately
    treated pet (allowed), provider→unrelated pet (`404`), provider A→provider B's pet/record
    (`404`), customer attempting the provider-only create mutation (`403`, not silently allowed),
    a fake `providerId`/`createdByUserId`/`bookingId` each independently rejected or ignored, a
    cross-provider booking (`Provider A + Pet B + a real booking belonging to Provider C`) rejected,
    sequential/random record-id enumeration never disclosing content, `PENDING`/`CANCELLED` bookings
    never establishing a relationship, a co-treating-but-non-authoring provider allowed to *read* but
    denied *writing* to another provider's record, and a pet owner denied both amending and archiving
    a provider-authored record.
  - **Audit trail**: a `MEDICAL_RECORD_CREATED`/`VIEWED`/`UPDATED`/`ARCHIVED` event is written for
    the matching action and attributed to the correct actor; `AUTHORIZATION_DENIED` is written for a
    denied detail-record read without leaking the record's content in the response *or* in the
    audit row's own `metadata`; there is no HTTP route to `PATCH`/`DELETE` an audit log entry
    (`/api/audit-logs/:id` simply doesn't exist — proven by hitting it and getting the app's generic
    `404`); a concurrent create+update+read against the same record produces a fully attributed trail
    queryable by the database's own `id`/`created_at`, never relying on in-process JS ordering.
  - **Historical integrity**: create → read → update preserves `id`/`petId`/`providerId`/
    `createdByUserId`/`createdAt` exactly, with only the intentionally-amended field changed.

### 8. Medical records Playwright specs (`e2e/medical-records.spec.ts`)

Two full real-browser workflows, both built on the same confirmed-booking setup `bookings.spec.ts`
already establishes (provider + service + weekly hours, customer + pet, a slot booked and paid
through the mock provider to `CONFIRMED`):

- **Provider workflow**: from the provider's own bookings panel (never a typed-in pet id), click
  through to the treated pet's medical records, see the empty state, add a `VISIT` record via the
  real form, see it appear in the list — then, from a third, unrelated browser context, prove
  directly against the API that a stranger provider gets `404` for the same pet.
- **Customer workflow**: the provider adds a `VACCINATION` record; the pet's own owner opens their
  pet page and sees it (title, type, and the vaccine-specific summary) with no "Add medical record"
  control ever rendered (read-only enforced in the UI, not just the API) — and a second, unrelated
  customer's own unrelated pet shows neither the record nor even an "Add" control, proving the
  history never leaks across pets that happen to be viewed in the same UI shell.

### 9. Reviews tests (`apps/api/src/reviews.test.ts`, `apps/api/src/reviews-security.test.ts`)

Same split as medical records, for the same reason: the authorization/uniqueness/aggregate
guarantees *are* the feature here, not a secondary property of a CRUD resource.

- **`reviews.test.ts`** — booking completion (`POST /api/bookings/:id/complete`: provider-owner-only,
  `403` for the customer attempting their own booking, `404` for an unrelated caller, `409` for a
  non-`CONFIRMED` booking or completing twice), review creation (valid creation; whitespace-only
  title/comment trimmed to absent, not stored; every rating-validation edge — `0`, `6`, `-1`, `3.5`,
  `999999`; title >150 chars; comment >2000 chars; `PENDING`/`CONFIRMED`/`CANCELLED` bookings all
  rejected with `409`; a duplicate submission rejected with `409` and independently re-verified
  against the database to be exactly one row; mass-assignment of
  `bookingId`/`customerUserId`/`providerId`/`status`/`createdAt` all silently ignored), the mandatory
  concurrent-duplicate-review race test, editing (`PATCH` changes content, identity fields are
  immutable even when the client sends them, empty patch is `400`), the public provider review list
  (`[5,5,4]` -> average `4.67`/count `3`, a zero-review provider gets `averageRating: null` not `0`,
  the provider detail endpoint and the review-list endpoint agree on the same aggregate number), and
  an XSS/adversarial block proving a `<script>` payload round-trips as inert stored text.
- **`reviews-security.test.ts`** — the mandatory authorization matrix named in the milestone brief:
  customer reviews own completed booking (allowed), customer reviews another customer's booking
  (`404`), customer reviews their own cancelled/pending booking (`409` — they already know the
  booking's state, so this isn't a `404`-hiding case), customer reviews someone else's completed
  booking (`404`), a spoofed `providerId`/`customerUserId` in the request body is silently ignored
  (asserted by checking the row that actually got written, not just the HTTP response), the provider
  attempting to review as if they were the customer (`403`), the provider editing a customer's review
  (`404`), a customer editing another customer's review (`404`), sequential/random review-id
  enumeration via `PATCH` never disclosing content, no `DELETE` route exists, an unauthenticated
  caller is rejected on both create and edit, and the public list never contains a
  `customerUserId`/`customerEmail` key anywhere in its response shape. A separate `describe` block
  proves the database constraints hold independent of the API layer: inserting a second review row
  for an already-reviewed `booking_id` directly through Drizzle throws (the `UNIQUE` constraint,
  not application logic); inserting `rating: 0` or `rating: 6` directly throws (the `CHECK`
  constraint); inserting a nonexistent `booking_id` throws (the foreign key).

### 10. Reviews Playwright specs (`e2e/reviews.spec.ts`)

Two full real-browser workflows, both built on a shared setup that goes one step further than
`bookings.spec.ts`'s own confirmed-booking setup: after the booking is paid to `CONFIRMED`, the
provider owner explicitly marks it complete through the real "Mark complete" UI control (accepting
the `window.confirm()` dialog, same pattern `bookings.spec.ts`'s cancel flow already uses) before
either workflow begins.

- **Customer workflow**: on the now-`COMPLETED` booking's detail page, the review panel offers a
  write form (not a read view) with no review yet; selecting 5 stars, filling a title/comment, and
  submitting replaces the write form with a read view of the just-created review (never a duplicate
  form), which survives a full page reload; the provider's public rating headline reflects the new
  `5.00 · 1 review` immediately after.
- **Provider workflow**: the same new review appears in the provider's public reviews section with
  the correct aggregate (`4.00 · 1 review`), and the reviewing customer's email is asserted absent
  from the entire reviews section's rendered text — proving the privacy-minimized display name is
  actually what's shown, not just what the API returns.

A note on a pre-existing timing subtlety these specs deliberately route around: `PaymentPanel`'s
transient "Payment successful." state can, under load, be unmounted (by the booking query's own
invalidation swapping the parent view to the confirmation screen) before Playwright ever observes it
— a genuine race in that shared component, not something introduced by this milestone (confirmed by
reproducing the identical failure against the pre-existing, untouched `bookings.spec.ts` under the
same load). `reviews.spec.ts`'s setup helper asserts the terminal `booking-confirmation` state
directly instead of the intermediate one, which is an equally reliable signal (never reached on a
failed/pending payment — see `payments.spec.ts`) without depending on that race's timing.

### 11. Admin tests (`apps/api/src/admin.test.ts`, `apps/api/src/admin-security.test.ts`)

Same two-file split as medical records and reviews, for the same reason — authorization is the
entire point of this milestone, not a secondary property of a CRUD surface.

- **`admin.test.ts`** — operational correctness: the dashboard's counts are asserted as deltas (`>=
  before + N`, not exact equality — see the note on shared-database parallelism below) after
  creating known providers/bookings/payments, including a dedicated case proving a suspended
  provider is reflected in `suspendedProviders`; the admin provider list sees an `INACTIVE` provider
  public discovery no longer shows, filterable by `status` and searchable by business name; provider
  status changes write a `PROVIDER_STATUS_CHANGED` audit event with the correct
  `previousStatus`/`newStatus`, and mass-assignment of `ownerId`/`createdAt`/an invented
  `internalRole` field is silently ignored; a full suspend-then-verify block confirms a `COMPLETED`
  booking, its payment, and its review are all still present and unchanged after the provider that
  fulfilled them is suspended, that the suspended provider can no longer accept a new booking
  (`409`, via the pre-existing booking-creation check — no new logic needed), and that the owner
  still cannot unsuspend themselves (the pre-existing `assertStatusTransitionAllowed` rule, now
  exercised via the new admin endpoint too); the user list is asserted to expose *exactly*
  `id`/`name`/`role`/`createdAt` and nothing else (an object-keys equality check, not just "no email
  field present" — this would also catch an accidentally-added new field); the booking list resolves
  customer/provider names and a correctly-derived `paymentStatus` (including `NONE` for a booking
  with no payment attempt at all), filterable by status/provider/date-range/payment-status; the
  payment list exposes `providerPaymentId`, which the customer-facing payment endpoint proves (in
  the same test) it does not; review moderation round-trips hide → not public → publish → public
  again with matching `ADMIN_REVIEW_HIDDEN`/`ADMIN_REVIEW_PUBLISHED` audit events whose metadata
  never contains the review's actual content, and hiding an already-hidden review is a clean `409`,
  not a duplicate audit event; the audit list resolves a human-readable `actorName` and is filterable
  by action/resourceType.
- **`admin-security.test.ts`** — the mandatory authorization matrix, generated once as a loop over
  every `/api/admin/*` route group (`dashboard`/`providers`/`users`/`bookings`/`payments`/`reviews`/
  `audit`) asserting anonymous → `401`, customer → `403`, a provider-business-owner (still not an
  `ADMIN` — this codebase's `role` field doesn't grant provider status, ownership of a `providers`
  row does) → `403`, admin → `200` for every one of them, plus dedicated tests for the two mutation
  endpoints (provider status change, review hide) proving the same three non-admin actors are denied
  there too; a role forged in a request body field or an `X-User-Role` header is proven to change
  nothing (the provider's status stays `ACTIVE` and the request still gets `403`); audit-log
  immutability is re-proven specifically through the admin surface (`PATCH`/`DELETE` on
  `/api/admin/audit/:id` are both `404` — the route doesn't exist — even for an authenticated admin);
  a dedicated `describe` block re-verifies the medical-record boundary from three angles (no
  `/api/admin/medical-records` route, no alternate admin path that lists records, and an admin
  without a treating relationship still can't read a specific pet's records through the *existing*
  medical-records API) plus a content-leak check reading a real `MEDICAL_RECORD_CREATED` audit entry
  back through `/api/admin/audit` and asserting the record's actual title/diagnosis text never
  appears in it; filter/search hardening covers a SQL-injection-shaped search string (treated as an
  inert literal, never breaks the query or leaks extra rows), a malformed UUID/date filter (`400`,
  not a raw database error), an oversized search string (`400`, not silently truncated), and an
  absurd `pageSize` (silently clamped to the schema's own bound, same `.catch()` pattern every other
  paginated endpoint in this codebase already uses — never passed through raw to the database); and
  a final block proves there is no way to set a payment's status through any HTTP method on
  `/api/admin/payments/:id`.

A note on the dashboard's delta-based assertions: this codebase's full test suite runs multiple
files with genuine concurrency against one shared Postgres database (see the `playwright.config.ts`
note on the same phenomenon at the E2E layer), so a dashboard test comparing global counts
before/after its own action can't assert exact equality without risking a false failure from another
test file's concurrent activity landing in the same window — these assertions use `>=` specifically
to stay meaningful (the dashboard genuinely is a live query, not a cached/hard-coded number) without
being flaky under real parallel execution.

### 12. Admin Playwright specs (`e2e/admin.spec.ts`)

Three full real-browser workflows. Since there is no API path to become an admin (by design — see
docs/architecture.md), `e2e/db.ts`'s `promoteToAdminByEmail` connects directly to the same Postgres
instance the dev API server uses (via plain `pg`, mirroring `test-helpers.ts`'s own `promoteToAdmin`
for the backend suite) immediately after a fresh registration, then reloads the page so the next
request re-resolves the now-`ADMIN` role from the database rather than trusting anything cached
client-side.

- **Provider suspension workflow**: admin dashboard shows live counts; the providers page finds a
  freshly-created provider by search, suspends it (accepting the confirmation dialog, same pattern
  `bookings.spec.ts`'s cancel flow already uses) and sees it update to `SUSPENDED` in place; the
  dashboard's `activeProviders` count doesn't increase across the action; the audit log page shows
  the resulting `PROVIDER_STATUS_CHANGED` entry; and — the actual point of the whole feature — a
  customer visiting that provider's now-suspended public page gets the same "provider not found" a
  nonexistent provider would, proving suspension's effect through the real customer-facing UI, not
  just the admin panel's own claim that it worked.
- **Review moderation workflow**: a full provider+booking+completion+review setup (reusing the same
  building blocks `reviews.spec.ts` established) produces a real, publicly-visible review; the admin
  hides it, the customer reloads the provider page and it's gone; the audit log shows
  `ADMIN_REVIEW_HIDDEN`; the admin republishes it from the same (deliberately unfiltered) list view,
  the customer reloads and sees it again; the audit log shows `ADMIN_REVIEW_PUBLISHED`. This spec
  intentionally avoids interacting with the status-filter dropdowns mid-workflow — filtering
  correctness is already proven at the API layer, and toggling a filter, then acting on a row, then
  expecting that same row to still be present under a filter it no longer matches is a self-inflicted
  race, not a real product behavior worth chasing in a UI test.
- **Admin security workflow**: a customer navigating to `/admin` is redirected to `/dashboard` and
  never sees an "Admin" nav link at all; a `page.request.get(...)` straight at
  `/api/admin/providers` with that same customer's session gets `403`. A provider-business-owner
  (who creates a real provider first, to prove owning a business still isn't enough) is redirected
  from `/admin` the same way, and a direct call to `/api/admin/audit` with their session also gets
  `403`. Both of these prove the server-side gate independently of whatever the frontend does —
  exactly the "direct API security must also be tested" requirement the milestone brief calls for.

## What "passing" actually means here

Every milestone's final verification runs the *entire* existing suite, not just the new resource's
tests — each report documents the exact test count and pass/fail result actually observed from
running `npm run test` and `npx playwright test`, not an assumption that earlier milestones still
work. Regressions are caught this way: adding availability's `timezone` field to the provider form,
for example, was verified not to break the pre-existing provider-creation E2E tests before being
considered done.
