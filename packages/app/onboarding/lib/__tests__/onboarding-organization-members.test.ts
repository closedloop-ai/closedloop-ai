import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import { describe, expect, it } from "vitest";
import {
  foldOnboardingOrganizationMembers,
  ONBOARDING_MEMBER_PREVIEW_LIMIT,
} from "../onboarding-organization-members";

const SIGNER_ID = "user-signer";

/**
 * ISS-8348. `GET /users` has no self-filter and returns the whole org, so every
 * distinction the invite step's copy depends on has to be made here.
 */
describe("foldOnboardingOrganizationMembers", () => {
  it("claims nothing while the roster read is unresolved", () => {
    expect(
      foldOnboardingOrganizationMembers({ status: "unresolved" }, SIGNER_ID)
    ).toEqual({ status: "unknown" });
  });

  it("treats a resolved but EMPTY roster as unknown, not a settled zero", () => {
    // A viewer scoped to no rows, and a signer whose own User row has not been
    // synced yet, both land here. Neither has established that the org is empty.
    expect(
      foldOnboardingOrganizationMembers(
        { status: "resolved", users: [] },
        SIGNER_ID
      )
    ).toEqual({ status: "unknown" });
  });

  it("claims nothing when the signer is unidentified", () => {
    // Without an identity to subtract, a roster of one cannot be told apart
    // from a team of one.
    expect(
      foldOnboardingOrganizationMembers(
        { status: "resolved", users: [makeUser({ id: SIGNER_ID })] },
        null
      )
    ).toEqual({ status: "unknown" });
  });

  it("reports a real zero when the roster is exactly the signer", () => {
    const members = foldOnboardingOrganizationMembers(
      { status: "resolved", users: [makeUser({ id: SIGNER_ID })] },
      SIGNER_ID
    );

    expect(members).toEqual({ status: "known", count: 0, preview: [] });
  });

  it("excludes the signer from the count and the preview", () => {
    const members = foldOnboardingOrganizationMembers(
      {
        status: "resolved",
        users: [
          makeUser({ id: SIGNER_ID, firstName: "Sol", lastName: "Founder" }),
          makeUser({ id: "u2", firstName: "Ada", lastName: "Lovelace" }),
        ],
      },
      SIGNER_ID
    );

    expect(members.status).toBe("known");
    if (members.status !== "known") {
      throw new Error("expected a known membership");
    }
    // Without self-exclusion this is 2, and the founder is their own social proof.
    expect(members.count).toBe(1);
    expect(members.preview.map((member) => member.name)).toEqual([
      "Ada Lovelace",
    ]);
  });

  it("previews the longest-tenured teammates, not the newest", () => {
    const members = foldOnboardingOrganizationMembers(
      {
        status: "resolved",
        users: [
          // Server order is `createdAt: desc`, so the newest arrives first.
          makeUser({ id: "new", firstName: "Newest", createdAt: "2026-08-01" }),
          makeUser({ id: "mid", firstName: "Middle", createdAt: "2026-04-01" }),
          makeUser({ id: "old", firstName: "Oldest", createdAt: "2024-01-01" }),
          makeUser({ id: SIGNER_ID }),
        ],
      },
      SIGNER_ID
    );

    if (members.status !== "known") {
      throw new Error("expected a known membership");
    }
    expect(members.preview.map((member) => member.name)).toEqual([
      "Oldest",
      "Middle",
      "Newest",
    ]);
  });

  it("caps the preview while still counting everyone else", () => {
    const teammates = Array.from({ length: 9 }, (_, index) =>
      makeUser({ id: `u${index}`, firstName: `Teammate${index}` })
    );

    const members = foldOnboardingOrganizationMembers(
      {
        status: "resolved",
        users: [...teammates, makeUser({ id: SIGNER_ID })],
      },
      SIGNER_ID
    );

    if (members.status !== "known") {
      throw new Error("expected a known membership");
    }
    expect(members.count).toBe(9);
    expect(members.preview).toHaveLength(ONBOARDING_MEMBER_PREVIEW_LIMIT);
  });

  it("gives a nameless teammate both a name and non-empty initials", () => {
    const members = foldOnboardingOrganizationMembers(
      {
        status: "resolved",
        users: [
          makeUser({
            id: "u2",
            firstName: null,
            lastName: null,
            email: "quiet@example.com",
          }),
          makeUser({ id: SIGNER_ID }),
        ],
      },
      SIGNER_ID
    );

    if (members.status !== "known") {
      throw new Error("expected a known membership");
    }
    const [member] = members.preview;
    expect(member?.name).toBe("quiet@example.com");
    // `getUserInitials(null, null)` is "", which renders an empty avatar circle
    // beside a real person.
    expect(member?.initials).not.toBe("");
  });

  it("keys teammates who share a display name separately", () => {
    const members = foldOnboardingOrganizationMembers(
      {
        status: "resolved",
        users: [
          makeUser({ id: "u2", firstName: "Alex", lastName: "Kim" }),
          makeUser({ id: "u3", firstName: "Alex", lastName: "Kim" }),
          makeUser({ id: SIGNER_ID }),
        ],
      },
      SIGNER_ID
    );

    if (members.status !== "known") {
      throw new Error("expected a known membership");
    }
    const ids = members.preview.map((member) => member.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function makeUser({
  createdAt = "2025-06-01",
  ...overrides
}: Partial<Omit<User, "createdAt">> & {
  createdAt?: string;
  id: string;
}): User {
  return {
    active: true,
    avatarUrl: null,
    clerkId: `clerk-${overrides.id}`,
    createdAt: new Date(createdAt),
    email: `${overrides.id}@example.com`,
    firstName: "Given",
    githubUsername: null,
    lastName: null,
    linearId: null,
    organizationId: "org-1",
    phoneNumber: null,
    role: ApproverRole.Engineer,
    slackId: null,
    updatedAt: new Date(createdAt),
    ...overrides,
  };
}
