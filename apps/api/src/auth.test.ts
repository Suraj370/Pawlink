import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestApp, uniqueEmail } from "./test-helpers.js";
import { users } from "./db/schema.js";

const { app, db } = createTestApp();

function getSetCookie(res: Response): string | undefined {
  return res.headers.get("set-cookie") ?? undefined;
}

function extractCookieValue(setCookieHeader: string): string {
  const [pair] = setCookieHeader.split(";");
  return pair;
}

async function registerUser(overrides: Partial<Record<string, string>> = {}) {
  const body = {
    name: "Test User",
    email: uniqueEmail(),
    phone: "5551234567",
    password: "correct-horse-battery",
    ...overrides,
  };
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body };
}

const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEmails.length === 0) return;
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
});

describe("POST /api/auth/register", () => {
  it("registers a new user and returns it without a password hash", async () => {
    const { res, body } = await registerUser();
    createdEmails.push(body.email);

    expect(res.status).toBe(201);
    const json = (await res.json()) as { user: Record<string, unknown> };
    expect(json.user.email).toBe(body.email);
    expect(json.user.role).toBe("PET_PARENT");
    expect(json.user).not.toHaveProperty("passwordHash");
    expect(json.user).not.toHaveProperty("password_hash");
    expect(JSON.stringify(json)).not.toContain("password");
    expect(getSetCookie(res)).toBeTruthy();
  });

  it("rejects a duplicate email", async () => {
    const { body } = await registerUser();
    createdEmails.push(body.email);

    const second = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, name: "Someone Else" }),
    });

    expect(second.status).toBe(409);
    const json = (await second.json()) as { error: string };
    expect(json.error).toBeTruthy();
  });

  it("rejects an invalid email", async () => {
    const { res } = await registerUser({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects a short password", async () => {
    const { res } = await registerUser({ password: "short" });
    expect(res.status).toBe(400);
  });

  it("ignores a client-supplied role and always assigns PET_PARENT", async () => {
    const email = uniqueEmail();
    createdEmails.push(email);
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Would Be Admin",
        email,
        phone: "5551234567",
        password: "correct-horse-battery",
        role: "ADMIN",
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { user: { role: string } };
    expect(json.user.role).toBe("PET_PARENT");
  });

  it("rejects malformed JSON", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials", async () => {
    const { body } = await registerUser();
    createdEmails.push(body.email);

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: body.email, password: body.password }),
    });

    expect(res.status).toBe(200);
    expect(getSetCookie(res)).toBeTruthy();
    const json = (await res.json()) as { user: { email: string } };
    expect(json.user.email).toBe(body.email);
  });

  it("rejects an incorrect password", async () => {
    const { body } = await registerUser();
    createdEmails.push(body.email);

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: body.email, password: "wrong-password" }),
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).not.toMatch(/user|exist/i);
  });

  it("rejects a nonexistent user with the same generic error", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: uniqueEmail("ghost"), password: "whatever123" }),
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid email or password");
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without authentication", async () => {
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns the current user when authenticated", async () => {
    const { res: registerRes, body } = await registerUser();
    createdEmails.push(body.email);
    const cookie = extractCookieValue(getSetCookie(registerRes)!);

    const res = await app.request("/api/auth/me", {
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { user: { email: string } };
    expect(json.user.email).toBe(body.email);
  });

  it("rejects an invalid/garbage session cookie", async () => {
    const res = await app.request("/api/auth/me", {
      headers: { cookie: "pawlink_session=not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session so /me subsequently fails", async () => {
    const { res: registerRes, body } = await registerUser();
    createdEmails.push(body.email);
    const cookie = extractCookieValue(getSetCookie(registerRes)!);

    const logoutRes = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(logoutRes.status).toBe(200);

    const meRes = await app.request("/api/auth/me", {
      headers: { cookie },
    });
    expect(meRes.status).toBe(401);
  });
});
