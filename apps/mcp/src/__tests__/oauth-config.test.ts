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
  it("allows startup in production without redirect allowlist (loopback-only)", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.WEBAPP_ENV = "stage";
    process.env.MCP_OAUTH_REDIRECT_URIS = "";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../index.js");
    expect(() =>
      mod.__testables.requireRedirectAllowlistForEnvironment()
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("default OpenAI callback allowlist")
    );
    warnSpy.mockRestore();
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

  it("allows ChatGPT callback redirect URI in production when allowlist is unset", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.WEBAPP_ENV = "stage";
    process.env.MCP_OAUTH_REDIRECT_URIS = "";
    const mod = await import("../index.js");

    expect(
      mod.__testables.isValidRedirectUri("https://chatgpt.com/aip/mcp/callback")
    ).toBe(true);
    expect(
      mod.__testables.isValidRedirectUri(
        "https://chat.openai.com/aip/mcp/callback"
      )
    ).toBe(true);
    expect(
      mod.__testables.isValidRedirectUri(
        "https://chatgpt.com/connector/oauth/0AOLizd_UNO2"
      )
    ).toBe(true);
    expect(
      mod.__testables.isValidRedirectUri(
        "https://chat.openai.com/connector/oauth/abc123"
      )
    ).toBe(true);
    expect(
      mod.__testables.isValidRedirectUri(
        "https://chatgpt.com/connector/other/0AOLizd_UNO2"
      )
    ).toBe(false);
    expect(
      mod.__testables.isValidRedirectUri("https://example.com/oauth/callback")
    ).toBe(false);
  });

  it("allows startup in non-local env without internal IP allowlist but rejects requests", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.WEBAPP_ENV = "stage";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("../index.js");
    expect(() =>
      mod.__testables.requireInternalAllowlistForEnvironment()
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[SECURITY WARNING]")
    );
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
    errorSpy.mockRestore();
  });

  it("supports exact IP and CIDR entries in internal allowlist", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.WEBAPP_ENV = "stage";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "10.0.0.0/16,192.168.1.10";
    const mod = await import("../index.js");

    expect(mod.__testables.isInternalAddressAllowed("10.0.5.20")).toBe(true);
    expect(mod.__testables.isInternalAddressAllowed("192.168.1.10")).toBe(true);
    expect(mod.__testables.isInternalAddressAllowed("10.1.0.1")).toBe(false);
    expect(mod.__testables.isInternalAddressAllowed("192.168.1.11")).toBe(
      false
    );
  });
});
