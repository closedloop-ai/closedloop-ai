/**
 * Branch coverage for `apps/api/app/webhooks/auth/auth-hooks.ts` conditions
 * not already exercised by the sibling `webhook-*.test.ts` unit tests:
 * `user.created`'s email/membership guards, `user.updated`'s stamp and
 * no-rows-written branches, the deleted/created-by/no-id fallbacks across
 * `organization.*` and `organizationMembership.*`, the Clerk API fallback
 * when a membership identifier is not email-shaped, the P2025-vs-unexpected
 * error split in `organizationMembership.deleted`, and the shared
 * `syncOrganizationFromClerk` stale-write log. DB-free: every service is
 * mocked, following `webhook-204-responses.test.ts` and
 * `webhook-org-updated.test.ts`.
 */

import type {
  DeletedObjectJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserJSON,
} from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import {
  handleOrganizationCreated,
  handleOrganizationDeleted,
  handleOrganizationMembershipCreated,
  handleOrganizationMembershipDeleted,
  handleOrganizationUpdated,
  handleUserCreated,
  handleUserDeleted,
  handleUserUpdated,
} from "@/app/webhooks/auth/auth-hooks";
import {
  clerkService,
  invalidateUserExternalAccountProviders,
} from "@/lib/auth/clerk-service";

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    identify: vi.fn(),
    capture: vi.fn(),
    groupIdentify: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findOrCreateByClerkId: vi.fn().mockResolvedValue({ id: "org-db-id" }),
    updateByClerkId: vi.fn().mockResolvedValue(1),
    findByClerkId: vi.fn().mockResolvedValue({ id: "org-db-id" }),
    deactivateByClerkId: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    upsertByClerkIdAndOrg: vi.fn().mockResolvedValue({ id: "user-db-id" }),
    updateByClerkId: vi.fn().mockResolvedValue(1),
    deactivateAllByClerkId: vi.fn().mockResolvedValue([{ id: "user-db-id" }]),
    deactivateByClerkIdAndOrg: vi.fn().mockResolvedValue({ id: "user-db-id" }),
  },
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getUser: vi.fn() },
  invalidateUserExternalAccountProviders: vi.fn(),
}));

const CLERK_STAMP = 1_700_000_000_000;

type EmailAddressJSON = UserJSON["email_addresses"][number];

describe("auth-hooks branch coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationsService.findOrCreateByClerkId).mockResolvedValue({
      id: "org-db-id",
    } as never);
    vi.mocked(organizationsService.updateByClerkId).mockResolvedValue(1);
    vi.mocked(organizationsService.findByClerkId).mockResolvedValue({
      id: "org-db-id",
    } as never);
    vi.mocked(usersService.upsertByClerkIdAndOrg).mockResolvedValue({
      id: "user-db-id",
    } as never);
    vi.mocked(usersService.updateByClerkId).mockResolvedValue(1);
    vi.mocked(usersService.deactivateByClerkIdAndOrg).mockResolvedValue({
      id: "user-db-id",
    } as never);
  });

  describe("handleUserCreated", () => {
    it("syncs a member into every organization membership when an email is present", async () => {
      const response = await handleUserCreated(
        buildUserPayload({
          emailAddresses: [buildEmailAddress("new@example.com")],
          memberships: [buildMembershipPayload()],
        })
      );

      expect(response.status).toBe(201);
      expect(organizationsService.findOrCreateByClerkId).toHaveBeenCalledTimes(
        1
      );
      expect(usersService.upsertByClerkIdAndOrg).toHaveBeenCalledTimes(1);
    });

    it("skips organization sync entirely when the payload has no email address", async () => {
      const response = await handleUserCreated(
        buildUserPayload({
          emailAddresses: [],
          memberships: [buildMembershipPayload()],
        })
      );

      expect(response.status).toBe(201);
      expect(organizationsService.findOrCreateByClerkId).not.toHaveBeenCalled();
      expect(usersService.upsertByClerkIdAndOrg).not.toHaveBeenCalled();
    });

    it("treats a null organization_memberships list as no memberships to sync", async () => {
      const response = await handleUserCreated(
        buildUserPayload({
          emailAddresses: [buildEmailAddress("solo@example.com")],
          memberships: null,
        })
      );

      expect(response.status).toBe(201);
      expect(organizationsService.findOrCreateByClerkId).not.toHaveBeenCalled();
      expect(usersService.upsertByClerkIdAndOrg).not.toHaveBeenCalled();
    });
  });

  describe("handleUserUpdated", () => {
    it("mirrors the update and returns 204 when the delivery carries a usable updated_at", async () => {
      vi.mocked(usersService.updateByClerkId).mockResolvedValue(1);

      const response = await handleUserUpdated(
        buildUserPayload({
          emailAddresses: [buildEmailAddress("mirror@example.com")],
          updatedAt: CLERK_STAMP,
        })
      );

      expect(response.status).toBe(204);
      expect(usersService.updateByClerkId).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ email: "mirror@example.com" }),
        new Date(CLERK_STAMP)
      );
      expect(log.info).not.toHaveBeenCalledWith(
        "[webhook/auth] user.updated mirrored no rows",
        expect.anything()
      );
    });

    // ISS-10335: this delivery is the only signal that a user's linked OAuth
    // accounts changed, so it must drop the memoized provider list — including
    // on the payload the mirror guard below refuses, which orders a DB write and
    // says nothing about a cache.
    it("drops the memoized provider list for the updated user", async () => {
      await handleUserUpdated(buildUserPayload({ updatedAt: Number.NaN }));

      expect(invalidateUserExternalAccountProviders).toHaveBeenCalledWith(
        "user_branch_coverage"
      );
    });

    it("skips the mirror write when updated_at is not a usable stamp", async () => {
      const response = await handleUserUpdated(
        buildUserPayload({ updatedAt: Number.NaN })
      );

      expect(response.status).toBe(204);
      expect(usersService.updateByClerkId).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "[webhook/auth] Skipped user mirror write: unusable updated_at",
        expect.objectContaining({ updatedAt: Number.NaN })
      );
    });

    it("logs a no-rows mirror when the update matches no mirrored user in any organization", async () => {
      vi.mocked(usersService.updateByClerkId).mockResolvedValue(0);

      const response = await handleUserUpdated(
        buildUserPayload({ updatedAt: CLERK_STAMP })
      );

      expect(response.status).toBe(204);
      expect(log.info).toHaveBeenCalledWith(
        "[webhook/auth] user.updated mirrored no rows",
        expect.objectContaining({ clerkUpdatedAt: CLERK_STAMP })
      );
    });
  });

  describe("handleUserDeleted", () => {
    it("skips deactivation and analytics when the deleted payload carries no id", async () => {
      const { analytics } = await import("@repo/analytics/server");

      const response = await handleUserDeleted(buildDeletedPayload("user"));

      expect(response.status).toBe(204);
      expect(usersService.deactivateAllByClerkId).not.toHaveBeenCalled();
      expect(analytics.identify).not.toHaveBeenCalled();
      expect(analytics.capture).not.toHaveBeenCalled();
    });
  });

  describe("handleOrganizationCreated", () => {
    it("captures an Organization Created event when created_by is present", async () => {
      const { analytics } = await import("@repo/analytics/server");

      const response = await handleOrganizationCreated(
        buildOrganizationPayload({ createdBy: "user_creator" })
      );

      expect(response.status).toBe(201);
      expect(analytics.capture).toHaveBeenCalledWith({
        event: "Organization Created",
        distinctId: "user_creator",
      });
    });

    it("skips the Organization Created event when created_by is absent", async () => {
      const { analytics } = await import("@repo/analytics/server");

      const response = await handleOrganizationCreated(
        buildOrganizationPayload({ createdBy: undefined })
      );

      expect(response.status).toBe(201);
      expect(analytics.capture).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "Organization Created" })
      );
    });
  });

  describe("handleOrganizationUpdated", () => {
    it("skips the Organization Updated event when created_by is absent", async () => {
      const { analytics } = await import("@repo/analytics/server");

      const response = await handleOrganizationUpdated(
        buildOrganizationPayload({ createdBy: undefined })
      );

      expect(response.status).toBe(204);
      expect(analytics.capture).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "Organization Updated" })
      );
    });

    it("logs an ignored stale delivery when the org mirror write matches no rows", async () => {
      vi.mocked(organizationsService.updateByClerkId).mockResolvedValue(0);

      const response = await handleOrganizationUpdated(
        buildOrganizationPayload({ updatedAt: CLERK_STAMP })
      );

      expect(response.status).toBe(204);
      expect(log.info).toHaveBeenCalledWith(
        "[webhook/auth] Ignored stale organization delivery",
        expect.objectContaining({
          eventType: "organization.updated",
          clerkUpdatedAt: CLERK_STAMP,
        })
      );
    });
  });

  describe("handleOrganizationDeleted", () => {
    it("falls back to <unknown> analytics identity and skips deactivation when the payload carries no id", async () => {
      const { analytics } = await import("@repo/analytics/server");

      const response = await handleOrganizationDeleted(
        buildDeletedPayload("organization")
      );

      expect(response.status).toBe(204);
      expect(analytics.groupIdentify).toHaveBeenCalledWith(
        expect.objectContaining({ groupKey: "<unknown>" })
      );
      expect(analytics.capture).toHaveBeenCalledWith(
        expect.objectContaining({ distinctId: "<unknown>" })
      );
      expect(organizationsService.deactivateByClerkId).not.toHaveBeenCalled();
    });
  });

  describe("handleOrganizationMembershipCreated", () => {
    it("still resolves the organization but skips member creation when the membership carries no user id", async () => {
      const response = await handleOrganizationMembershipCreated(
        buildMembershipPayload({ userId: "" })
      );

      expect(response.status).toBe(201);
      expect(organizationsService.findOrCreateByClerkId).toHaveBeenCalledTimes(
        1
      );
      expect(usersService.upsertByClerkIdAndOrg).not.toHaveBeenCalled();
      expect(clerkService.getUser).not.toHaveBeenCalled();
    });

    it("fetches the user from Clerk when the membership identifier is not email-shaped", async () => {
      vi.mocked(clerkService.getUser).mockResolvedValue({
        id: "user_phone_only",
        email: "resolved@example.com",
        firstName: "Resolved",
        lastName: "User",
        imageUrl: null,
        phoneNumber: "+15555550100",
      });

      const response = await handleOrganizationMembershipCreated(
        buildMembershipPayload({
          userId: "user_phone_only",
          identifier: "+15555550100",
        })
      );

      expect(response.status).toBe(201);
      expect(clerkService.getUser).toHaveBeenCalledWith("user_phone_only");
      expect(usersService.upsertByClerkIdAndOrg).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "resolved@example.com",
          phoneNumber: "+15555550100",
        })
      );
    });
  });

  describe("handleOrganizationMembershipDeleted", () => {
    it("skips organization lookup and deactivation when the membership carries no user id", async () => {
      const { analytics } = await import("@repo/analytics/server");

      const response = await handleOrganizationMembershipDeleted(
        buildMembershipPayload({ userId: "" })
      );

      expect(response.status).toBe(204);
      expect(organizationsService.findByClerkId).not.toHaveBeenCalled();
      expect(usersService.deactivateByClerkIdAndOrg).not.toHaveBeenCalled();
      expect(analytics.capture).toHaveBeenCalledWith(
        expect.objectContaining({ event: "Organization Member Deleted" })
      );
    });

    it("skips deactivation when the membership's organization has no mirrored row", async () => {
      vi.mocked(organizationsService.findByClerkId).mockResolvedValue(null);

      const response = await handleOrganizationMembershipDeleted(
        buildMembershipPayload({ userId: "user_no_org_row" })
      );

      expect(response.status).toBe(204);
      expect(usersService.deactivateByClerkIdAndOrg).not.toHaveBeenCalled();
    });

    it("swallows a P2025 not-found error when the user is already deactivated", async () => {
      const notFoundError = Object.assign(new Error("not found"), {
        code: "P2025",
      });
      vi.mocked(usersService.deactivateByClerkIdAndOrg).mockRejectedValue(
        notFoundError
      );

      const response = await handleOrganizationMembershipDeleted(
        buildMembershipPayload({ userId: "user_already_gone" })
      );

      expect(response.status).toBe(204);
      expect(log.info).toHaveBeenCalledWith(
        "User not found for deactivation, skipping",
        expect.objectContaining({ clerkId: "user_already_gone" })
      );
    });

    it("rethrows an unexpected deactivation error instead of swallowing it", async () => {
      vi.mocked(usersService.deactivateByClerkIdAndOrg).mockRejectedValue(
        new Error("connection reset")
      );

      await expect(
        handleOrganizationMembershipDeleted(
          buildMembershipPayload({ userId: "user_unexpected_failure" })
        )
      ).rejects.toThrow("connection reset");
    });
  });
});

function buildDeletedPayload(object: string): DeletedObjectJSON {
  return { object, deleted: true };
}

function buildEmailAddress(email: string): EmailAddressJSON {
  return {
    object: "email_address",
    id: `idn_${email}`,
    email_address: email,
    verification: null,
    linked_to: [],
  };
}

function buildUserPayload(
  overrides: {
    emailAddresses?: EmailAddressJSON[];
    memberships?: OrganizationMembershipJSON[] | null;
    updatedAt?: number;
  } = {}
): UserJSON {
  return {
    object: "user",
    id: "user_branch_coverage",
    username: null,
    first_name: "Branch",
    last_name: "Coverage",
    image_url: "",
    has_image: false,
    primary_email_address_id: null,
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: overrides.emailAddresses ?? [],
    phone_numbers: [],
    web3_wallets: [],
    organization_memberships: overrides.memberships ?? null,
    external_accounts: [],
    enterprise_accounts: [],
    password_last_updated_at: null,
    public_metadata: {},
    private_metadata: {},
    unsafe_metadata: {},
    external_id: null,
    last_sign_in_at: null,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: null,
    created_at: CLERK_STAMP,
    updated_at: overrides.updatedAt ?? CLERK_STAMP,
    last_active_at: null,
    create_organization_enabled: true,
    create_organizations_limit: null,
    delete_self_enabled: true,
    legal_accepted_at: null,
    locale: null,
  };
}

function buildOrganizationPayload(
  overrides: { createdBy?: string; updatedAt?: number } = {}
): OrganizationJSON {
  return {
    object: "organization",
    id: "org_branch_coverage",
    name: "Branch Coverage Org",
    slug: "branch-coverage-org",
    image_url: "",
    has_image: false,
    created_at: CLERK_STAMP,
    updated_at: overrides.updatedAt ?? CLERK_STAMP,
    public_metadata: {},
    private_metadata: {},
    max_allowed_memberships: 100,
    admin_delete_enabled: false,
    members_count: 1,
    created_by: overrides.createdBy,
  };
}

function buildMembershipPayload(
  overrides: { userId?: string; identifier?: string } = {}
): OrganizationMembershipJSON {
  return {
    object: "organization_membership",
    id: "orgmem_branch_coverage",
    public_metadata: {},
    role: "org:member",
    permissions: [],
    created_at: CLERK_STAMP,
    updated_at: CLERK_STAMP,
    organization: buildOrganizationPayload(),
    public_user_data: {
      identifier: overrides.identifier ?? "member@example.com",
      first_name: "Branch",
      last_name: "Member",
      image_url: "",
      has_image: false,
      user_id: overrides.userId ?? "user_branch_member",
    },
  };
}
