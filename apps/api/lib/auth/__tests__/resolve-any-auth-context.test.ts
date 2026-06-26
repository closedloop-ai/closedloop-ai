import { generateKeyPairSync } from "node:crypto";
import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());
const mockWaitUntil = vi.hoisted(() => vi.fn());

vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  getAuth: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: mockIsFeatureEnabled,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    verifyKey: vi.fn(),
    verifyKeyWithMetadata: vi.fn(),
    touchLastUsedAt: vi.fn(),
  },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findById: vi.fn(),
    findByClerkId: vi.fn(),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: vi.fn(),
    findByClerkIdAndOrg: vi.fn(),
  },
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: vi.fn(),
  },
}));

import { auth, getAuth, verifyToken } from "@repo/auth/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { clerkService } from "@/lib/auth/clerk-service";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";

describe("resolveAnyAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    vi.mocked(apiKeysService.touchLastUsedAt).mockResolvedValue(undefined);
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    vi.mocked(getAuth).mockReturnValue({
      userId: null,
      orgId: null,
    } as ReturnType<typeof getAuth>);
  });

  it("uses Clerk request auth for streaming routes before manual token verification", async () => {
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_clerk_123",
      orgId: "org_clerk_456",
    } as ReturnType<typeof getAuth>);
    vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
      id: "org_db_1",
    } as Awaited<ReturnType<typeof organizationsService.findByClerkId>>);
    vi.mocked(usersService.findByClerkIdAndOrg).mockResolvedValue({
      id: "user_db_1",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findByClerkIdAndOrg>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer clerk-session-token",
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual({
      organizationId: "org_db_1",
      userId: "user_db_1",
    });
    expect(getAuth).toHaveBeenCalledWith(request, {
      acceptsToken: "any",
    });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it("falls back to manual bearer token verification when request auth is unavailable", async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: "user_clerk_123",
      org_id: "org_clerk_456",
    } as Awaited<ReturnType<typeof verifyToken>>);
    vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
      id: "org_db_1",
    } as Awaited<ReturnType<typeof organizationsService.findByClerkId>>);
    vi.mocked(usersService.findByClerkIdAndOrg).mockResolvedValue({
      id: "user_db_1",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findByClerkIdAndOrg>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer clerk-session-token",
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual({
      organizationId: "org_db_1",
      userId: "user_db_1",
    });
    expect(verifyToken).toHaveBeenCalledWith("clerk-session-token", {
      secretKey: "sk_test_123",
    });
    expect(auth).not.toHaveBeenCalled();
  });

  it("preserves the API key path", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      userId: "user_db_2",
      organizationId: "org_db_2",
      scopes: ["read", "write"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_2",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findById>>);
    vi.mocked(organizationsService.findById).mockResolvedValue({
      id: "org_db_2",
    } as Awaited<ReturnType<typeof organizationsService.findById>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer sk_live_123",
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual({
      organizationId: "org_db_2",
      userId: "user_db_2",
    });
    expect(getAuth).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("rejects enforce-eligible desktop-managed API keys without PoP headers", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user_db_2",
      organizationId: "org_db_2",
      scopes: ["read", "write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_2",
      clerkId: "clerk_user_2",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findById>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer sk_live_123",
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toBeNull();
    expect(usersService.findById).toHaveBeenCalledWith("user_db_2", "org_db_2");
    expect(mockWaitUntil).not.toHaveBeenCalled();
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      "desktop-managed-pop-enforcement",
      "clerk_user_2"
    );
  });

  it("accepts enforce-eligible desktop-managed API keys bearer-only when the feature flag is disabled", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    mockIsFeatureEnabled.mockResolvedValue(false);
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user_db_2",
      organizationId: "org_db_2",
      scopes: ["read", "write"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_2",
      clerkId: "clerk_user_2",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findById>>);
    vi.mocked(organizationsService.findById).mockResolvedValue({
      id: "org_db_2",
    } as Awaited<ReturnType<typeof organizationsService.findById>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer sk_live_123",
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual({
      organizationId: "org_db_2",
      userId: "user_db_2",
    });
    expect(mockWaitUntil).toHaveBeenCalledOnce();
  });
});

describe("resolveAnyAuthContext — org header behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
    vi.mocked(apiKeysService.touchLastUsedAt).mockResolvedValue(undefined);
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    vi.mocked(getAuth).mockReturnValue({
      userId: null,
      orgId: null,
    } as ReturnType<typeof getAuth>);
  });

  it("ignores the org header when authenticating via API key", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      userId: "user_db_2",
      organizationId: "org_db_2",
      scopes: ["read", "write"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_2",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findById>>);
    vi.mocked(organizationsService.findById).mockResolvedValue({
      id: "org_db_2",
    } as Awaited<ReturnType<typeof organizationsService.findById>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer sk_live_123",
        [ORG_IDENTITY_HEADER]: "org_different_999",
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual({
      organizationId: "org_db_2",
      userId: "user_db_2",
    });
    expect(clerkService.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it("uses session org when header matches session org in Clerk path", async () => {
    const clerkOrgId = "org_clerk_456";
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_clerk_123",
      orgId: clerkOrgId,
    } as ReturnType<typeof getAuth>);
    vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
      id: "org_db_1",
    } as Awaited<ReturnType<typeof organizationsService.findByClerkId>>);
    vi.mocked(usersService.findByClerkIdAndOrg).mockResolvedValue({
      id: "user_db_1",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findByClerkIdAndOrg>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer clerk-session-token",
        [ORG_IDENTITY_HEADER]: clerkOrgId,
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual({
      organizationId: "org_db_1",
      userId: "user_db_1",
    });
    expect(clerkService.getOrganizationMembershipRole).not.toHaveBeenCalled();
    expect(organizationsService.findByClerkId).toHaveBeenCalledWith(clerkOrgId);
  });

  it("uses header org when header differs and user is a member in Clerk path", async () => {
    const sessionOrgId = "org_clerk_456";
    const headerOrgId = "org_clerk_789";
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_clerk_123",
      orgId: sessionOrgId,
    } as ReturnType<typeof getAuth>);
    vi.mocked(clerkService.getOrganizationMembershipRole).mockResolvedValue(
      "org:member"
    );
    vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
      id: "org_db_header",
    } as Awaited<ReturnType<typeof organizationsService.findByClerkId>>);
    vi.mocked(usersService.findByClerkIdAndOrg).mockResolvedValue({
      id: "user_db_1",
      active: true,
    } as Awaited<ReturnType<typeof usersService.findByClerkIdAndOrg>>);

    const request = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer clerk-session-token",
        [ORG_IDENTITY_HEADER]: headerOrgId,
      },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual({
      organizationId: "org_db_header",
      userId: "user_db_1",
    });
    expect(clerkService.getOrganizationMembershipRole).toHaveBeenCalledWith(
      headerOrgId,
      "user_clerk_123"
    );
    expect(organizationsService.findByClerkId).toHaveBeenCalledWith(
      headerOrgId
    );
  });
});
