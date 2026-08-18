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

  it("appends array query values as repeated parameters", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await client.get("/artifact-links/parents", {
      targetIds: ["doc-1", "doc-2"],
      linkType: "PRODUCES",
    });

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.getAll("targetIds")).toEqual([
      "doc-1",
      "doc-2",
    ]);
    expect(requestedUrl.searchParams.get("linkType")).toBe("PRODUCES");
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

  it("bounds every CRUD request with the default AbortSignal deadline", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: { id: "a1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await client.get("/artifacts");
    await client.post("/artifacts", { name: "x" });
    await client.put("/artifacts/a1", { name: "x" });
    await client.patch("/artifacts/a1", { name: "x" });
    await client.delete("/artifacts/a1");

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
    // The deadline actually reaches AbortSignal.timeout at the default 30s.
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("honors a valid MCP_API_REQUEST_TIMEOUT_MS override", async () => {
    process.env.MCP_API_REQUEST_TIMEOUT_MS = "5000";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: { id: "a1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    await client.get("/artifacts");
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
  });

  it.each([
    ["not a number", "not-a-number"],
    ["fractional", "12.5"],
    ["negative", "-5000"],
    ["above the timer range", String(2 ** 31)],
  ])("falls back to the default CRUD timeout when MCP_API_REQUEST_TIMEOUT_MS is %s", async (_label, value) => {
    process.env.MCP_API_REQUEST_TIMEOUT_MS = value;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: { id: "a1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createApiClient } = await import("../api-client.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );

    // A rejected env value must not make AbortSignal.timeout throw a
    // RangeError before fetch starts; it falls back to the 30s default.
    await expect(client.get("/artifacts")).resolves.toEqual({ id: "a1" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("throws during module initialization when INTERNAL_API_SECRET is not set", async () => {
    delete process.env.INTERNAL_API_SECRET;
    await expect(import("../api-client.js")).rejects.toThrow(
      "INTERNAL_API_SECRET environment variable is required but not set"
    );
  });

  it("throws McpApiError with the raw body appended when a GET response is not ok and the body is non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          })
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    const error = await client.get("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpApiError);
    expect((error as McpApiError).status).toBe(500);
    expect((error as McpApiError).message).toContain("Internal Server Error");
  });

  it("throws McpApiError with the status in the message when a GET response has an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", { status: 503, statusText: "Service Unavailable" })
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    const error = await client.get("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpApiError);
    expect((error as McpApiError).status).toBe(503);
    expect((error as McpApiError).message).toContain("503");
  });

  it("throws McpApiError when a POST response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    await expect(client.post("/things", { name: "x" })).rejects.toBeInstanceOf(
      McpApiError
    );
  });

  it("throws McpApiError when a PUT response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Not Found" }), { status: 404 })
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    await expect(client.put("/things/x", { name: "y" })).rejects.toBeInstanceOf(
      McpApiError
    );
  });

  it("throws McpApiError when a PATCH response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
          })
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    await expect(
      client.patch("/things/x", { name: "y" })
    ).rejects.toBeInstanceOf(McpApiError);
  });

  it("throws McpApiError when a DELETE response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Not Found" }), { status: 404 })
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    await expect(client.delete("/things/x")).rejects.toBeInstanceOf(
      McpApiError
    );
  });

  it("wraps a fetch Error in a descriptive message for verifyApiKeyDetailed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    await expect(verifyApiKeyDetailed("sk_live_test")).rejects.toThrow(
      "API key verification request failed: ECONNREFUSED"
    );
  });

  it("wraps a non-Error fetch rejection in a generic message for verifyApiKeyDetailed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("connection reset"));
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    await expect(verifyApiKeyDetailed("sk_live_test")).rejects.toThrow(
      "API key verification request failed: unknown verification error"
    );
  });

  it("verifyApiKey returns null when the API key is refused with a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Invalid key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    const { verifyApiKey } = await import("../api-client.js");
    await expect(verifyApiKey("sk_live_invalid")).resolves.toBeNull();
  });

  it("JSON-serializes a non-string error object when the message field is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, error: { code: "SOME_CODE" } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    const error = await client.get("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpApiError);
    expect((error as McpApiError).message).toContain("SOME_CODE");
  });

  it("uses 'API request failed' as the fallback message when success=false has no error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    const error = await client.get("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpApiError);
    expect((error as McpApiError).message).toBe("API request failed");
  });

  it("reads timestamp from the nested error object when absent at the top level", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { message: "timed out", timestamp },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    const { createApiClient } = await import("../api-client.js");
    const { McpApiError } = await import("../api-error.js");
    const client = createApiClient(
      { userId: "u1", organizationId: "o1", scopes: ["read"] },
      "sk_live_test"
    );
    const error = await client.get("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpApiError);
    expect((error as McpApiError).timestamp).toBe(timestamp);
  });
});
