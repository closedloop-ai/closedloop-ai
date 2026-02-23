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
});
