import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client.js", () => {
  return {
    verifyApiKey: vi.fn(),
    checkApiReachable: vi.fn(),
    createApiClient: vi.fn(() => ({})),
  };
});

vi.mock("@repo/database", () => {
  const withDb = Object.assign(
    async <T>(fn: (db: Record<string, never>) => Promise<T> | T): Promise<T> =>
      fn({}),
    {
      tx: async <T>(
        fn: (db: Record<string, never>) => Promise<T>
      ): Promise<T> => fn({}),
    }
  );
  return { withDb };
});

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe.sequential("OAuth config", () => {
  it("requires redirect allowlist in production", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.WEBAPP_ENV = "stage";
    process.env.MCP_OAUTH_REDIRECT_URIS = "";
    const mod = await import("../index.js");
    expect(() =>
      mod.__testables.requireRedirectAllowlistForEnvironment()
    ).toThrow("MCP_OAUTH_REDIRECT_URIS must be set in non-local environments");
  });

  it("allows startup in production when redirect allowlist is set", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.WEBAPP_ENV = "stage";
    process.env.MCP_OAUTH_REDIRECT_URIS =
      "https://app.example.com/oauth/callback";
    const mod = await import("../index.js");
    expect(() =>
      mod.__testables.requireRedirectAllowlistForEnvironment()
    ).not.toThrow();
  });

  it("requires internal IP allowlist in non-local env", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.WEBAPP_ENV = "stage";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "";
    const mod = await import("../index.js");
    expect(() =>
      mod.__testables.requireInternalAllowlistForEnvironment()
    ).toThrow("MCP_INTERNAL_ALLOWED_IPS must be set in non-local environments");
  });
});
