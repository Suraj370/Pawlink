import type { PublicUser } from "@pawlink/shared";

export type AppVariables = {
  user: PublicUser;
};

export type AppEnv = {
  Variables: AppVariables;
};
