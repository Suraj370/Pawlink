# Built from the REPO ROOT context (this is an npm-workspaces monorepo —
# apps/api depends on packages/shared, so a build needs the whole tree,
# not just apps/api in isolation). Build with:
#
#   docker build -f apps/api/Dockerfile -t pawlink-api .
#
# See docker-compose.prod.yml for how this fits into the full stack.

FROM node:20-alpine AS deps
WORKDIR /app
# Only manifests first — maximizes Docker layer-cache hits: source
# changes never invalidate this layer, only a dependency change does.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# Deterministic install (see the milestone brief's "deterministic
# install") — npm ci, never npm install, and always from the committed
# lockfile. --ignore-scripts: the root package.json's own postinstall
# builds packages/shared, but only manifests exist in this stage (no
# source, no tsconfig) — that build happens explicitly below, in the
# "build" stage, once the real source has been copied in.
RUN npm ci --ignore-scripts

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY package-lock.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/api \
 # Strip devDependencies from the workspace-hoisted node_modules now
 # that the TypeScript build no longer needs them — the runtime image
 # only ever ships production dependencies.
 && npm prune --omit=dev

# ---------------------------------------------------------------------
# Runtime — minimal: only the compiled output, production
# node_modules, and the two package.json files npm's workspace symlink
# resolution needs at require-time. No source (.ts), no devDependencies,
# no test files, no .env of any kind (secrets are injected as real
# environment variables by the orchestrator — see docker-compose.prod.yml
# — never baked into the image).
# ---------------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/api/package.json apps/api/package.json

# A safe, non-secret build identifier — see lib/version.ts and
# docs/architecture.md, "Deployment version." Passed as a build arg so
# CI/the deploy script can set it to the real commit SHA
# (--build-arg APP_VERSION=$(git rev-parse HEAD)); defaults to "unknown"
# rather than silently claiming to be "dev" when nobody set it, so a
# missing build arg is visibly wrong instead of looking like a local
# dev build.
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}

# node:20-alpine already ships a non-root "node" user (uid 1000) — reuse
# it rather than inventing a new one.
USER node

EXPOSE 3000

# A real HTTP check against the lightweight liveness endpoint (never
# /ready, which touches the database — see app.ts's comment on why
# health checks stay cheap). wget is already present in node:alpine;
# no extra package needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

# Exec form — PID 1 is node directly, so it receives and forwards
# SIGTERM correctly for a clean shutdown (no shell wrapping the
# process, which would otherwise swallow the signal — see the milestone
# brief's "correct signal handling").
CMD ["node", "apps/api/dist/index.js"]
