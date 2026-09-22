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

## Development

```bash
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173
```

## Testing

```bash
npm run test           # backend unit tests (Vitest)
npm run test:e2e       # end-to-end tests (Playwright)
npm run typecheck      # TypeScript checks across all workspaces
```
