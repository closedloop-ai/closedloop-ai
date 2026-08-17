import type { OrganizationMembershipJSON } from "@repo/auth/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { handleOrganizationMembershipCreated } from "@/app/webhooks/auth/auth-hooks";

/**
 * PRD-532 M9 (PR-J) contract: when an invitee accepts a real Clerk org
 * invitation, Clerk fires `organizationMembership.created`, and the auth webhook
 * must sync a durable MEMBER into the EXISTING org (never a new org-of-one).
 *
 * This is a fast, DB-free unit test that pins the sync guarantee at the handler
 * boundary. The DB-backed happy path (and the webhook-ordering tolerance via
 * `findOrCreateByClerkId`) is additionally covered in
 * `apps/api/__tests__/multi-org-webhooks.test.ts`.
 */

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    identify: vi.fn(),
    capture: vi.fn(),
    groupIdentify: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findOrCreateByClerkId: vi.fn(),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    upsertByClerkIdAndOrg: vi.fn().mockResolvedValue({ id: "user-db-id" }),
  },
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getUser: vi.fn() },
}));

const EXISTING_ORG_DB_ID = "org-db-id";
const CLERK_ORG_ID = "org_clerk_existing";

function buildAcceptedInvitationMembership(): OrganizationMembershipJSON {
  const now = Date.now();
  return {
    id: "orgmem_invited_user",
    object: "organization_membership",
    role: "org:member",
    permissions: [],
    public_metadata: {},
    private_metadata: {},
    created_at: now,
    updated_at: now,
    organization: {
      object: "organization",
      id: CLERK_ORG_ID,
      name: "Acme",
      slug: "acme",
      image_url: "",
      has_image: false,
      created_at: now,
      updated_at: now,
      public_metadata: {},
      private_metadata: {},
      max_allowed_memberships: 100,
      admin_delete_enabled: false,
      members_count: 2,
    },
    public_user_data: {
      user_id: "user_clerk_invited",
      first_name: "Invited",
      last_name: "Teammate",
      image_url: "",
      has_image: false,
      identifier: "invitee@example.com",
    },
  };
}

describe("organizationMembership.created (invitation accepted)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationsService.findOrCreateByClerkId).mockResolvedValue({
      active: true,
      clerkId: CLERK_ORG_ID,
      createdAt: new Date(),
      id: EXISTING_ORG_DB_ID,
      name: "Acme",
      searchIncludeTranscripts: false,
      sessionSyncPolicyEnabled: false,
      settings: {},
      slug: "acme",
      updatedAt: new Date(),
    });
  });

  it("syncs a durable MEMBER into the existing org (not a new org-of-one)", async () => {
    await handleOrganizationMembershipCreated(
      buildAcceptedInvitationMembership()
    );

    // The invitee is attached to the pre-existing org resolved by clerk org id.
    expect(organizationsService.findOrCreateByClerkId).toHaveBeenCalledWith(
      CLERK_ORG_ID,
      expect.objectContaining({ id: CLERK_ORG_ID })
    );

    // A durable MEMBER row is upserted for the invitee, scoped to that org.
    expect(usersService.upsertByClerkIdAndOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        clerkId: "user_clerk_invited",
        organizationId: EXISTING_ORG_DB_ID,
        email: "invitee@example.com",
      })
    );
  });

  it("does not fetch the user from Clerk when the identifier is already email-shaped", async () => {
    const { clerkService } = await import("@/lib/auth/clerk-service");

    await handleOrganizationMembershipCreated(
      buildAcceptedInvitationMembership()
    );

    expect(clerkService.getUser).not.toHaveBeenCalled();
  });
});
