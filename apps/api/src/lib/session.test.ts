import { describe, expect, it } from "vitest";
import { sessionCookieOptions } from "./session.js";

describe("sessionCookieOptions", () => {
  // Production serves the frontend and API from different registrable
  // domains (e.g. Vercel + Render), making every API call cross-site.
  // SameSite=Lax cookies are never sent on cross-site fetch/XHR, only
  // top-level navigations — so the session cookie must be SameSite=None
  // in production, or the very next request after login (and every
  // request after a page refresh) would look unauthenticated. See this
  // function's own comment for the full story.
  it("uses SameSite=None and Secure in production, for cross-site API calls", () => {
    const options = sessionCookieOptions("production");
    expect(options.sameSite).toBe("None");
    expect(options.secure).toBe(true);
  });

  // SameSite=None without Secure is rejected outright by browsers — this
  // combination must never occur.
  it("never pairs SameSite=None with a non-secure cookie", () => {
    for (const env of ["development", "test", "production"]) {
      const options = sessionCookieOptions(env);
      if (options.sameSite === "None") {
        expect(options.secure).toBe(true);
      }
    }
  });

  it("uses the stricter SameSite=Lax outside production, where localhost ports are same-site", () => {
    expect(sessionCookieOptions("development").sameSite).toBe("Lax");
    expect(sessionCookieOptions("test").sameSite).toBe("Lax");
  });
});
