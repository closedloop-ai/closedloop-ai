import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { ApiKeySource } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  getAuth: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
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

vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: vi.fn(() => false),
}));

vi.mock("@/lib/auth/desktop-session-auth", () => ({
  resolveDesktopSessionContext: vi.fn(),
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: vi.fn(),
  resolveDesktopManagedPopMode: vi.fn(),
}));

import { auth, getAuth, verifyToken } from "@repo/auth/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import type { RequiredApiKeyScopes } from "@/lib/auth/api-key-scopes";
import { UNAUTHENTICATED } from "@/lib/auth/auth-context-failure";
import {
  getDesktopManagedPopRequestFailure,
  resolveDesktopManagedPopMode,
} from "@/lib/auth/desktop-managed-pop";
import {
  resolveAnyAuthContext,
  resolveApiKeyTokenContext,
} from "@/lib/auth/resolve-any-auth-context";

// Captured before any suite mutates it, so the restore below puts back the
// exact prior state — including "was never set", which an `= undefined`
// assignment would turn into the string "undefined".
const originalClerkSecretKey = process.env.CLERK_SECRET_KEY;

afterEach(() => {
  if (typeof originalClerkSecretKey === "string") {
    process.env.CLERK_SECRET_KEY = originalClerkSecretKey;
    return;
  }
  Reflect.deleteProperty(process.env, "CLERK_SECRET_KEY");
});

describe("resolveAnyAuthContext — falls through every strategy to the auth() fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    vi.mocked(getAuth).mockReturnValue({
      userId: null,
      orgId: null,
    } as ReturnType<typeof getAuth>);
  });

  it("resolves to unauthenticated when no Authorization header is present", async () => {
    vi.mocked(auth).mockResolvedValue({
      userId: null,
      orgId: null,
    } as Awaited<ReturnType<typeof auth>>);

    const request = new Request("http://localhost/test");

    await expect(resolveAnyAuthContext(request)).resolves.toEqual(
      UNAUTHENTICATED
    );
    expect(verifyToken).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("returns unauthenticated without calling verifyToken when CLERK_SECRET_KEY is not configured", async () => {
    Reflect.deleteProperty(process.env, "CLERK_SECRET_KEY");
    vi.mocked(auth).mockResolvedValue({
      userId: null,
      orgId: null,
    } as Awaited<ReturnType<typeof auth>>);

    const request = new Request("http://localhost/test", {
      headers: { authorization: "Bearer clerk-session-token" },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual(
      UNAUTHENTICATED
    );
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("returns unauthenticated when the bearer token's claims are not usable Clerk identifiers", async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 12_345,
      org_id: undefined,
    } as unknown as Awaited<ReturnType<typeof verifyToken>>);
    vi.mocked(auth).mockResolvedValue({
      userId: null,
      orgId: null,
    } as Awaited<ReturnType<typeof auth>>);

    const request = new Request("http://localhost/test", {
      headers: { authorization: "Bearer malformed-claims-token" },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual(
      UNAUTHENTICATED
    );
    expect(organizationsService.findByClerkId).not.toHaveBeenCalled();
  });
});

describe("resolveAnyAuthContext — Clerk identity resolution failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyToken).mockRejectedValue(new Error("invalid bearer token"));
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    vi.mocked(auth).mockResolvedValue({
      userId: null,
      orgId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("returns unauthenticated when the resolved Clerk organization does not exist in our database", async () => {
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_clerk_1",
      orgId: "org_clerk_1",
    } as ReturnType<typeof getAuth>);
    vi.mocked(organizationsService.findByClerkId).mockResolvedValue(null);

    const request = new Request("http://localhost/test", {
      headers: { authorization: "Bearer clerk-session-token" },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual(
      UNAUTHENTICATED
    );
    expect(usersService.findByClerkIdAndOrg).not.toHaveBeenCalled();
  });

  it("returns unauthenticated when the resolved user is missing or inactive", async () => {
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_clerk_1",
      orgId: "org_clerk_1",
    } as ReturnType<typeof getAuth>);
    vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
      id: "org_db_1",
    } as Awaited<ReturnType<typeof organizationsService.findByClerkId>>);
    vi.mocked(usersService.findByClerkIdAndOrg).mockResolvedValue(null);

    const request = new Request("http://localhost/test", {
      headers: { authorization: "Bearer clerk-session-token" },
    });

    await expect(resolveAnyAuthContext(request)).resolves.toEqual(
      UNAUTHENTICATED
    );
  });
});

describe("resolveApiKeyTokenContext — scope shorthand and rejection paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts an array of required scopes as shorthand for the options object and rejects a key missing one", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      userId: "user_db_1",
      organizationId: "org_db_1",
      scopes: ["read"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);

    await expect(
      resolveApiKeyTokenContext("test-token", ["write"])
    ).resolves.toBeNull();
    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it("falls back to the read scope and resolves a full context when no options are given", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      userId: "user_db_1",
      organizationId: "org_db_1",
      scopes: ["read"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_1",
      active: true,
      clerkId: "clerk_user_1",
    } as Awaited<ReturnType<typeof usersService.findById>>);
    vi.mocked(organizationsService.findById).mockResolvedValue({
      id: "org_db_1",
    } as Awaited<ReturnType<typeof organizationsService.findById>>);

    await expect(resolveApiKeyTokenContext("test-token")).resolves.toEqual({
      organizationId: "org_db_1",
      userId: "user_db_1",
    });
  });

  it("returns null when the verified key cannot be found", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue(null);

    await expect(
      resolveApiKeyTokenContext("test-token", { requiredScopes: ["read"] })
    ).resolves.toBeNull();
  });

  it("returns null when the resolved user is missing or inactive", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      userId: "user_db_1",
      organizationId: "org_db_1",
      scopes: ["read"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue(null);

    await expect(
      resolveApiKeyTokenContext("test-token", { requiredScopes: ["read"] })
    ).resolves.toBeNull();
  });

  it("returns null when the key's organization no longer exists", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-1",
      userId: "user_db_1",
      organizationId: "org_db_1",
      scopes: ["read"],
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_1",
      active: true,
      clerkId: "clerk_user_1",
    } as Awaited<ReturnType<typeof usersService.findById>>);
    vi.mocked(organizationsService.findById).mockResolvedValue(null);

    await expect(
      resolveApiKeyTokenContext("test-token", { requiredScopes: ["read"] })
    ).resolves.toBeNull();
  });
});

// ISS-11792: `[].every(...)` is true, so an empty required list would admit a
// key holding any scope. The type forbids it; these cover untyped callers.
describe("resolveApiKeyTokenContext — refuses an empty requiredScopes", () => {
  const readOnlyKey = {
    apiKeyId: "api-key-1",
    userId: "user_db_1",
    organizationId: "org_db_1",
    scopes: [ApiKeyScope.Read],
    source: ApiKeySource.USER_CREATED,
    gatewayId: null,
    boundPublicKey: null,
  } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue(
      readOnlyKey
    );
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_1",
      active: true,
      clerkId: "clerk_user_1",
    } as Awaited<ReturnType<typeof usersService.findById>>);
    vi.mocked(organizationsService.findById).mockResolvedValue({
      id: "org_db_1",
    } as Awaited<ReturnType<typeof organizationsService.findById>>);
  });

  it("rejects an empty array shorthand", async () => {
    await expect(
      resolveApiKeyTokenContext("test-token", JSON.parse("[]"))
    ).resolves.toBeNull();
  });

  it("rejects an options object with an empty requiredScopes", async () => {
    await expect(
      resolveApiKeyTokenContext(
        "test-token",
        JSON.parse('{"requiredScopes":[]}')
      )
    ).resolves.toBeNull();
  });

  it("checks the scopes it was called with when the caller empties its array during key verification", async () => {
    const requiredScopes: RequiredApiKeyScopes = [ApiKeyScope.Write];
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockImplementation(() => {
      requiredScopes.pop();
      return Promise.resolve(readOnlyKey);
    });

    await expect(
      resolveApiKeyTokenContext("test-token", { requiredScopes })
    ).resolves.toBeNull();
  });

  it("answers an API-key request to resolveAnyAuthContext with an empty requiredScopes as unauthenticated", async () => {
    const request = new Request("http://localhost/test", {
      headers: { authorization: "Bearer sk_live_test" },
    });

    await expect(
      resolveAnyAuthContext(request, JSON.parse('{"requiredScopes":[]}'))
    ).resolves.toEqual(UNAUTHENTICATED);
  });
});

describe("resolveApiKeyTokenContext — desktop-managed PoP without a request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockDesktopManagedKey() {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      apiKeyId: "api-key-bound",
      userId: "user_db_1",
      organizationId: "org_db_1",
      scopes: ["read"],
      source: ApiKeySource.DESKTOP_MANAGED,
      gatewayId: "gateway-1",
      boundPublicKey: "pem-public-key",
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);
    vi.mocked(usersService.findById).mockResolvedValue({
      id: "user_db_1",
      active: true,
      clerkId: "clerk_user_1",
    } as Awaited<ReturnType<typeof usersService.findById>>);
  }

  it("rejects when PoP mode is enforced and no request is available to prove possession", async () => {
    mockDesktopManagedKey();
    vi.mocked(resolveDesktopManagedPopMode).mockResolvedValue("enforce");

    await expect(
      resolveApiKeyTokenContext("test-token", { requiredScopes: ["read"] })
    ).resolves.toBeNull();
    expect(getDesktopManagedPopRequestFailure).not.toHaveBeenCalled();
    expect(apiKeysService.touchLastUsedAt).not.toHaveBeenCalled();
  });

  it("accepts the key without a request when PoP mode is monitor-only", async () => {
    mockDesktopManagedKey();
    vi.mocked(resolveDesktopManagedPopMode).mockResolvedValue("monitor");
    vi.mocked(organizationsService.findById).mockResolvedValue({
      id: "org_db_1",
    } as Awaited<ReturnType<typeof organizationsService.findById>>);

    await expect(
      resolveApiKeyTokenContext("test-token", { requiredScopes: ["read"] })
    ).resolves.toEqual({
      organizationId: "org_db_1",
      userId: "user_db_1",
    });
    expect(apiKeysService.touchLastUsedAt).toHaveBeenCalledWith(
      "api-key-bound"
    );
  });
});
