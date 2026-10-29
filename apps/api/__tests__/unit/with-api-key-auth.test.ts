/**
 * Unit tests for withApiKeyAuth.
 *
 * Verifies:
 *   - clerkOrgId in AuthContext is the organization's Clerk ID, not the internal DB ID
 *   - Returns 401 when API key is invalid, user not found, or org not found
 *   - Returns 403 when the key's scopes do not cover the route's requirement
 *   - Propagates a desktop-managed PoP failure's own status VERBATIM (403 for a
 *     rejected proof, 503 for an unavailable verifier) rather than flattening
 *     every PoP outcome to 401
 *
 * The unauthorized guards all exit through a bare unauthorizedResponse(), so
 * status and body are identical across them. Each of those cases pins WHICH
 * guard fired by asserting the lookup that guard sits in front of was never
 * reached. The scope guard is separated from them by its own 403; its case
 * pins that the org lookup succeeded and the handler never ran.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  ApiKeyScope,
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
} from "@repo/api/src/types/api-key";
import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());
const mockWaitUntil = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
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

import { createMockRequest } from "@/__tests__/utils/auth-helpers";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { withApiKeyAuth } from "@/lib/auth/with-api-key-auth";
import type { AuthContext } from "@/lib/auth/with-auth";
import { forbiddenResponse, unauthorizedResponse } from "@/lib/route-utils";

const mockVerifyKeyWithMetadata = apiKeysService.verifyKeyWithMetadata as Mock;
const mockTouchLastUsedAt = apiKeysService.touchLastUsedAt as Mock;
const mockFindUser = usersService.findById as Mock;
const mockFindOrg = organizationsService.findById as Mock;

const REQUEST_URL = "https://api.closedloop.ai/compute-targets/register";

function createRequest(authorization?: string) {
  const headers = new Headers();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return {
    headers,
    method: "POST",
    url: REQUEST_URL,
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

  it("hands the handler the id of the key that verified (ISS-12552 receipts)", async () => {
    let capturedContext: AuthContext | undefined;
    const handler = vi.fn((ctx: AuthContext) => {
      capturedContext = ctx;
      return Response.json({ ok: true });
    });

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-receipt-owner",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: ["write"],
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

    expect(capturedContext?.apiKeyId).toBe("api-key-receipt-owner");
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

  // The two cases below pin that the wrapper hands back the PoP failure's OWN
  // status. The reason-to-status map itself is pinned one layer down in
  // desktop-managed-pop.test.ts; what is only observable here is the
  // propagation — replacing it with a bare unauthorizedResponse() collapses a
  // verifier outage (503, retryable) into a credential rejection (401) and
  // passes every other test in the repo.
  //
  // Neither case signs anything: both target reasons that resolve BEFORE
  // signature verification, so no third copy of the PoP canonical-string recipe
  // is needed. Both seed their own active user, because usersService.findById
  // is checked ahead of PoP — and because the suite's vi.clearAllMocks() clears
  // calls but NOT implementations, so inheriting a neighbour's user mock would
  // pass in file order and fail run-alone.
  it("propagates a rejected desktop-managed proof as its own 403, not a 401", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const handler = vi.fn(async () => new Response());

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: [ApiKeyScope.Read, ApiKeyScope.Write],
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
      createMockRequest({
        url: REQUEST_URL,
        method: "POST",
        headers: {
          authorization: "Bearer sk_live_testkey",
          [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
          // Epoch second 1 is unreachably stale against any real clock, so this
          // lands on the freshness guard deterministically — no fake timers,
          // which would also fake the performance.now() the wrapper reads.
          [DESKTOP_POP_TIMESTAMP_HEADER]: "1",
          // Well-formed base64url so the malformed-headers guard (a 401) cannot
          // be what fires instead.
          [DESKTOP_POP_SIGNATURE_HEADER]: "aGVsbG8",
        },
      }),
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Desktop managed PoP verification failed",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(mockFindOrg).not.toHaveBeenCalled();
    expect(mockTouchLastUsedAt).not.toHaveBeenCalled();
  });

  it("propagates an unavailable desktop-managed PoP verifier as its own 503, not a 401", async () => {
    const handler = vi.fn(async () => new Response());

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: [ApiKeyScope.Read, ApiKeyScope.Write],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      // Unparseable as an Ed25519 SPKI PEM: the verifier cannot be built at all,
      // which is a server-side fault, not a rejected credential.
      boundPublicKey: "not-a-pem",
    });
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: true,
    });

    const wrapped = withApiKeyAuth(handler as never);
    const response = await wrapped(
      createMockRequest({
        url: REQUEST_URL,
        method: "POST",
        headers: { authorization: "Bearer sk_live_testkey" },
      }),
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Desktop managed PoP verifier unavailable",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(mockFindOrg).not.toHaveBeenCalled();
    expect(mockTouchLastUsedAt).not.toHaveBeenCalled();
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

  it("rejects a bearer token without the sk_live_ prefix before any key lookup", async () => {
    const handler = vi.fn(async () => new Response());

    const wrapped = withApiKeyAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer sk_test_notlive") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      await unauthorizedResponse().json()
    );
    // Pins THIS guard: the prefix check sits in front of the key lookup, so a
    // rejection that reached verifyKeyWithMetadata came from somewhere else.
    expect(mockVerifyKeyWithMetadata).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an inactive user before the organization lookup", async () => {
    const handler = vi.fn(async () => new Response());

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-user-created",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: [ApiKeyScope.Read],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    });
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: false,
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

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      await unauthorizedResponse().json()
    );
    expect(mockFindUser).toHaveBeenCalledWith("user-1", INTERNAL_ORG_ID);
    // Pins THIS guard: the active check sits between the user lookup and the
    // org lookup, and the org here resolves — so reaching findById at all means
    // the inactive user was let through.
    expect(mockFindOrg).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 403 when the verified key's scopes do not satisfy requiredScopes", async () => {
    const handler = vi.fn(async () => new Response());

    mockVerifyKeyWithMetadata.mockResolvedValue({
      apiKeyId: "api-key-user-created",
      userId: "user-1",
      organizationId: INTERNAL_ORG_ID,
      scopes: [ApiKeyScope.Read],
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

    const wrapped = withApiKeyAuth(handler as never, {
      requiredScopes: [ApiKeyScope.Write],
    });
    const response = await wrapped(
      createRequest("Bearer sk_live_testkey") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      await forbiddenResponse().json()
    );
    // Pins THIS guard: the scope check is the last gate before the handler, so
    // the org lookup must have succeeded and the handler must not have run.
    expect(mockFindOrg).toHaveBeenCalledWith(INTERNAL_ORG_ID);
    expect(handler).not.toHaveBeenCalled();
  });
});
