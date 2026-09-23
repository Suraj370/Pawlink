import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const REQUIRED = { DATABASE_URL: "postgres://user:pass@localhost:5432/db" };

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

describe("loadEnv", () => {
  it("throws when DATABASE_URL is missing", () => {
    withEnv({ DATABASE_URL: undefined, NODE_ENV: "development" }, () => {
      expect(() => loadEnv()).toThrow("Invalid environment configuration");
    });
  });

  it("defaults MOCK_PAYMENT_WEBHOOK_SECRET in development/test", () => {
    withEnv({ ...REQUIRED, NODE_ENV: "development", MOCK_PAYMENT_WEBHOOK_SECRET: undefined }, () => {
      const env = loadEnv();
      expect(env.MOCK_PAYMENT_WEBHOOK_SECRET).toBe("dev-mock-payment-webhook-secret");
    });
  });

  it("rejects the checked-in dev default for MOCK_PAYMENT_WEBHOOK_SECRET in production", () => {
    withEnv({ ...REQUIRED, NODE_ENV: "production", MOCK_PAYMENT_WEBHOOK_SECRET: undefined }, () => {
      expect(() => loadEnv()).toThrow("Invalid environment configuration");
    });
  });

  it("accepts a real MOCK_PAYMENT_WEBHOOK_SECRET and REDIS_URL in production", () => {
    withEnv(
      {
        ...REQUIRED,
        NODE_ENV: "production",
        MOCK_PAYMENT_WEBHOOK_SECRET: "a-real-per-deployment-secret",
        REDIS_URL: "redis://redis:6379",
      },
      () => {
        const env = loadEnv();
        expect(env.NODE_ENV).toBe("production");
      },
    );
  });

  it("defaults REDIS_URL to undefined (rate limiting disabled) outside production", () => {
    withEnv({ ...REQUIRED, NODE_ENV: "development", REDIS_URL: undefined }, () => {
      const env = loadEnv();
      expect(env.REDIS_URL).toBeUndefined();
    });
  });

  it("rejects a production environment with no REDIS_URL configured", () => {
    withEnv(
      {
        ...REQUIRED,
        NODE_ENV: "production",
        MOCK_PAYMENT_WEBHOOK_SECRET: "a-real-per-deployment-secret",
        REDIS_URL: undefined,
      },
      () => {
        expect(() => loadEnv()).toThrow("Invalid environment configuration");
      },
    );
  });

  it("defaults TRUST_PROXY to false when unset", () => {
    withEnv({ ...REQUIRED, NODE_ENV: "development", TRUST_PROXY: undefined }, () => {
      const env = loadEnv();
      expect(env.TRUST_PROXY).toBe(false);
    });
  });

  it("parses TRUST_PROXY=true as boolean true", () => {
    withEnv({ ...REQUIRED, NODE_ENV: "development", TRUST_PROXY: "true" }, () => {
      const env = loadEnv();
      expect(env.TRUST_PROXY).toBe(true);
    });
  });

  // Regression for a real gotcha caught before it ever shipped: z.coerce.boolean()
  // coerces via JS's Boolean(), so the non-empty string "false" would incorrectly
  // become true — exactly backwards from what an operator setting TRUST_PROXY=false
  // would expect. See env.ts's explicit z.preprocess() instead.
  it("parses TRUST_PROXY=false as boolean false, not true", () => {
    withEnv({ ...REQUIRED, NODE_ENV: "development", TRUST_PROXY: "false" }, () => {
      const env = loadEnv();
      expect(env.TRUST_PROXY).toBe(false);
    });
  });

  it("never echoes a secret's actual value in its error output", () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      withEnv({ DATABASE_URL: undefined, NODE_ENV: "production" }, () => {
        expect(() => loadEnv()).toThrow();
      });
    } finally {
      console.error = originalError;
    }
    expect(JSON.stringify(errors)).not.toMatch(/postgres:\/\//);
  });
});
