import { generateKeyPairSync } from "node:crypto";
import { DESKTOP_POP_GATEWAY_ID_HEADER } from "@repo/api/src/types/api-key";
import { API_KEY_SCOPES_UNRESOLVABLE_CODE } from "@repo/api/src/utils/api-key-scope-resolution";
import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/internal/api-keys/verify/route";
import { ApiKeyVerificationStatus } from "@/lib/auth/api-key-verification";

const mockVerifyKeyWithMetadata = vi.hoisted(() => vi.fn());
const mockVerifyKeyOutcome = vi.hoisted(() => vi.fn());
const mockTouchLastUsedAt = vi.hoisted(() => vi.fn());
const mockUsersFindById = vi.hoisted(() => vi.fn());
const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());
const mockWaitUntil = vi.hoisted(() => vi.fn());

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    touchLastUsedAt: mockTouchLastUsedAt,
    verifyKeyWithMetadata: mockVerifyKeyWithMetadata,
    // ISS-4905: the route reads the outcome variant so it can preserve WHY a
    // key was refused. Derive it from the same mock rather than adding a second
    // knob, so this mock cannot describe a pair the service never produces;
    // `mockVerifyKeyOutcome` overrides it for the refusal-reason cases.
    verifyKeyOutcome: async (...args: unknown[]) => {
      const override = mockVerifyKeyOutcome(...args);
      if (override) {
        return override;
      }
      const context = await mockVerifyKeyWithMetadata(...args);
      return context
        ? { status: ApiKeyVerificationStatus.Ok, context }
        : { status: ApiKeyVerificationStatus.Invalid };
    },
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: mockUsersFindById,
  },
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    isFeatureEnabled: mockIsFeatureEnabled,
  },
}));

// The logging wrapper's own flush also goes through `waitUntil`; passed through
// here so `mockWaitUntil` keeps meaning "a key touch was deferred".
vi.mock("@/lib/observability/with-request-completed", () => ({
  withRequestCompleted: <T>(handler: T) => handler,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));

const INTERNAL_SECRET = "test-internal-secret";

function makeRequest(
  input: { desktopPopRequired?: boolean } = {},
  options: {
    headers?: Record<string, string>;
    internalSecret?: string;
    omitInternalSecret?: boolean;
  } = {}
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (!options.omitInternalSecret) {
    headers["X-Internal-Secret"] = options.internalSecret ?? INTERNAL_SECRET;
  }
  return new Request("https://api.closedloop.ai/internal/api-keys/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({ key: "sk_live_test", ...input }),
  });
}

function validPublicKeyPem(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

describe("POST /internal/api-keys/verify desktop managed PoP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockTouchLastUsedAt.mockResolvedValue(undefined);
    mockUsersFindById.mockResolvedValue({ clerkId: "clerk-user-1" });
    mockVerifyKeyOutcome.mockReturnValue(undefined);
  });

  it("preserves bearer compatibility for USER_CREATED keys without PoP headers", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-user",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    });

    const response = await POST(makeRequest({ desktopPopRequired: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        userId: "user-1",
        organizationId: "org-1",
        clerkUserId: "clerk-user-1",
        scopes: ["write"],
      },
    });
    expect(mockTouchLastUsedAt).toHaveBeenCalledWith("api-key-user");
  });

  it("keeps null-bound DESKTOP_MANAGED keys monitor-only in enforce mode", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-null-bound",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: null,
    });

    const response = await POST(makeRequest({ desktopPopRequired: true }));

    expect(response.status).toBe(200);
  });

  it("preserves non-relay verifier callers for enforce-eligible keys without PoP headers", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: validPublicKeyPem(),
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockTouchLastUsedAt).toHaveBeenCalledWith("api-key-bound");
  });

  it("returns 401 for relay enforce-eligible keys missing PoP headers", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: validPublicKeyPem(),
    });

    const response = await POST(makeRequest({ desktopPopRequired: true }));

    expect(response.status).toBe(401);
    expect(mockTouchLastUsedAt).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      success: false,
      error: "Desktop managed PoP verification failed",
    });
  });

  it("applies PoP verification when a gateway header is present without a body flag", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: validPublicKeyPem(),
    });

    const response = await POST(
      makeRequest(
        {},
        { headers: { [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1" } }
      )
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Desktop managed PoP verification failed",
    });
    expect(mockTouchLastUsedAt).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("returns 503 when an enforce-eligible key has a corrupt stored public key", async () => {
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-corrupt-bound-key",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: "not-a-pem",
    });

    const response = await POST(makeRequest({ desktopPopRequired: true }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: "Desktop managed PoP verifier unavailable",
    });
    expect(mockTouchLastUsedAt).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("accepts enforce-eligible keys without PoP headers when the feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: validPublicKeyPem(),
    });

    const response = await POST(makeRequest({ desktopPopRequired: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        userId: "user-1",
        organizationId: "org-1",
        clerkUserId: "clerk-user-1",
        scopes: ["write"],
      },
    });
    expect(mockTouchLastUsedAt).toHaveBeenCalledWith("api-key-bound");
  });

  it("returns 503 when key verification throws on the validation path", async () => {
    mockVerifyKeyWithMetadata.mockRejectedValue(new Error("db unavailable"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: "Failed to verify API key",
    });
  });
});

/**
 * ISS-4905: both refusals are a 401, but only one of them means "reissue this
 * key". Without a machine-readable reason the MCP server answers a corrupt
 * scope row with a generic invalid_client and revokes the caller's whole
 * refresh-token family.
 */
describe("POST /internal/api-keys/verify refusal reasons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockTouchLastUsedAt.mockResolvedValue(undefined);
    mockUsersFindById.mockResolvedValue({ clerkId: "clerk-user-1" });
    mockVerifyKeyOutcome.mockReturnValue(undefined);
  });

  it("labels an unresolvable stored scope set with a machine-readable code", async () => {
    mockVerifyKeyOutcome.mockReturnValue({
      status: ApiKeyVerificationStatus.UnresolvableScopes,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unauthorized",
      code: API_KEY_SCOPES_UNRESOLVABLE_CODE,
    });
    // The key is refused, so nothing about it is touched.
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  // Omitted rather than null: an unknown key carries no remedy to report, and
  // an older client must keep seeing exactly the 401 body it saw before.
  it("omits the code entirely for an unknown key", async () => {
    mockVerifyKeyOutcome.mockReturnValue({
      status: ApiKeyVerificationStatus.Invalid,
    });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ success: false, error: "Unauthorized" });
    expect("code" in body).toBe(false);
  });
});

/**
 * ISS-7537: the X-Internal-Secret compare is the whole authentication boundary
 * for this route, and every other case in this file hands it the correct secret.
 * Each case below wires the key lookup to SUCCEED, so a 401 can only come from
 * the gate — delete either branch of it and these turn 200, where asserting the
 * status alone would stay green on the unrelated invalid-key 401.
 */
describe("POST /internal/api-keys/verify internal secret gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockTouchLastUsedAt.mockResolvedValue(undefined);
    mockUsersFindById.mockResolvedValue({ clerkId: "clerk-user-1" });
    mockVerifyKeyOutcome.mockReturnValue(undefined);
    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-user",
      userId: "user-1",
      organizationId: "org-1",
      scopes: ["write"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    });
  });

  it("returns 401 when the X-Internal-Secret header is absent", async () => {
    const response = await POST(makeRequest({}, { omitInternalSecret: true }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(mockVerifyKeyWithMetadata).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it("returns 401 when the X-Internal-Secret header does not match", async () => {
    const response = await POST(
      makeRequest({}, { internalSecret: `${INTERNAL_SECRET}-wrong` })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(mockVerifyKeyWithMetadata).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  // `@/env` is a t3-env snapshot taken when the module first evaluates, so
  // deleting the variable cannot reach an already-imported route — the module
  // registry has to be reset and the route re-imported for the unset branch to
  // be reachable at all. __tests__/setup.ts forces the variable process-wide,
  // so the restore below is what keeps sibling suites in this worker green.
  it("returns 401 when INTERNAL_API_SECRET is not configured", async () => {
    const previousSecret = process.env.INTERNAL_API_SECRET;
    Reflect.deleteProperty(process.env, "INTERNAL_API_SECRET");

    try {
      vi.resetModules();
      const { POST: postWithoutConfiguredSecret } = await import(
        "@/app/internal/api-keys/verify/route"
      );

      const response = await postWithoutConfiguredSecret(makeRequest());

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        success: false,
        error: "Unauthorized",
      });
      expect(mockVerifyKeyWithMetadata).not.toHaveBeenCalled();
      expect(mockWaitUntil).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) {
        Reflect.deleteProperty(process.env, "INTERNAL_API_SECRET");
      } else {
        process.env.INTERNAL_API_SECRET = previousSecret;
      }
      vi.resetModules();
    }
  });
});
