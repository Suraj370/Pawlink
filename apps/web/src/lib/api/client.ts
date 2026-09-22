import ky from "ky";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

// Every request carries the session cookie; the API is the sole source of
// truth for authentication state, never localStorage or client state.
export const apiClient = ky.create({
  prefixUrl: API_URL,
  credentials: "include",
  headers: {
    Accept: "application/json",
  },
  retry: 0,
});
