/**
 * ISS-4905: the internal verification response is the only place this server
 * can learn WHY apps/api refused a key. This pins that boundary — including the
 * version-skew case, where an API that predates the reason code must still read
 * as a plain refusal rather than crashing or inventing one.
 */

import { API_KEY_SCOPES_UNRESOLVABLE_CODE } from "@repo/api/src/utils/api-key-scope-resolution.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyVerificationStatus } from "../api-key-contract.js";

const ORIGINAL_ENV: Record<string, string | undefined> = {
  INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
  CLOSEDLOOP_API_URL: process.env.CLOSEDLOOP_API_URL,
};

process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.CLOSEDLOOP_API_URL = "http://api.test";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});

function refusal(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

describe("verifyApiKeyDetailed", () => {
  it("reads the unresolvable-scopes refusal off the response code", async () => {
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    fetchMock.mockResolvedValue(
      refusal({
        success: false,
        error: "Unauthorized",
        code: API_KEY_SCOPES_UNRESOLVABLE_CODE,
      })
    );

    expect(await verifyApiKeyDetailed("sk_live_x")).toEqual({
      status: ApiKeyVerificationStatus.UnresolvableScopes,
    });
  });

  // Version skew: an apps/api that predates the code omits it entirely, and the
  // refusal must degrade to the behavior that existed before this change.
  it("treats a refusal with no code as a plain invalid key", async () => {
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    fetchMock.mockResolvedValue(
      refusal({ success: false, error: "Unauthorized" })
    );

    expect(await verifyApiKeyDetailed("sk_live_x")).toEqual({
      status: ApiKeyVerificationStatus.Invalid,
    });
  });

  it("treats an unrecognized code as a plain invalid key", async () => {
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    fetchMock.mockResolvedValue(
      refusal({ success: false, error: "Unauthorized", code: "some_new_code" })
    );

    expect(await verifyApiKeyDetailed("sk_live_x")).toEqual({
      status: ApiKeyVerificationStatus.Invalid,
    });
  });

  it("survives a refusal whose body is not JSON", async () => {
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    fetchMock.mockResolvedValue(
      new Response("<html>gateway refused</html>", { status: 401 })
    );

    expect(await verifyApiKeyDetailed("sk_live_x")).toEqual({
      status: ApiKeyVerificationStatus.Invalid,
    });
  });

  it("returns the verified context on success", async () => {
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    const context = {
      userId: "user_1",
      organizationId: "org_1",
      scopes: ["read"],
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: context }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    expect(await verifyApiKeyDetailed("sk_live_x")).toEqual({
      status: ApiKeyVerificationStatus.Ok,
      context,
    });
  });

  // A 5xx is the API being broken, not a verdict on the key. It must throw so
  // callers reach their local-verification fallback instead of refusing.
  it("throws on a server error rather than reporting a refusal", async () => {
    const { verifyApiKeyDetailed } = await import("../api-client.js");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 503 })
    );

    await expect(verifyApiKeyDetailed("sk_live_x")).rejects.toThrow();
  });
});
