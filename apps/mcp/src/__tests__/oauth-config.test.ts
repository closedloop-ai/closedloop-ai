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
      expect.stringContaining("MCP_OAUTH_REDIRECT_URIS is empty")
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

describe.sequential("Redirect URI wildcard matching", () => {
  it("matches exact URIs", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com/aip/mcp/callback",
        "https://chatgpt.com/aip/mcp/callback"
      )
    ).toBe(true);
  });

  it("rejects non-matching exact URIs", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "https://evil.com/aip/mcp/callback",
        "https://chatgpt.com/aip/mcp/callback"
      )
    ).toBe(false);
  });

  it("matches wildcard suffix patterns", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com/connector/oauth/KS-YULLcRxJz",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(true);
    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com/connector/oauth/abc123",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(true);
  });

  it("rejects URIs that do not match the wildcard prefix", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com/connector/other/abc123",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(false);
    expect(
      isRedirectUriAllowedByEntry(
        "https://evil.com/connector/oauth/abc123",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(false);
  });

  it("does not treat entries without * as wildcards", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com/aip/mcp/callback/extra",
        "https://chatgpt.com/aip/mcp/callback"
      )
    ).toBe(false);
  });

  it("rejects wildcard when origin differs (different host)", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com.evil.com/connector/oauth/abc",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(false);
  });

  it("rejects wildcard when origin differs (different scheme)", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "http://chatgpt.com/connector/oauth/abc",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(false);
  });

  it("rejects wildcard when origin differs (different port)", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com:8443/connector/oauth/abc",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(false);
  });

  it("rejects wildcard with invalid URIs", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    const mod = await import("../index.js");
    const { isRedirectUriAllowedByEntry } = mod.__testables;

    expect(
      isRedirectUriAllowedByEntry(
        "not-a-url",
        "https://chatgpt.com/connector/oauth/*"
      )
    ).toBe(false);
    expect(
      isRedirectUriAllowedByEntry(
        "https://chatgpt.com/connector/oauth/abc",
        "not-a-url/*"
      )
    ).toBe(false);
  });
});
