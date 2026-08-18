import { afterEach, describe, expect, it, vi } from "vitest";

// index.ts routes its allowlist warnings/errors through @repo/observability/log
// (FEA-3661). The logger captures console refs at module-init, so a console spy
// installed after import can't observe them — assert on the mocked logger.
const { logWarn, logError } = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: logError,
    flush: vi.fn(),
  },
}));

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
    logWarn.mockClear();
    const mod = await import("../index.js");
    expect(() =>
      mod.__testables.requireRedirectAllowlistForEnvironment()
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("MCP_OAUTH_REDIRECT_URIS is empty")
    );
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
    logError.mockClear();
    const mod = await import("../index.js");
    expect(() =>
      mod.__testables.requireInternalAllowlistForEnvironment()
    ).not.toThrow();
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("[SECURITY WARNING]")
    );
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
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

  // -------------------------------------------------------------------------
  // isAddressInCidr — malformed CIDR entries (L1107, L1111, L1117)
  //
  // isAddressInCidr is reachable through isInternalAddressAllowed when
  // MCP_INTERNAL_ALLOWED_IPS contains a CIDR entry (one with "/").  These
  // tests exercise the three early-return guard branches.
  // -------------------------------------------------------------------------

  it("returns false for a CIDR with empty prefix length (trailing slash only)", async () => {
    // "10.0.0.0/" → split gives prefixLengthRaw = "" (falsy) → L1107 branch.
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "10.0.0.0/";
    const mod = await import("../index.js");
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
  });

  it("returns false for a CIDR with a non-integer prefix length", async () => {
    // "10.0.0.0/abc" → parseInt("abc") = NaN → !isFinite → L1111 branch.
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "10.0.0.0/abc";
    const mod = await import("../index.js");
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
  });

  it("returns false for a CIDR with a negative prefix length", async () => {
    // "10.0.0.0/-1" → prefixLength < 0 → L1111 branch.
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "10.0.0.0/-1";
    const mod = await import("../index.js");
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
  });

  it("returns false for a CIDR with a prefix length greater than 32", async () => {
    // "10.0.0.0/33" → prefixLength > 32 → L1111 branch.
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "10.0.0.0/33";
    const mod = await import("../index.js");
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
  });

  it("returns false when the CIDR base address is not a valid IPv4 address", async () => {
    // "not-an-ip/24" → ipv4ToNumber("not-an-ip") = null → L1117 branch.
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "not-an-ip/24";
    const mod = await import("../index.js");
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
  });

  it("returns false when checking a non-IPv4 address against a valid CIDR", async () => {
    // IPv6 address "::1" → ipv4ToNumber("::1") = null → L1117 branch.
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "10.0.0.0/24";
    const mod = await import("../index.js");
    expect(mod.__testables.isInternalAddressAllowed("::1")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // isInternalAddressAllowed — loopback fallback in local environment (L1155)
  //
  // When no allowlist is configured and NODE_ENV=test (set by Vitest),
  // loopback addresses are the only ones accepted.
  // -------------------------------------------------------------------------

  it("allows localhost, 127.0.0.1, and ::1 when no allowlist is configured and env is local", async () => {
    // NODE_ENV=test (set by Vitest) + no WEBAPP_ENV → isLocalOauthEnvironment() = true.
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_INTERNAL_ALLOWED_IPS = "";
    const mod = await import("../index.js");

    expect(mod.__testables.isInternalAddressAllowed("localhost")).toBe(true);
    expect(mod.__testables.isInternalAddressAllowed("127.0.0.1")).toBe(true);
    expect(mod.__testables.isInternalAddressAllowed("::1")).toBe(true);
    expect(mod.__testables.isInternalAddressAllowed("10.0.0.1")).toBe(false);
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
