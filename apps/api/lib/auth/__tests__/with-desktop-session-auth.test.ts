/**
 * Unit tests for withDesktopSessionAuth.
 *
 * Verifies:
 *   - A verified desktop access token yields an AuthContext with
 *     authMethod: "desktop_session" and the org's Clerk id (not internal id).
 *   - Identity is resolved org-scoped via usersService.findById(userId, orgId).
 *   - ANY failure (bad token, inactive user, missing org, no token) returns 401
 *     and never invokes the handler — there is no fall-through to Clerk.
 *   - Unexpected lookup errors surface as 500, not a silent pass.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

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
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@repo/auth/desktop-session-jwt", () => ({
  verifyDesktopAccessToken: vi.fn(),
}));
vi.mock("@/app/organizations/service", () => ({
  organizationsService: { findById: vi.fn() },
}));
vi.mock("@/app/users/service", () => ({
  usersService: { findById: vi.fn() },
}));

import { verifyDesktopAccessToken } from "@repo/auth/desktop-session-jwt";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import { withDesktopSessionAuth } from "@/lib/auth/with-desktop-session-auth";

const mockVerify = verifyDesktopAccessToken as Mock;
const mockFindUser = usersService.findById as Mock;
const mockFindOrg = organizationsService.findById as Mock;

const INTERNAL_ORG_ID = "internal-org-uuid";
const CLERK_ORG_ID = "org_clerk_abc123";

function createRequest(authorization?: string) {
  const headers = new Headers();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return {
    headers,
    method: "GET",
    url: "https://api.closedloop.ai/projects",
  } as unknown as Request;
}

function approvedClaims() {
  return {
    userId: "user-1",
    organizationId: INTERNAL_ORG_ID,
    sessionId: "session-1",
    tokenId: "token-1",
    issuedAt: 1,
    expiresAt: 2,
  };
}

describe("withDesktopSessionAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a desktop_session AuthContext using the org's Clerk id", async () => {
    let capturedContext: AuthContext | undefined;
    const handler = vi.fn((ctx: AuthContext) => {
      capturedContext = ctx;
      return Response.json({ ok: true });
    });

    mockVerify.mockResolvedValue(approvedClaims());
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

    const wrapped = withDesktopSessionAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer desktop-access-token") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(200);
    expect(capturedContext?.authMethod).toBe("desktop_session");
    expect(capturedContext?.clerkOrgId).toBe(CLERK_ORG_ID);
    expect(capturedContext?.clerkOrgId).not.toBe(INTERNAL_ORG_ID);
    expect(capturedContext?.clerkUserId).toBe("clerk_user_1");
    expect(capturedContext?.user.id).toBe("user-1");
    expect(capturedContext?.apiKeyScopes).toBeUndefined();
    expect(capturedContext?.orgRole).toBeUndefined();
    // Org-scoped identity lookup — same call shape as the API-key path.
    expect(mockFindUser).toHaveBeenCalledWith("user-1", INTERNAL_ORG_ID);
  });

  it("returns 401 and skips the handler when the token fails verification", async () => {
    const handler = vi.fn(async () => new Response());
    mockVerify.mockRejectedValue(new Error("bad signature"));

    const wrapped = withDesktopSessionAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer desktop-access-token") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(mockFindUser).not.toHaveBeenCalled();
  });

  it("returns 401 when the user is inactive", async () => {
    const handler = vi.fn(async () => new Response());
    mockVerify.mockResolvedValue(approvedClaims());
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: false,
    });

    const wrapped = withDesktopSessionAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer desktop-access-token") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(mockFindOrg).not.toHaveBeenCalled();
  });

  it("returns 401 when the organization is missing", async () => {
    const handler = vi.fn(async () => new Response());
    mockVerify.mockResolvedValue(approvedClaims());
    mockFindUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk_user_1",
      organizationId: INTERNAL_ORG_ID,
      active: true,
    });
    mockFindOrg.mockResolvedValue(null);

    const wrapped = withDesktopSessionAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer desktop-access-token") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 when no bearer token is present", async () => {
    const handler = vi.fn(async () => new Response());

    const wrapped = withDesktopSessionAuth(handler as never);
    const response = await wrapped(
      createRequest() as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns 500 when an identity lookup throws unexpectedly", async () => {
    const handler = vi.fn(async () => new Response());
    mockVerify.mockResolvedValue(approvedClaims());
    mockFindUser.mockRejectedValue(new Error("db unavailable"));

    const wrapped = withDesktopSessionAuth(handler as never);
    const response = await wrapped(
      createRequest("Bearer desktop-access-token") as never,
      { params: Promise.resolve({}) } as never
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Authentication failed",
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
