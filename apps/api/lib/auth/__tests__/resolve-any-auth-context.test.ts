import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  getAuth: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    verifyKey: vi.fn(),
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

import { auth, getAuth, verifyToken } from "@repo/auth/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";

describe("resolveAnyAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(apiKeysService.verifyKey).mockResolvedValue({
      userId: "user_db_2",
      organizationId: "org_db_2",
      scopes: ["read", "write"],
    } as Awaited<ReturnType<typeof apiKeysService.verifyKey>>);
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
});
