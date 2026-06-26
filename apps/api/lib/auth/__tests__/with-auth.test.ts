import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import type { User } from "@repo/api/src/types/user";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => String(e),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: vi.fn(),
}));

vi.mock("@/lib/auth/resolve-org-header", () => ({
  resolveOrgHeader: vi.fn(),
}));

import { auth } from "@repo/auth/server";
import { findOrCreateUser } from "@/lib/auth/find-or-create-user";
import { resolveOrgHeader } from "@/lib/auth/resolve-org-header";
import { withAuth } from "@/lib/auth/with-auth";

const CLERK_USER_ID = "user_clerk_abc";
const SESSION_CLERK_ORG_ID = "org_session_123";
const HEADER_CLERK_ORG_ID = "org_header_456";
const SESSION_ORG_ROLE = "org:admin";

const activeUser: User = {
  id: "db-user-1",
  clerkId: CLERK_USER_ID,
  organizationId: "db-org-1",
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  avatarUrl: null,
  phoneNumber: null,
  role: "ENGINEER",
  linearId: null,
  slackId: null,
  githubUsername: null,
  active: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

function createRequest(headers?: Record<string, string>) {
  return new Request("http://localhost:3002/api/test", {
    method: "GET",
    headers: new Headers(headers),
  }) as never;
}

function createRouteContext() {
  return { params: Promise.resolve({}) } as never;
}

describe("withAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes JWT org to handler when resolveOrgHeader returns session kind", async () => {
    let capturedContext: AuthContext | undefined;
    const handler = vi.fn((ctx: AuthContext) => {
      capturedContext = ctx;
      return Response.json({ ok: true });
    });

    vi.mocked(auth).mockResolvedValue({
      userId: CLERK_USER_ID,
      orgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(resolveOrgHeader).mockResolvedValue({
      kind: "session",
      clerkOrgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    });
    vi.mocked(findOrCreateUser).mockResolvedValue(activeUser);

    const wrapped = withAuth(handler as never);
    const response = await wrapped(createRequest(), createRouteContext());

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(capturedContext).toBeDefined();
    expect(capturedContext?.clerkOrgId).toBe(SESSION_CLERK_ORG_ID);
    expect(capturedContext?.orgRole).toBe(SESSION_ORG_ROLE);
    expect(capturedContext?.clerkUserId).toBe(CLERK_USER_ID);
    expect(capturedContext?.authMethod).toBe("session");
  });

  it("uses JWT org when header matches session org", async () => {
    let capturedContext: AuthContext | undefined;
    const handler = vi.fn((ctx: AuthContext) => {
      capturedContext = ctx;
      return Response.json({ ok: true });
    });

    vi.mocked(auth).mockResolvedValue({
      userId: CLERK_USER_ID,
      orgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(resolveOrgHeader).mockResolvedValue({
      kind: "session",
      clerkOrgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    });
    vi.mocked(findOrCreateUser).mockResolvedValue(activeUser);

    const wrapped = withAuth(handler as never);
    const response = await wrapped(
      createRequest({ [ORG_IDENTITY_HEADER]: SESSION_CLERK_ORG_ID }),
      createRouteContext()
    );

    expect(response.status).toBe(200);
    expect(capturedContext?.clerkOrgId).toBe(SESSION_CLERK_ORG_ID);
    expect(capturedContext?.orgRole).toBe(SESSION_ORG_ROLE);
  });

  it("uses header org and role when header differs and user is a member", async () => {
    let capturedContext: AuthContext | undefined;
    const handler = vi.fn((ctx: AuthContext) => {
      capturedContext = ctx;
      return Response.json({ ok: true });
    });

    const headerOrgRole = "org:member";
    vi.mocked(auth).mockResolvedValue({
      userId: CLERK_USER_ID,
      orgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(resolveOrgHeader).mockResolvedValue({
      kind: "header",
      clerkOrgId: HEADER_CLERK_ORG_ID,
      orgRole: headerOrgRole,
    });
    vi.mocked(findOrCreateUser).mockResolvedValue({
      ...activeUser,
      organizationId: "db-org-2",
    });

    const wrapped = withAuth(handler as never);
    const response = await wrapped(
      createRequest({ [ORG_IDENTITY_HEADER]: HEADER_CLERK_ORG_ID }),
      createRouteContext()
    );

    expect(response.status).toBe(200);
    expect(capturedContext?.clerkOrgId).toBe(HEADER_CLERK_ORG_ID);
    expect(capturedContext?.orgRole).toBe(headerOrgRole);
    expect(findOrCreateUser).toHaveBeenCalledWith(
      CLERK_USER_ID,
      HEADER_CLERK_ORG_ID
    );
  });

  it("returns 403 when header differs and user is not a member", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));

    vi.mocked(auth).mockResolvedValue({
      userId: CLERK_USER_ID,
      orgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(resolveOrgHeader).mockResolvedValue({
      kind: "forbidden",
    });

    const wrapped = withAuth(handler as never);
    const response = await wrapped(
      createRequest({ [ORG_IDENTITY_HEADER]: HEADER_CLERK_ORG_ID }),
      createRouteContext()
    );

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(findOrCreateUser).not.toHaveBeenCalled();
  });

  it("returns 401 when userId or orgId is missing from auth", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));

    vi.mocked(auth).mockResolvedValue({
      userId: null,
      orgId: null,
    } as Awaited<ReturnType<typeof auth>>);

    const wrapped = withAuth(handler as never);
    const response = await wrapped(createRequest(), createRouteContext());

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(resolveOrgHeader).not.toHaveBeenCalled();
  });

  it("returns 401 when user is inactive", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));

    vi.mocked(auth).mockResolvedValue({
      userId: CLERK_USER_ID,
      orgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(resolveOrgHeader).mockResolvedValue({
      kind: "session",
      clerkOrgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    });
    vi.mocked(findOrCreateUser).mockResolvedValue({
      ...activeUser,
      active: false,
    });

    const wrapped = withAuth(handler as never);
    const response = await wrapped(createRequest(), createRouteContext());

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
