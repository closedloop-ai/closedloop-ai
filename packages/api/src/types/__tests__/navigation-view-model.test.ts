import { describe, expect, it } from "vitest";
import {
  deriveNavigationActorStanding,
  isPresentableCount,
  NavigationActorStanding,
  NavigationCountStatus,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
  toNavigationCount,
  withNavigationCounts,
} from "../navigation-view-model";
import { OrgAdminRole } from "../org-admin-role";

describe("toNavigationCount", () => {
  it("carries a measured count, including a real zero", () => {
    expect(toNavigationCount(7)).toEqual({
      status: NavigationCountStatus.Ready,
      value: 7,
    });
    // A measured zero is data. It is the UNMEASURED zero this contract refuses,
    // so the ready branch must still be able to say "genuinely none".
    expect(toNavigationCount(0)).toEqual({
      status: NavigationCountStatus.Ready,
      value: 0,
    });
  });

  // The whole impossible set, not the two that are usually remembered. Each of
  // these renders as a confident measurement if it reaches a badge.
  it.each([
    ["negative", -1],
    ["negative zero-adjacent", -0.5],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 2],
    // The blank field that becomes a measured `0` the moment anyone coerces it.
    // Refused here as the string it still is — once a caller has already run
    // `Number("")` the zero is indistinguishable from a real one, which is why
    // the coercion has to not happen rather than be caught.
    ["a blank string", ""],
    ["a numeric string", "3"],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
  ])("refuses %s rather than presenting it", (_label, value) => {
    expect(toNavigationCount(value)).toEqual({
      status: NavigationCountStatus.Unavailable,
    });
  });

  it("never yields a readable value for a refused input", () => {
    const refused = toNavigationCount(-4);
    // The structural guarantee: a caller cannot read a number off a non-ready
    // count, so "render the count" cannot degrade into "render 0".
    expect(refused).not.toHaveProperty("value");
  });

  it("agrees with its own predicate", () => {
    expect(isPresentableCount(3)).toBe(true);
    expect(isPresentableCount(3.5)).toBe(false);
  });
});

describe("deriveNavigationActorStanding", () => {
  it("reads an admin role as admin", () => {
    expect(
      deriveNavigationActorStanding({
        organizationId: "org_1",
        role: OrgAdminRole.Admin,
      })
    ).toBe(NavigationActorStanding.Admin);
    expect(
      deriveNavigationActorStanding({
        organizationId: "org_1",
        role: OrgAdminRole.Owner,
      })
    ).toBe(NavigationActorStanding.Admin);
  });

  it("reads a member of an organization as a member", () => {
    expect(
      deriveNavigationActorStanding({
        organizationId: "org_1",
        role: "org:member",
      })
    ).toBe(NavigationActorStanding.Member);
  });

  it("reads a null role inside a real organization as NOT a member", () => {
    // Both callers get null from a membership LOOKUP THAT FOUND NOTHING, so
    // null means "no membership here". Reading it as `Member` is what would
    // offer every org-scoped destination to a revoked user.
    const standing = deriveNavigationActorStanding({
      organizationId: "org_1",
      role: null,
    });

    expect(standing).toBe(NavigationActorStanding.NotAMember);
    expect(standing).not.toBe(NavigationActorStanding.Member);
  });

  it("keeps not-a-member distinct from no-organization", () => {
    expect(
      deriveNavigationActorStanding({ organizationId: "org_1", role: null })
    ).not.toBe(
      deriveNavigationActorStanding({ organizationId: null, role: null })
    );
  });

  it("keeps a missing organization distinct from membership, whatever the role says", () => {
    expect(
      deriveNavigationActorStanding({ organizationId: null, role: null })
    ).toBe(NavigationActorStanding.NoOrganization);
    // The load-bearing case: a stale admin role with no organization behind it
    // must not read as admin, or the shell offers org-scoped destinations to
    // someone who has no org to use them in.
    expect(
      deriveNavigationActorStanding({
        organizationId: null,
        role: OrgAdminRole.Admin,
      })
    ).toBe(NavigationActorStanding.NoOrganization);
  });
});

describe("withNavigationCounts", () => {
  const viewModel: NavigationViewModel = {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
    organizationId: "org-1",
    destinations: {
      inbox: { status: NavigationDestinationStatus.Ready },
      agents: {
        status: NavigationDestinationStatus.Ready,
        count: toNavigationCount(2),
      },
    },
  };

  it("attaches a host count to a destination the projection answered for", () => {
    const result = withNavigationCounts(
      viewModel,
      new Map([["inbox", toNavigationCount(5)]])
    );
    expect(result.destinations.inbox).toEqual({
      status: NavigationDestinationStatus.Ready,
      count: toNavigationCount(5),
    });
    expect(result.destinations.agents).toBe(viewModel.destinations.agents);
    expect(result.organizationId).toBe("org-1");
  });

  it("never mints a destination the projection did not answer for", () => {
    const result = withNavigationCounts(
      viewModel,
      new Map([["settings", toNavigationCount(1)]])
    );
    expect(Object.keys(result.destinations).sort()).toEqual([
      "agents",
      "inbox",
    ]);
  });
});
