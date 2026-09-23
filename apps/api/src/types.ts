import type { PublicUser } from "@pawlink/shared";

export type AppVariables = {
  user: PublicUser;
  // Set by createRequestId (middleware/requestId.ts) on every request —
  // present before any route handler runs, so it's always safe to read.
  requestId: string;
};

export type AppEnv = {
  Variables: AppVariables;
};
