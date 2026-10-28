import { describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  findUserIdsByEmail: vi.fn(),
  listUserOrganizationMemberships: vi.fn(),
  getLastActiveOrganizationId: vi.fn(),
}));

vi.mock("@/lib/auth/clerk-service", () => ({ clerkService: clerk }));

import {
  VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
  VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN,
  VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
  VibeEnvironmentOrgChoice,
} from "../constants";
import {
  type ClerkLookup,
  type ClerkMembership,
  resolvePersonClerkIdentity,
} from "./person-identity";

const EMAIL = "andy@closedloop.example";

function lookup(
  userIds: string[],
  memberships: ClerkMembership[],
  lastActiveOrgId: () => Promise<string | undefined> = () =>
    Promise.resolve(undefined)
): ClerkLookup {
  return {
    findUserIdsByEmail: vi.fn(() => Promise.resolve(userIds)),
    listMemberships: vi.fn(() => Promise.resolve(memberships)),
    lastActiveOrgId: vi.fn(lastActiveOrgId),
  };
}

describe("resolvePersonClerkIdentity", () => {
  it("binds the person's only org and reports an admin role", async () => {
    const clerk = lookup(
      ["user_1"],
      [{ clerkOrgId: "org_a", name: "Org A", role: "org:admin" }]
    );

    await expect(
      resolvePersonClerkIdentity(EMAIL, undefined, clerk)
    ).resolves.toEqual({
      clerkUserId: "user_1",
      clerkOrgId: "org_a",
      clerkOrgName: "Org A",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.OnlyOrg,
    });
    expect(clerk.findUserIdsByEmail).toHaveBeenCalledWith(EMAIL);
    expect(clerk.listMemberships).toHaveBeenCalledWith("user_1");
  });

  it("reports a member role as not admin", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      undefined,
      lookup(
        ["user_1"],
        [{ clerkOrgId: "org_a", name: "Org A", role: "org:member" }]
      )
    );

    expect(resolved).toMatchObject({ clerkOrgId: "org_a", isOrgAdmin: false });
  });

  it("takes the requested org when the person belongs to it", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      "org_b",
      lookup(
        ["user_1"],
        [
          { clerkOrgId: "org_a", name: "Org A", role: "org:member" },
          { clerkOrgId: "org_b", name: "Org B", role: "org:admin" },
        ]
      )
    );

    expect(resolved).toMatchObject({
      clerkOrgId: "org_b",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.Requested,
    });
  });

  it.each([
    ["no user has the email", [], [], undefined],
    ["two users share the email", ["user_1", "user_2"], [], undefined],
    ["the person has no org", ["user_1"], [], undefined],
    [
      "the person has two orgs and none was chosen",
      ["user_1"],
      [
        { clerkOrgId: "org_a", name: "Org A", role: "org:admin" },
        { clerkOrgId: "org_b", name: "Org B", role: "org:admin" },
      ],
      undefined,
    ],
    [
      "the chosen org is not one of theirs",
      ["user_1"],
      [{ clerkOrgId: "org_a", name: "Org A", role: "org:admin" }],
      "org_z",
    ],
  ])("refuses when %s", async (_label, userIds, memberships, requested) => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      requested,
      lookup(userIds, memberships)
    );

    expect(resolved).toHaveProperty("refused");
  });

  it("lists every org by name and id when the person has several and nothing settles the choice", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      undefined,
      lookup(
        ["user_1"],
        [
          { clerkOrgId: "org_a", name: "ClosedLoop", role: "org:admin" },
          {
            clerkOrgId: "org_b",
            name: "Side Project (old)",
            role: "org:member",
          },
          { clerkOrgId: "org_c", name: "Acme Labs", role: "org:admin" },
        ]
      )
    );

    expect(resolved).toEqual({
      refused:
        "The person belongs to 3 stage Clerk orgs, and their Clerk sessions have no last active org; pass clerk_org_id to choose one",
      code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
      clerkOrgs: [
        { id: "org_a", name: "ClosedLoop", isAdmin: true },
        { id: "org_b", name: "Side Project (old)", isAdmin: false },
        { id: "org_c", name: "Acme Labs", isAdmin: true },
      ],
    });
  });

  it("binds the same org a seeded finalize would, so a Desktop session agrees with it", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      undefined,
      lookup(
        ["user_1"],
        [
          { clerkOrgId: "org_a", name: "ClosedLoop", role: "org:admin" },
          { clerkOrgId: "org_b", name: "Side Project", role: "org:member" },
        ]
      )
    );

    expect(resolved).toMatchObject({
      clerkOrgId: "org_a",
      chosenBy: VibeEnvironmentOrgChoice.OnlyAdminOrg,
    });
  });
});

describe("resolvePersonClerkIdentity for an org the person must administer (ISS-12135 bug 42)", () => {
  const ADMIN_ONLY = { requireAdmin: true };
  const ADMIN_A = {
    clerkOrgId: "org_a",
    name: "ClosedLoop",
    role: "org:admin",
  };
  const ADMIN_C = { clerkOrgId: "org_c", name: "Acme Labs", role: "org:admin" };
  const MEMBER_B = {
    clerkOrgId: "org_b",
    name: "Side Project",
    role: "org:member",
  };

  it("offers only the orgs the person administers when they belong to several", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      undefined,
      lookup(["user_1"], [ADMIN_A, MEMBER_B, ADMIN_C]),
      ADMIN_ONLY
    );

    expect(resolved).toEqual({
      refused:
        "The person belongs to 3 stage Clerk orgs and is an admin of 2 of them, and their Clerk sessions have no last active org; pass clerk_org_id to choose one",
      code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
      clerkOrgs: [
        { id: "org_a", name: "ClosedLoop", isAdmin: true },
        { id: "org_c", name: "Acme Labs", isAdmin: true },
      ],
    });
  });

  it.each([
    ["their only org", [MEMBER_B]],
    [
      "any of their orgs",
      [MEMBER_B, { clerkOrgId: "org_d", name: "Globex", role: "org:member" }],
    ],
  ])(
    "refuses with its own code when they administer none of %s",
    async (_label, memberships) => {
      const resolved = await resolvePersonClerkIdentity(
        EMAIL,
        undefined,
        lookup(["user_1"], memberships),
        ADMIN_ONLY
      );

      expect(resolved).toMatchObject({
        code: VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN,
        clerkOrgs: memberships.map((m) => ({
          id: m.clerkOrgId,
          name: m.name,
          isAdmin: false,
        })),
      });
      expect("refused" in resolved && resolved.refused).toContain(
        "Side Project (org_b)"
      );
    }
  );

  it("refuses a chosen org the person does not administer, naming it", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      "org_b",
      lookup(["user_1"], [ADMIN_A, MEMBER_B]),
      ADMIN_ONLY
    );

    expect(resolved).toEqual({
      refused: "The person is not an admin of Clerk org Side Project (org_b)",
      code: VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
      clerkOrgs: [
        { id: "org_a", name: "ClosedLoop", isAdmin: true },
        { id: "org_b", name: "Side Project", isAdmin: false },
      ],
    });
  });

  it("binds a chosen org or their only org when they administer it", async () => {
    await expect(
      resolvePersonClerkIdentity(
        EMAIL,
        "org_a",
        lookup(["user_1"], [ADMIN_A, MEMBER_B]),
        ADMIN_ONLY
      )
    ).resolves.toEqual({
      clerkUserId: "user_1",
      clerkOrgId: "org_a",
      clerkOrgName: "ClosedLoop",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.Requested,
    });
    await expect(
      resolvePersonClerkIdentity(
        EMAIL,
        undefined,
        lookup(["user_1"], [ADMIN_A]),
        ADMIN_ONLY
      )
    ).resolves.toMatchObject({
      clerkOrgId: "org_a",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.OnlyOrg,
    });
  });
});

describe("resolvePersonClerkIdentity without a chosen org (ISS-12135, Daveth Oakhurst's rule)", () => {
  const ADMIN_ONLY = { requireAdmin: true };
  const ADMIN_A = {
    clerkOrgId: "org_a",
    name: "ClosedLoop",
    role: "org:admin",
  };
  const ADMIN_C = { clerkOrgId: "org_c", name: "Acme Labs", role: "org:admin" };
  const MEMBER_B = {
    clerkOrgId: "org_b",
    name: "Side Project",
    role: "org:member",
  };
  const AMBIGUOUS_ADMIN_ORGS = [
    { id: "org_a", name: "ClosedLoop", isAdmin: true },
    { id: "org_c", name: "Acme Labs", isAdmin: true },
  ];

  it("binds the one org they administer without asking, and never reads the last active org", async () => {
    const clerk = lookup(["user_1"], [MEMBER_B, ADMIN_C], () =>
      Promise.resolve("org_b")
    );

    await expect(
      resolvePersonClerkIdentity(EMAIL, undefined, clerk, ADMIN_ONLY)
    ).resolves.toEqual({
      clerkUserId: "user_1",
      clerkOrgId: "org_c",
      clerkOrgName: "Acme Labs",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.OnlyAdminOrg,
    });
    expect(clerk.lastActiveOrgId).not.toHaveBeenCalled();
  });

  it("binds the org their Clerk session last had active when they administer several", async () => {
    const clerk = lookup(["user_1"], [ADMIN_A, MEMBER_B, ADMIN_C], () =>
      Promise.resolve("org_c")
    );

    await expect(
      resolvePersonClerkIdentity(EMAIL, undefined, clerk, ADMIN_ONLY)
    ).resolves.toEqual({
      clerkUserId: "user_1",
      clerkOrgId: "org_c",
      clerkOrgName: "Acme Labs",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.LastActive,
    });
    expect(clerk.lastActiveOrgId).toHaveBeenCalledWith("user_1");
  });

  it("falls back to asking when the last active org is one they do not administer", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      undefined,
      lookup(["user_1"], [ADMIN_A, MEMBER_B, ADMIN_C], () =>
        Promise.resolve("org_b")
      ),
      ADMIN_ONLY
    );

    expect(resolved).toEqual({
      refused:
        "The person belongs to 3 stage Clerk orgs and is an admin of 2 of them, and their last active Clerk org org_b is not one they administer; pass clerk_org_id to choose one",
      code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
      clerkOrgs: AMBIGUOUS_ADMIN_ORGS,
    });
  });

  it("falls back to asking when the last active org cannot be read", async () => {
    const resolved = await resolvePersonClerkIdentity(
      EMAIL,
      undefined,
      lookup(["user_1"], [ADMIN_A, ADMIN_C], () =>
        Promise.reject(new Error("Clerk is down"))
      ),
      ADMIN_ONLY
    );

    expect(resolved).toEqual({
      refused:
        "The person belongs to 2 stage Clerk orgs and is an admin of 2 of them, and their last active Clerk org could not be read; pass clerk_org_id to choose one",
      code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
      clerkOrgs: AMBIGUOUS_ADMIN_ORGS,
    });
  });

  it("prefers the org the environment already holds over the last active org", async () => {
    const clerk = lookup(["user_1"], [ADMIN_A, MEMBER_B, ADMIN_C], () =>
      Promise.resolve("org_c")
    );

    await expect(
      resolvePersonClerkIdentity(EMAIL, undefined, clerk, {
        boundOrgIds: ["org_a", "org_unrelated"],
      })
    ).resolves.toMatchObject({
      clerkOrgId: "org_a",
      chosenBy: VibeEnvironmentOrgChoice.AlreadyBound,
    });
    expect(clerk.lastActiveOrgId).not.toHaveBeenCalled();
  });

  it("lets an explicit clerk_org_id win over the last active org", async () => {
    const clerk = lookup(["user_1"], [ADMIN_A, ADMIN_C], () =>
      Promise.resolve("org_c")
    );

    await expect(
      resolvePersonClerkIdentity(EMAIL, "org_a", clerk, ADMIN_ONLY)
    ).resolves.toMatchObject({
      clerkOrgId: "org_a",
      chosenBy: VibeEnvironmentOrgChoice.Requested,
    });
    expect(clerk.lastActiveOrgId).not.toHaveBeenCalled();
  });

  it("still refuses with clerk_org_no_admin when they administer none, whatever was last active", async () => {
    const clerk = lookup(
      ["user_1"],
      [MEMBER_B, { clerkOrgId: "org_d", name: "Globex", role: "org:member" }],
      () => Promise.resolve("org_b")
    );

    await expect(
      resolvePersonClerkIdentity(EMAIL, undefined, clerk, ADMIN_ONLY)
    ).resolves.toMatchObject({ code: VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN });
    expect(clerk.lastActiveOrgId).not.toHaveBeenCalled();
  });
});

describe("resolvePersonClerkIdentity's production Clerk lookup (ISS-12135)", () => {
  it("reads the last active org from the Clerk service", async () => {
    clerk.findUserIdsByEmail.mockResolvedValue(["user_1"]);
    clerk.listUserOrganizationMemberships.mockResolvedValue([
      {
        organizationId: "org_a",
        organizationName: "ClosedLoop",
        role: "org:admin",
      },
      {
        organizationId: "org_c",
        organizationName: "Acme Labs",
        role: "org:admin",
      },
    ]);
    clerk.getLastActiveOrganizationId.mockResolvedValue("org_c");

    await expect(
      resolvePersonClerkIdentity(EMAIL, undefined, undefined, {
        requireAdmin: true,
      })
    ).resolves.toMatchObject({
      clerkOrgId: "org_c",
      chosenBy: VibeEnvironmentOrgChoice.LastActive,
    });
    expect(clerk.getLastActiveOrganizationId).toHaveBeenCalledWith("user_1");
  });
});
