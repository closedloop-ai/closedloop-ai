/**
 * Unit tests for withApiKeyAuth.
 *
 * Verifies:
 *   - clerkOrgId in AuthContext is the organization's Clerk ID, not the internal DB ID
 *   - Returns 401 when API key is invalid, user not found, or org not found
 */
import { generateKeyPairSync } from "node:crypto";
import { ApiKeySource } from "@repo/database";
import { type Mock, vi } from "vitest";

const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());
const mockWaitUntil = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => String(e),
}));
vi.mock("@repo/analytics/server", () => ({
  analytics: {
    isFeatureEnabled: mockIsFeatureEnabled,
  },
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    touchLastUsedAt: vi.fn(),
    verifyKey: vi.fn(),
    verifyKeyWithMetadata: vi.fn(),
  },
}));
vi.mock("@/app/organizations/service", () => ({
  organizationsService: { findById: vi.fn() },
}));
vi.mock("@/app/users/service", () => ({
  usersService: { findById: vi.fn() },
}));

import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { withApiKeyAuth } from "@/lib/auth/with-api-key-auth";
import type { AuthContext } from "@/lib/auth/with-auth";

const mockVerifyKeyWithMetadata = apiKeysService.verifyKeyWithMetadata as Mock;
const mockTouchLastUsedAt = apiKeysService.touchLastUsedAt as Mock;
const mockFindUser = usersService.findById as Mock;
const mockFindOrg = organizationsService.findById as Mock;

function createRequest(authorization?: string) {
  const headers = new Headers();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return {
    headers,
    method: "POST",
    url: "https://api.closedloop.ai/compute-targets/local-auth/verify",
  } as unknown as Request;
}

const INTERNAL_ORG_ID = "internal-org-uuid";
const CLERK_ORG_ID = "org_clerk_abc123";

describe("withApiKeyAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockTouchLastUsedAt.mockResolvedValue(undefined);
  });

  it("sets clerkOrgId to the organization's Clerk ID, not the internal DB ID", async () => {
    let capturedContext: AuthContext | undefined;
    const handler = vi.fn((ctx: AuthContext) => {
      capturedContext = ctx;
      return Response.json({ ok: true });
    });

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-user-created",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: ["read"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    });
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: true,
    });
    mockFindOrg.mockResolvedValue({
      id: INTERNAL_ORG_ID,
      clerkId: CLERK_ORG_ID,
      name: "Test Org",
    });

    const wrapped = withApiKeyAuth(handler as never);
    await wrapped(
      createRequest("Bearer sk_live_testkey") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.clerkOrgId).toBe(CLERK_ORG_ID);
    expect(capturedContext?.clerkOrgId).not.toBe(INTERNAL_ORG_ID);
    expect(capturedContext?.clerkUserId).toBe("clerk_user_1");
    expect(capturedContext?.authMethod).toBe("api_key");
  });

  it("returns 401 when organization is not found", async () => {
    const handler = vi.fn(async () => new Response());

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-user-created",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: [],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    });
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: true,
    });
    mockFindOrg.mockResolvedValue(null);

    const wrapped = withApiKeyAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer sk_live_testkey") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects enforce-eligible desktop-managed keys before handler side effects when PoP headers are missing", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const handler = vi.fn(async () => new Response());

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: ["read", "write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    });
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: true,
    });

    const wrapped = withApiKeyAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer sk_live_testkey") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(mockFindUser).toHaveBeenCalledWith("user-1", INTERNAL_ORG_ID);
    expect(mockFindOrg).not.toHaveBeenCalled();
    expect(mockTouchLastUsedAt).not.toHaveBeenCalled();
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      "desktop-managed-pop-enforcement",
      "clerk_user_1"
    );
  });

  it("treats missing PoP headers as bearer-compatible when the feature flag is disabled", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const handler = vi.fn(async () => new Response());
    mockIsFeatureEnabled.mockResolvedValue(false);

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: ["read", "write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    });
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: true,
    });
    mockFindOrg.mockResolvedValue({
      id: INTERNAL_ORG_ID,
      clerkId: CLERK_ORG_ID,
      name: "Test Org",
    });

    const wrapped = withApiKeyAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer sk_live_testkey") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    // Two waitUntils: apiKeysService.touchLastUsedAt + logRequestCompleted's scheduleLogFlush
    expect(mockWaitUntil).toHaveBeenCalledTimes(2);
  });

  it("does not report non-PoP lookup exceptions as PoP verifier outages", async () => {
    const handler = vi.fn(async () => new Response());

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-user-created",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: ["read", "write"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    });
    mockFindUser.mockRejectedValue(new Error("db unavailable"));

    const wrapped = withApiKeyAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer sk_live_testkey") as never,
      { params: Promise.resolve({}) } as never
    );

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Authentication failed",
    });
    expect(response.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });
});
