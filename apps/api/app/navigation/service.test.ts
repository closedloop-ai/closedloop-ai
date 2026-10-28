import {
  NavigationActorStanding,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
} from "@repo/api/src/types/navigation-view-model";
import { OrgAdminRole } from "@repo/api/src/types/org-admin-role";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrganizationMembershipRole = vi.fn();

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: (...args: unknown[]) =>
      getOrganizationMembershipRole(...args),
  },
}));

const { navigationService } = await import("./service");
const { buildNavigationViewModel } = navigationService;

const DESTINATIONS = ["dashboard", "sessions", "branches"] as const;

function input(overrides: Record<string, unknown> = {}) {
  return {
    clerkOrgId: "org_clerk",
    clerkUserId: "user_clerk",
    destinationIds: DESTINATIONS,
    organizationId: "org_1",
    ...overrides,
  };
}

/**
 * The status of every requested destination, so a case asserts the whole set in
 * its own body rather than hiding an `expect` in a helper.
 */
function statuses(
  model: Awaited<ReturnType<typeof buildNavigationViewModel>>
): (NavigationDestinationStatus | undefined)[] {
  return DESTINATIONS.map((id) => model.destinations[id]?.status);
}

function allOf(
  status: NavigationDestinationStatus
): NavigationDestinationStatus[] {
  return DESTINATIONS.map(() => status);
}

describe("buildNavigationViewModel", () => {
  beforeEach(() => {
    getOrganizationMembershipRole.mockReset();
  });

  it("projects an admin", async () => {
    getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Admin);

    const model = await buildNavigationViewModel(input());

    expect(model.projectionStatus).toBe(NavigationProjectionStatus.Ready);
    expect(model.standing).toBe(NavigationActorStanding.Admin);
    expect(statuses(model)).toEqual(allOf(NavigationDestinationStatus.Ready));
  });

  it("projects an owner as an admin", async () => {
    getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Owner);

    const model = await buildNavigationViewModel(input());

    expect(model.standing).toBe(NavigationActorStanding.Admin);
  });

  it("projects a member", async () => {
    getOrganizationMembershipRole.mockResolvedValue("org:member");

    const model = await buildNavigationViewModel(input());

    expect(model.projectionStatus).toBe(NavigationProjectionStatus.Ready);
    expect(model.standing).toBe(NavigationActorStanding.Member);
    expect(statuses(model)).toEqual(allOf(NavigationDestinationStatus.Ready));
  });

  it("does NOT grant a destination to an actor with no membership in the org", async () => {
    // Clerk answers an empty membership list with null — a revoked user, or one
    // caught mid-propagation. The admin gate would file this under the same
    // `not_admin` as an ordinary member, which is exactly how it would become a
    // grant of every org-scoped destination.
    getOrganizationMembershipRole.mockResolvedValue(null);

    const model = await buildNavigationViewModel(input());

    expect(model.standing).toBe(NavigationActorStanding.NotAMember);
    expect(model.standing).not.toBe(NavigationActorStanding.Member);
    expect(statuses(model)).toEqual(
      allOf(NavigationDestinationStatus.Forbidden)
    );
  });

  it("reports a FAILED role read as a failed projection, never as a member", async () => {
    getOrganizationMembershipRole.mockRejectedValue(new Error("clerk down"));

    const model = await buildNavigationViewModel(input());

    // A provider outage must not read as a permission change: silently
    // downgrading an admin to a member would hide destinations they still have.
    expect(model.projectionStatus).toBe(NavigationProjectionStatus.Error);
    expect(model.standing).toBe(NavigationActorStanding.Unknown);
    expect(model.standing).not.toBe(NavigationActorStanding.Member);
    expect(Object.keys(model.destinations)).toHaveLength(0);
  });

  it("projects an actor with no organization as forbidden, without asking the provider", async () => {
    const model = await buildNavigationViewModel(
      input({ clerkOrgId: null, organizationId: null })
    );

    expect(model.standing).toBe(NavigationActorStanding.NoOrganization);
    expect(model.organizationId).toBeNull();
    // A settled answer, not a failed read: the destinations are org-scoped and
    // genuinely unusable, so this is not something the user should retry.
    expect(model.projectionStatus).toBe(NavigationProjectionStatus.Ready);
    expect(statuses(model)).toEqual(
      allOf(NavigationDestinationStatus.Forbidden)
    );
    expect(getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it("keeps no-organization distinct from not-a-member", async () => {
    getOrganizationMembershipRole.mockResolvedValue(null);
    const notAMember = await buildNavigationViewModel(input());
    const noOrg = await buildNavigationViewModel(
      input({ clerkOrgId: null, organizationId: null })
    );

    expect(notAMember.standing).not.toBe(noOrg.standing);
  });

  it("answers only for the destinations it was asked about", async () => {
    getOrganizationMembershipRole.mockResolvedValue("org:member");

    const model = await buildNavigationViewModel(
      input({ destinationIds: ["sessions"] })
    );

    expect(Object.keys(model.destinations)).toEqual(["sessions"]);
  });

  it("builds the destination map without an object prototype", async () => {
    getOrganizationMembershipRole.mockResolvedValue("org:member");

    const model = await buildNavigationViewModel(
      input({ destinationIds: ["__proto__", "sessions"] })
    );

    expect(Object.getPrototypeOf(model.destinations)).toBeNull();
    expect(model.destinations.sessions?.status).toBe(
      NavigationDestinationStatus.Ready
    );
  });
});
