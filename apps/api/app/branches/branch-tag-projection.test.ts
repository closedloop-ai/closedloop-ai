import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { TagColor } from "@repo/api/src/types/tag";
import { ApproverRole } from "@repo/api/src/types/user";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  branchTagPermissionsForAuth,
  projectBranchTags,
} from "./branch-tag-projection";

const organizationId = "org-1";

describe("projectBranchTags", () => {
  it("projects loaded generic tags and preserves same-name stable identities", () => {
    const projection = projectBranchTags(
      [
        relation("tag-1", "backend", organizationId),
        relation("tag-2", "backend", organizationId),
      ],
      organizationId
    );

    expect(projection).toEqual({
      tagAvailability: BranchTagAvailability.Available,
      tags: [
        { id: "tag-1", name: "backend", color: TagColor.Blue },
        { id: "tag-2", name: "backend", color: TagColor.Blue },
      ],
    });
  });

  it("deduplicates repeated relations only by canonical tag id", () => {
    const projection = projectBranchTags(
      [
        relation("tag-1", "backend", organizationId),
        relation("tag-1", "backend", organizationId),
      ],
      organizationId
    );

    expect(projection.tags).toEqual([
      { id: "tag-1", name: "backend", color: TagColor.Blue },
    ]);
  });

  it("distinguishes loaded-empty from unavailable relation data", () => {
    expect(projectBranchTags([], organizationId)).toEqual({
      tagAvailability: BranchTagAvailability.Available,
      tags: [],
    });
    expect(projectBranchTags(undefined, organizationId)).toEqual({
      tagAvailability: BranchTagAvailability.Unavailable,
    });
  });

  it("filters malformed cross-organization relations before serialization", () => {
    const projection = projectBranchTags(
      [
        relation("tag-owned", "owned", organizationId),
        relation("tag-foreign", "foreign", "org-2"),
      ],
      organizationId
    );

    expect(projection.tags).toEqual([
      { id: "tag-owned", name: "owned", color: TagColor.Blue },
    ]);
  });
});

describe("branchTagPermissionsForAuth", () => {
  it.each([
    ["session", undefined, true, true],
    ["desktop_session", undefined, true, true],
    ["api_key", ["read"], false, false],
    ["api_key", ["read", "write"], true, false],
    ["api_key", ["read", "delete"], false, true],
    ["api_key", ["read", "write", "delete"], true, true],
  ] as const)("maps %s scopes %j to apply=%s remove=%s", (authMethod, apiKeyScopes, canApply, canRemove) => {
    expect(
      branchTagPermissionsForAuth(
        authContext(authMethod, apiKeyScopes ? [...apiKeyScopes] : undefined)
      )
    ).toEqual({ canApply, canRemove });
  });
});

function relation(id: string, name: string, relationOrganizationId: string) {
  return {
    tag: {
      id,
      name,
      color: TagColor.Blue,
      organizationId: relationOrganizationId,
    },
  };
}

function authContext(
  authMethod: AuthContext["authMethod"],
  apiKeyScopes: AuthContext["apiKeyScopes"]
): AuthContext {
  return {
    user: {
      id: "user-1",
      organizationId,
      clerkId: "clerk-user-1",
      email: "user@example.test",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
      phoneNumber: null,
      role: ApproverRole.Engineer,
      linearId: null,
      slackId: null,
      githubUsername: null,
      active: true,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    clerkUserId: "clerk-user-1",
    clerkOrgId: "clerk-org-1",
    authMethod,
    apiKeyScopes,
  };
}
