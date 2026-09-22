import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { LoginInput, PublicUser, RegisterInput } from "./schemas";

type UserResponse = { user: PublicUser };

export async function register(input: RegisterInput): Promise<PublicUser> {
  const { user } = await apiClient.post("api/auth/register", { json: input }).json<UserResponse>();
  return user;
}

export async function login(input: LoginInput): Promise<PublicUser> {
  const { user } = await apiClient.post("api/auth/login", { json: input }).json<UserResponse>();
  return user;
}

export async function logout(): Promise<void> {
  await apiClient.post("api/auth/logout");
}

export async function getCurrentUser(): Promise<PublicUser> {
  const { user } = await apiClient.get("api/auth/me").json<UserResponse>();
  return user;
}

export const authMeQueryOptions = queryOptions({
  queryKey: ["auth", "me"] as const,
  queryFn: getCurrentUser,
  retry: false,
});
