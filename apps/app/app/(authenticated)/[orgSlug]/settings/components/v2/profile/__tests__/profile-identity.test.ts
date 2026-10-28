import {
  getInitials,
  getUserDisplayName,
} from "@repo/app/shared/lib/user-utils";
import { describe, expect, it } from "vitest";
import { type ClerkUser, profileIdentityFromUser } from "../profile-identity";

/**
 * Clerk resources carry far more than this projection reads. The cast is the
 * test-code exemption to the double-cast rule: constructing a real
 * `UserResource` would mean stubbing dozens of methods none of which this
 * adapter touches.
 */
function fakeUser(overrides: Record<string, unknown> = {}): ClerkUser {
  return {
    deleteSelfEnabled: true,
    externalAccounts: [],
    firstName: "Ada",
    imageUrl: "https://img.example/ada.png",
    lastName: "Lovelace",
    passwordEnabled: false,
    primaryEmailAddress: { emailAddress: "ada@example.com" },
    ...overrides,
  } as unknown as ClerkUser;
}

describe("profileIdentityFromUser", () => {
  it("delegates the display name to the canonical helper rather than re-deriving it", () => {
    // Asserting the canonical result, not a literal: a re-implemented naming
    // rule that happened to agree on "Ada Lovelace" would still fail here the
    // moment the shared rule changed.
    const user = fakeUser();

    expect(profileIdentityFromUser(user).displayName).toBe(
      getUserDisplayName({
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      })
    );
  });

  it("falls back to the email address when Clerk holds no name parts", () => {
    const user = fakeUser({ firstName: null, lastName: null });

    expect(profileIdentityFromUser(user).displayName).toBe(
      getUserDisplayName({
        email: "ada@example.com",
        firstName: null,
        lastName: null,
      })
    );
  });

  // One initial on every avatar (Nerys, 2026-10-22).
  it("builds the initial from the first name", () => {
    expect(profileIdentityFromUser(fakeUser()).initials).toBe("A");
  });

  it("falls back to initials of the display name when there are no name parts", () => {
    const identity = profileIdentityFromUser(
      fakeUser({ firstName: null, lastName: null })
    );

    // Pinned to the canonical helper, not a literal: with no name parts the
    // display name is the email address, and `getInitials` takes one letter
    // from it. A literal here would encode this adapter's own guess at a rule
    // it deliberately does not own.
    expect(identity.initials).toBe(
      getInitials(
        getUserDisplayName({
          email: "ada@example.com",
          firstName: null,
          lastName: null,
        })
      )
    );
    expect(identity.initials).not.toBe("");
  });

  it("reports a missing primary email as absent instead of an empty string", () => {
    const identity = profileIdentityFromUser(
      fakeUser({ primaryEmailAddress: null })
    );

    expect(identity.primaryEmail).toBeNull();
  });

  it("reports a blank Clerk avatar url as absent so the initials fallback renders", () => {
    expect(
      profileIdentityFromUser(fakeUser({ imageUrl: "" })).imageUrl
    ).toBeNull();
  });

  it("carries passwordEnabled through in both directions", () => {
    expect(profileIdentityFromUser(fakeUser()).passwordEnabled).toBe(false);
    expect(
      profileIdentityFromUser(fakeUser({ passwordEnabled: true }))
        .passwordEnabled
    ).toBe(true);
  });

  it("carries deleteSelfEnabled through in both directions", () => {
    expect(profileIdentityFromUser(fakeUser()).deleteSelfEnabled).toBe(true);
    expect(
      profileIdentityFromUser(fakeUser({ deleteSelfEnabled: false }))
        .deleteSelfEnabled
    ).toBe(false);
  });

  it("emits no subtitle, because Clerk has no field the prototype's one came from", () => {
    // The prototype shows "Product builder" under the name. That is fixture
    // data with no source; inventing a plausible role would be a fabricated
    // value, not a nicety.
    expect(profileIdentityFromUser(fakeUser())).not.toHaveProperty("subtitle");
  });
});
