import type {
  DeletedObjectJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
} from "@repo/auth/server";
import { describe, expect, it, vi } from "vitest";
import { usersService } from "@/app/users/service";
import {
  handleOrganizationDeleted,
  handleOrganizationMembershipDeleted,
  handleOrganizationMembershipUpdated,
  handleUserDeleted,
} from "@/app/webhooks/auth/auth-hooks";

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    identify: vi.fn(),
    capture: vi.fn(),
    groupIdentify: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findByClerkId: vi.fn(async () => ({ id: "org-db-id" })),
    deactivateByClerkId: vi.fn(async () => null),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    deactivateAllByClerkId: vi.fn(async () => [{ id: "user-db-id" }]),
    deactivateByClerkIdAndOrg: vi.fn(async () => ({ id: "user-db-id" })),
  },
}));

const CLERK_STAMP = 1_700_000_000_000;

function buildOrganizationPayload(): OrganizationJSON {
  return {
    object: "organization",
    id: "org_204_test",
    name: "Response Org",
    slug: "response-org",
    image_url: "",
    has_image: false,
    created_at: CLERK_STAMP,
    updated_at: CLERK_STAMP,
    public_metadata: {},
    private_metadata: {},
    max_allowed_memberships: 100,
    admin_delete_enabled: false,
    members_count: 1,
    created_by: "user_creator_204",
  };
}

function buildMembershipPayload(): OrganizationMembershipJSON {
  return {
    object: "organization_membership",
    id: "orgmem_204_test",
    public_metadata: {},
    role: "org:member",
    permissions: [],
    created_at: CLERK_STAMP,
    updated_at: CLERK_STAMP,
    organization: buildOrganizationPayload(),
    public_user_data: {
      identifier: "member-204@example.com",
      first_name: "Response",
      last_name: "Member",
      image_url: "",
      has_image: false,
      user_id: "user_204_test",
    },
  };
}

function buildDeletedPayload(id: string, object: string): DeletedObjectJSON {
  return { object, id, deleted: true };
}

/**
 * ISS-7132 review (whitlockk): these four handlers answered 204 with a BODY, which
 * is a TypeError under undici — the `Response` this route's Node runtime
 * provides. `POST` awaits every handler, so that throw became a 500 AFTER the
 * write had landed and Svix redelivered a payload already applied.
 *
 * Pinned in the unit tier rather than beside the ordering-guard cases in
 * `__tests__/integration/clerk-mirror-replay-guard.integration.test.ts`: the
 * fix is one `null` per handler with no database in it, and the DB-gated suite
 * self-skips wherever `DATABASE_URL` is unset — including a Stryker run against
 * the unit config, where the revert has to be caught rather than skipped. The
 * two handlers the guard itself touches keep their status assertions there,
 * where the stored row is asserted in the same case.
 */
describe("Clerk webhook 204 responses", () => {
  it("answers organizationMembership.updated body-less", () => {
    const response = handleOrganizationMembershipUpdated(
      buildMembershipPayload()
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("answers organizationMembership.deleted body-less", async () => {
    const response = await handleOrganizationMembershipDeleted(
      buildMembershipPayload()
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(usersService.deactivateByClerkIdAndOrg).toHaveBeenCalledWith(
      "user_204_test",
      "org-db-id"
    );
  });

  it("answers user.deleted body-less", async () => {
    const response = await handleUserDeleted(
      buildDeletedPayload("user_204_test", "user")
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("answers organization.deleted body-less", async () => {
    const response = await handleOrganizationDeleted(
      buildDeletedPayload("org_204_test", "organization")
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
