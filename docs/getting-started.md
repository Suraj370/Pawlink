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
- `routes/_authenticated/dashboard.tsx` — the only protected route implemented in this milestone.

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

## Ky architecture

- `lib/api/client.ts` — the single Ky instance (`apiClient`), configured with `prefixUrl`
  (`VITE_API_URL`) and `credentials: "include"`. No other file constructs an HTTP request.
- `lib/api/errors.ts` — `toErrorMessage()` unwraps Ky's `HTTPError` and extracts the API's
  `{ error: string }` JSON body so the UI can show a real message instead of a generic failure.
- Feature API functions (`features/auth/api.ts`, `features/system/api.ts`) call `apiClient` and are
  the only things TanStack Query hooks call — components never touch `apiClient` or `fetch`
  directly.
