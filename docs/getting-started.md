# PawLink — Getting Started

## Prerequisites

- Node.js 20+
- Docker (for local PostgreSQL)

## Setup

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
npm run db:up
npm run db:generate --workspace apps/api
npm run db:migrate
```

## Environment variables

`apps/api/.env`:

| Variable        | Default                                              | Notes                                                              |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`      | `development`                                          | `production` enables the `Secure` flag on the session cookie.      |
| `PORT`          | `3000`                                                 | API listen port.                                                   |
| `DATABASE_URL`  | `postgres://pawlink:pawlink@localhost:5432/pawlink`    | Must match `docker-compose.yml` credentials for local dev.         |
| `WEB_ORIGIN`    | `http://localhost:5173`                                | The single origin allowed by CORS; the frontend's dev server URL.  |
| `MOCK_PAYMENT_WEBHOOK_SECRET` | `dev-mock-payment-webhook-secret`        | Signs/verifies the mock payment provider's webhooks only — not a real payment credential; see [docs/architecture.md](architecture.md). |

`apps/web/.env`:

| Variable        | Default                 | Notes                    |
| --------------- | ------------------------ | ------------------------- |
| `VITE_API_URL`  | `http://localhost:3000`  | Base URL used by the Ky client. |

## Development

```bash
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173
```

## Database

```bash
npm run db:up         # start Postgres via Docker Compose
npm run db:generate --workspace apps/api   # generate a Drizzle migration from schema.ts
npm run db:migrate                          # apply pending migrations
npm run db:down        # stop Postgres
```

Migrations live in `apps/api/drizzle/`.

## Testing

```bash
npm run test           # backend unit/integration tests (Vitest) — requires Postgres running and migrated
npm run test:e2e       # end-to-end tests (Playwright) — requires Postgres running and migrated
npm run typecheck      # TypeScript checks across all workspaces
npm run build          # production build of all workspaces
```

The Playwright config (`playwright.config.ts`) starts both the API (`npm run dev --workspace apps/api`)
and the web app (`npm run dev --workspace apps/web`) automatically, but it cannot start PostgreSQL —
make sure `npm run db:up` and `npm run db:migrate` have been run first.

## Authentication architecture

- **Session storage**: opaque, cryptographically random tokens (32 bytes, base64url), issued on
  register/login. Only a SHA-256 hash of the token is stored server-side, in the `sessions` table —
  reading the database can never yield a usable credential.
- **Browser transport**: the token is set as an `httpOnly`, `SameSite=Lax` cookie
  (`pawlink_session`), `Secure` in production. The frontend never reads or stores it — Ky is
  configured with `credentials: "include"` so the browser attaches it automatically. This is
  chosen over an `Authorization` header / localStorage token specifically so client-side script
  (including any XSS) can't read or exfiltrate the credential.
- **Logout**: deletes the corresponding session row and clears the cookie. `POST /api/auth/logout`
  succeeds even if the session is already invalid/expired.
- **Protected API routes**: `requireAuth` middleware (`apps/api/src/middleware/auth.ts`) reads the
  cookie, hashes it, looks up the session, checks expiry, loads the user, and attaches it to the
  request context. Missing/invalid/expired sessions get a `401`.
  - Sessions are fixed-TTL (7 days) with no sliding refresh in this milestone — a user session
    expires exactly 7 days after login/registration regardless of activity. Documented as a known
    limitation.
- **Surviving refresh**: because the session lives in an httpOnly cookie (not JS-accessible state),
  a page refresh doesn't lose authentication — the frontend just re-runs `GET /api/auth/me` on load.
- **Password hashing**: bcryptjs, cost factor 12. Passwords are capped at 72 characters
  (`registerSchema`/`loginSchema` in `packages/shared`) because bcrypt silently truncates beyond 72
  bytes — capping in validation avoids that footgun rather than allowing a longer password to
  silently become a shorter effective one.
- **Roles**: `PET_PARENT`, `VET`, `GROOMER`, `BOARDING_PROVIDER`, `ADMIN`. Public registration
  (`POST /api/auth/register`) never accepts a client-supplied role — the Zod `registerSchema` has
  no `role` field at all, and the insert always assigns the column default (`PET_PARENT`).
  Assigning other roles (e.g. promoting a user to `VET` or `ADMIN`) is intentionally out of scope
  for this milestone and will be an admin-only capability added later.

## TanStack Router architecture

File-based routing (`apps/web/src/routes/`), route tree generated at build/dev time by
`@tanstack/router-plugin/vite` into `apps/web/src/routeTree.gen.ts` (generated file, not hand-edited).

- `routes/__root.tsx` — root layout, provides router context (`{ queryClient }`).
- `routes/index.tsx` — public landing page; also proves the health-check integration.
- `routes/login.tsx`, `routes/register.tsx` — public; redirect to `/dashboard` if already
  authenticated (checked via `beforeLoad` + `queryClient.ensureQueryData`).
- `routes/_authenticated/route.tsx` — pathless layout route. Its `beforeLoad` calls
  `queryClient.ensureQueryData(authMeQueryOptions)`; on failure it `throw redirect({ to: "/login" })`
  before the child route ever renders. This is the single place authentication is enforced for
  protected routes — child routes don't each re-implement the check.
- `routes/_authenticated/dashboard.tsx` — authenticated landing page.
- `routes/_authenticated/pets/index.tsx`, `routes/_authenticated/pets/$petId.tsx` — pet management;
  always private (a pet parent's own pets are never public data), so these live under the
  authenticated layout.
- `routes/providers/index.tsx`, `routes/providers/$providerId.tsx` — provider directory and
  details. Deliberately **not** under `_authenticated`, since provider discovery is public by
  design; owner-only controls (add/edit/deactivate a provider, and — on the details page — add/
  edit/deactivate its services) are gated inline on the server-computed `isOwner` flag rather than
  by route protection.

## TanStack Query architecture

- `lib/query-client.ts` — the single `QueryClient` instance, passed into both `QueryClientProvider`
  and the router's context.
- `features/auth/api.ts` exports `authMeQueryOptions` (`queryOptions({ queryKey: ["auth", "me"], queryFn: getCurrentUser, retry: false })`),
  shared between `useCurrentUser()` (component use) and the route guards' `ensureQueryData` calls —
  one query definition, not duplicated logic.
- `features/auth/hooks.ts` wraps mutations: `useLogin`/`useRegister` write the returned user
  straight into the `["auth", "me"]` cache (`setQueryData`) instead of forcing a refetch;
  `useLogout` removes it (`removeQueries`) so the next `ensureQueryData` call is forced to hit the
  API again and correctly gets a 401.
- `features/system/api.ts` / `hooks.ts` — the same pattern for the public `GET /health` check shown
  on the landing page.
- `features/pets/`, `features/providers/`, `features/services/` follow the identical
  api.ts/hooks.ts/schemas.ts/components shape. Query keys: `["pets"]` / `["pets", petId]`,
  `["providers", filters]` / `["providers", providerId]`, and
  `["providers", providerId, "services"]` / `["providers", providerId, "services", serviceId]` —
  the services keys are nested under their parent provider's id on purpose, so invalidating
  `["providers", providerId, "services"]` after a service mutation can never accidentally touch a
  different provider's service list. Every list query's filters are part of its key (see
  `providersQueryOptions(filters)`), so two different filter combinations are cached separately.

## Ky architecture

- `lib/api/client.ts` — the single Ky instance (`apiClient`), configured with `prefixUrl`
  (`VITE_API_URL`) and `credentials: "include"`. No other file constructs an HTTP request.
- `lib/api/errors.ts` — `toErrorMessage()` unwraps Ky's `HTTPError` and extracts the API's
  `{ error: string }` JSON body so the UI can show a real message instead of a generic failure.
- Feature API functions (`features/{auth,system,pets,providers,services}/api.ts`) call `apiClient`
  and are the only things TanStack Query hooks call — components never touch `apiClient` or
  `fetch` directly (verified by grep as part of every milestone's verification step).

## Pet management architecture

- `pets` table: `owner_id` (FK → `users.id`, `ON DELETE CASCADE`, indexed). A pet belongs to
  exactly one owner, derived solely from the session — `createPetSchema` has no `ownerId` field.
- `GET/POST/PATCH/DELETE /api/pets*` all require authentication and are scoped by
  `(id AND owner_id)`. A pet that exists but belongs to someone else returns `404`, identical to a
  nonexistent id — never `403` — so a non-owner can't tell "not yours" from "doesn't exist".
- `DELETE` is a real row delete (unlike providers/services below) — a pet has no downstream
  entities referencing it yet in this codebase, so there's no historical-record reason to soft
  delete it.

## Provider management architecture

- `providers` table: `owner_user_id` (FK → `users.id`, cascade, indexed), plus indexes on
  `provider_type`, `status`, and `city` for the public discovery query's filters.
- `GET /api/providers` and `GET /api/providers/:id` are **public**; `POST`/`PATCH`/`DELETE`
  require authentication and ownership (or an admin).
- Public responses never include the raw `owner_user_id` — a computed `isOwner` boolean (true only
  for the authenticated owner or an admin) lets the UI show/hide Edit/Deactivate controls without
  the foreign key ever leaving the server.
- **Status model**: `ACTIVE` / `INACTIVE` / `SUSPENDED`. An owner may freely toggle their own
  provider between `ACTIVE` and `INACTIVE`. `SUSPENDED` is admin-only in two independent layers:
  the owner-facing Zod schema doesn't even accept `SUSPENDED` as a legal shape, and
  `assertStatusTransitionAllowed()` additionally blocks anyone but an admin from changing the
  status of an already-`SUSPENDED` provider (closing the "owner just sets `ACTIVE` to un-suspend
  themselves" loophole).
- `DELETE /api/providers/:id` is a **soft deactivation** (`status -> INACTIVE`), not a row delete —
  see Service management below for why this matters once services exist under a provider.
- Public discovery (`GET /api/providers`) only ever returns `ACTIVE` providers; any client-supplied
  `status` filter is ignored for non-owner/non-admin requests, so a stranger can't use it to
  enumerate `INACTIVE`/`SUSPENDED` listings.

## Service management architecture

- `services` table, nested under a provider: `provider_id` (FK → `providers.id`, cascade),
  indexed on `provider_id` alone and on the composite `(provider_id, active)` — the latter covers
  the exact predicate public discovery uses. `duration_minutes > 0` and `price_minor >= 0` are
  enforced as **Postgres CHECK constraints**, not just Zod, so even a direct/buggy write can't
  violate them (verified against a live database — see the migration for details).
- **No unique constraint on `(provider_id, name)`** — a deliberate decision: a provider may
  legitimately want to reuse a name after deactivating an earlier variant (e.g. a seasonal
  offering), and since deactivation is soft, a hard uniqueness constraint would fight the
  deactivate-then-recreate workflow for no real data-integrity benefit.
- **Money representation**: prices are stored and transmitted as `priceMinor`, an **integer** count
  of the currency's smallest unit (₹799.00 → `79900` paise) — never a float, so no floating-point
  rounding can creep into a persisted price. The frontend's only decimal-string ↔ integer
  conversion (`features/services/money.ts`) is done with string splitting and integer arithmetic,
  deliberately avoiding any decimal float multiplication even at the input boundary.
- Nested routes: `GET/POST /api/providers/:providerId/services`,
  `GET/PATCH/DELETE /api/providers/:providerId/services/:serviceId`. Every service lookup is
  scoped by **both** `id` and `provider_id` together — this is the direct defense against a
  service id from one provider being reachable through a different provider's URL segment
  (`/providers/provider-B-id/services/service-from-provider-A-id` resolves to nothing, even though
  the service id itself is real).
- Ownership of the *provider* (not a separate service-level owner field) gates every mutation —
  `createServiceSchema` has no `providerId` field at all; it comes solely from the URL, and that
  provider's ownership is checked against the session before the request body is even parsed.
- `DELETE` is a **soft deactivation** (`active -> false`), not a row delete — the future booking
  system will need to reference the exact service a customer selected, and a hard delete would
  make that historical reference impossible to preserve. Reactivation is
  `PATCH { active: true }`, not a separate endpoint.
- Public discovery shows only active services of an active, publicly-visible provider; the
  provider owner (or an admin) additionally sees their own inactive services in the same list
  response, for their management view.
