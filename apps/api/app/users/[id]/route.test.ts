import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: {
      id: "a0c91f4c-9d07-4b25-8abf-0f94003be83b",
      organizationId: "org-1",
    },
  },
  clerkService: {
    getOrganizationMembershipRole: vi.fn(),
  },
  usersService: {
    findById: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
      handler(mocks.authContext, request, context.params),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: mocks.clerkService,
}));

vi.mock("../service", () => ({
  usersService: mocks.usersService,
}));

import { PUT } from "./route";

const TARGET_USER = { id: "user-2", organizationId: "org-1" };

describe("PUT /users/[id] role authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authContext.user.id = "a0c91f4c-9d07-4b25-8abf-0f94003be83b";
    mocks.authContext.user.organizationId = "org-1";
    mocks.clerkService.getOrganizationMembershipRole.mockResolvedValue(
      "org:member"
    );
    mocks.usersService.findById.mockResolvedValue(TARGET_USER);
    mocks.usersService.update.mockResolvedValue(TARGET_USER);
  });

  it("denies a non-admin changing another member's role", async () => {
    const response = await putUser("user-2", { role: "ENGINEER" });

    expect(response.status).toBe(403);
    expect(
      mocks.clerkService.getOrganizationMembershipRole
    ).toHaveBeenCalledWith("clerk-org-1", "clerk-user-1");
    expect(mocks.usersService.update).not.toHaveBeenCalled();
  });

  it("allows an org admin to change another member's role", async () => {
    mocks.clerkService.getOrganizationMembershipRole.mockResolvedValue(
      "org:admin"
    );

    const response = await putUser("user-2", { role: "ENGINEER" });

    expect(response.status).toBe(200);
    expect(mocks.usersService.update).toHaveBeenCalledWith("user-2", "org-1", {
      role: "ENGINEER",
    });
  });

  it("does not allow an admin to change their own role through a differently cased UUID", async () => {
    mocks.clerkService.getOrganizationMembershipRole.mockResolvedValue(
      "org:admin"
    );
    mocks.usersService.findById.mockResolvedValue({
      id: mocks.authContext.user.id,
      organizationId: "org-1",
    });

    const response = await putUser("A0C91F4C-9D07-4B25-8ABF-0F94003BE83B", {
      role: "ENGINEER",
    });

    expect(response.status).toBe(403);
    expect(
      mocks.clerkService.getOrganizationMembershipRole
    ).not.toHaveBeenCalled();
    expect(mocks.usersService.update).not.toHaveBeenCalled();
  });

  it("preserves non-role self profile updates without an admin gate", async () => {
    const response = await putUser(mocks.authContext.user.id, {
      githubUsername: "octocat",
    });

    expect(response.status).toBe(200);
    expect(
      mocks.clerkService.getOrganizationMembershipRole
    ).not.toHaveBeenCalled();
    expect(mocks.usersService.update).toHaveBeenCalledWith(
      mocks.authContext.user.id,
      "org-1",
      { githubUsername: "octocat" }
    );
  });

  it("returns 503 role_unresolved when Clerk cannot resolve the caller role", async () => {
    mocks.clerkService.getOrganizationMembershipRole.mockRejectedValue(
      new Error("Clerk unavailable")
    );

    const response = await putUser("user-2", { role: "ENGINEER" });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe("role_unresolved");
    expect(mocks.usersService.update).not.toHaveBeenCalled();
  });
});

function putUser(id: string, body: Record<string, string>) {
  return PUT(
    new NextRequest(`http://localhost/users/${id}`, {
      body: JSON.stringify(body),
      method: "PUT",
    }),
    { params: Promise.resolve({ id }) }
  );
}
