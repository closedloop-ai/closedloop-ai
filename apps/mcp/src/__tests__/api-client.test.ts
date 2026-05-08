import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe.sequential("ApiClient", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      INTERNAL_API_SECRET: "test-internal-secret",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("unwraps ApiResult success envelopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: true, data: [{ id: "a1" }] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
      )
    );

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await expect(
      client.get<Array<{ id: string }>>("/artifacts")
    ).resolves.toEqual([{ id: "a1" }]);
  });

  it("throws when success envelope is missing data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await expect(client.get("/artifacts")).rejects.toThrow(
      "API returned success without data"
    );
  });

  it("throws when ApiResult reports failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, error: "Organization not found" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
      )
    );

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await expect(client.get("/artifacts")).rejects.toThrow(
      "Organization not found"
    );
  });

  it("preserves structured ApiResult failure metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "PROCESS_FAILED",
              details: {
                action: "commit",
                category: "pre_commit_hook",
                stderrExcerpt: "lint failed",
              },
              error: "Pre-commit hook failed",
              success: false,
              timestamp: "2026-05-08T12:00:00.000Z",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
      )
    );

    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await expect(client.get("/artifacts")).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      details: {
        action: "commit",
        category: "pre_commit_hook",
        stderrExcerpt: "lint failed",
      },
      message: "Pre-commit hook failed",
      timestamp: "2026-05-08T12:00:00.000Z",
    });
    await expect(client.get("/artifacts")).rejects.toBeInstanceOf(McpApiError);
  });

  it("surfaces structured ApiResult errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: {
                code: "FORBIDDEN",
                message: "Forbidden for organization",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
      )
    );

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await expect(client.get("/artifacts")).rejects.toThrow(
      "Forbidden for organization"
    );
  });

  it("passes through non-enveloped JSON payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([{ id: "legacy" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await expect(
      client.get<Array<{ id: string }>>("/artifacts")
    ).resolves.toEqual([{ id: "legacy" }]);
  });

  it("falls back to default timeout when MCP_VERIFY_API_KEY_TIMEOUT_MS is invalid", async () => {
    process.env.MCP_VERIFY_API_KEY_TIMEOUT_MS = "not-a-number";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { userId: "u1", organizationId: "o1", scopes: ["read"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const { verifyApiKey } = await import("../api-client.js");
    // Should not throw RangeError from AbortSignal.timeout(NaN)
    await expect(verifyApiKey("sk_live_test123")).resolves.toEqual({
      userId: "u1",
      organizationId: "o1",
      scopes: ["read"],
    });

    const requestInit = fetchSpy.mock.calls[0]?.[1];
    expect(requestInit?.signal).toBeDefined();
  });

  it("falls back to default timeout when MCP_VERIFY_API_KEY_TIMEOUT_MS is negative", async () => {
    process.env.MCP_VERIFY_API_KEY_TIMEOUT_MS = "-5000";

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { userId: "u1", organizationId: "o1", scopes: ["read"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const { verifyApiKey } = await import("../api-client.js");
    await expect(verifyApiKey("sk_live_test123")).resolves.toEqual({
      userId: "u1",
      organizationId: "o1",
      scopes: ["read"],
    });
  });
});
