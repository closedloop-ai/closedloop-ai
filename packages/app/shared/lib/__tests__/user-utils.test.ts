import { describe, expect, it } from "vitest";
import {
  compareAssigneeNames,
  getInitials,
  getUserDisplayName,
  getUserInitials,
  getUserNamePart,
  transformApiUserToSelectUser,
} from "../user-utils";

describe("getUserDisplayName", () => {
  it("joins first and last name", () => {
    expect(getUserDisplayName({ firstName: "Ada", lastName: "Lovelace" })).toBe(
      "Ada Lovelace"
    );
  });

  it("uses whichever name part is present", () => {
    expect(getUserDisplayName({ firstName: "Ada", lastName: null })).toBe(
      "Ada"
    );
    expect(getUserDisplayName({ firstName: null, lastName: "Lovelace" })).toBe(
      "Lovelace"
    );
  });

  it("falls back to email, then to a placeholder", () => {
    expect(
      getUserDisplayName({ firstName: null, lastName: null, email: "a@b.co" })
    ).toBe("a@b.co");
    expect(getUserDisplayName({ firstName: null, lastName: null })).toBe(
      "Unknown user"
    );
  });
});

describe("getUserNamePart", () => {
  it("joins first and last name", () => {
    expect(getUserNamePart({ firstName: "Ada", lastName: "Lovelace" })).toBe(
      "Ada Lovelace"
    );
  });

  it("uses whichever single name part is present", () => {
    expect(getUserNamePart({ firstName: "Ada", lastName: null })).toBe("Ada");
    expect(getUserNamePart({ firstName: null, lastName: "Lovelace" })).toBe(
      "Lovelace"
    );
  });

  it('returns "" when no name part is present (caller applies its own fallback)', () => {
    expect(getUserNamePart({ firstName: null, lastName: null })).toBe("");
  });

  it("does NOT trim a whitespace-only name part (byte-for-byte parity with the desktop renderer inline)", () => {
    // The renderer site never trimmed the joined result — a whitespace-only
    // firstName was returned as-is. `getUserNamePart` must preserve that so the
    // consolidation is behavior-preserving (unlike the desktop-main SSOT, which
    // trims). See user-utils.ts and FEA-3606.
    expect(getUserNamePart({ firstName: "   ", lastName: null })).toBe("   ");
  });
});

// FEA-3606 — desktop renderer (`desktop-account-tab.tsx` IdentityDetails) parity.
// The account tab previously inlined the name-part collapse, then applied its
// own divergent fallback chain (`|| email || userId || "—"`) plus a secondary
// email line. The consolidation only replaces the name-part collapse with the
// shared `getUserNamePart`; the surrounding derivation is unchanged. These pin
// the exact renderer outputs so the extraction stays byte-for-byte identical.
describe("desktop renderer identity derivation (FEA-3606 parity)", () => {
  // Faithful reproduction of the renderer's derivation, sourcing the name part
  // from the shared SSOT (the ONLY line the consolidation changed).
  function deriveIdentityRow(
    identity: {
      firstName: string | null;
      lastName: string | null;
      email?: string;
    } | null,
    userId: string
  ): { userValue: string; userSecondary: string | null } {
    const fullName = identity ? getUserNamePart(identity) : "";
    const userValue = fullName || identity?.email || userId || "—";
    const userSecondary = fullName && identity?.email ? identity.email : null;
    return { userValue, userSecondary };
  }

  it("shows the full name as the primary value, email as the secondary line", () => {
    expect(
      deriveIdentityRow(
        { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
        "user_123"
      )
    ).toEqual({ userValue: "Ada Lovelace", userSecondary: "ada@example.com" });
  });

  it("falls back name -> email when no name part is present (no secondary line)", () => {
    expect(
      deriveIdentityRow(
        { firstName: null, lastName: null, email: "only@example.com" },
        "user_123"
      )
    ).toEqual({ userValue: "only@example.com", userSecondary: null });
  });

  it("falls back email -> userId when neither name nor email is present", () => {
    expect(
      deriveIdentityRow({ firstName: null, lastName: null }, "user_123")
    ).toEqual({ userValue: "user_123", userSecondary: null });
  });

  it('falls back userId -> "—" when identity is null and there is no userId', () => {
    expect(deriveIdentityRow(null, "")).toEqual({
      userValue: "—",
      userSecondary: null,
    });
  });

  it("treats a whitespace-only name as a present primary value (untrimmed) with no secondary line", () => {
    // Because the renderer never trimmed, a whitespace-only name is truthy and
    // wins the `fullName || …` fallback — and `fullName && email` makes it the
    // primary while suppressing the secondary email line. This is the exact
    // pre-consolidation behavior, preserved via the untrimmed getUserNamePart.
    expect(
      deriveIdentityRow(
        { firstName: "   ", lastName: null, email: "ws@example.com" },
        "user_123"
      )
    ).toEqual({ userValue: "   ", userSecondary: "ws@example.com" });
  });

  it("suppresses the secondary line when a name is present but email is absent", () => {
    expect(
      deriveIdentityRow({ firstName: "Grace", lastName: null }, "user_123")
    ).toEqual({ userValue: "Grace", userSecondary: null });
  });
});

describe("getUserInitials", () => {
  it("uppercases the first character of each name", () => {
    expect(getUserInitials("ada", "lovelace")).toBe("AL");
    expect(getUserInitials("Ada", null)).toBe("A");
    expect(getUserInitials(null, null)).toBe("");
  });
});

describe("getInitials", () => {
  it("takes the first letter of up to two words", () => {
    expect(getInitials("John Doe")).toBe("JD");
    expect(getInitials("Alice")).toBe("A");
    expect(getInitials("mary jane watson")).toBe("MJ");
  });

  it("ignores extra whitespace", () => {
    expect(getInitials("John  Doe")).toBe("JD");
  });
});

describe("compareAssigneeNames", () => {
  it("sorts absent assignees last", () => {
    expect(compareAssigneeNames(null, null)).toBe(0);
    expect(
      compareAssigneeNames(null, { firstName: "Ada", lastName: null })
    ).toBe(1);
    expect(
      compareAssigneeNames({ firstName: "Ada", lastName: null }, null)
    ).toBe(-1);
  });

  it("orders present assignees by display name", () => {
    expect(
      compareAssigneeNames(
        { firstName: "Ada", lastName: null },
        { firstName: "Bea", lastName: null }
      )
    ).toBeLessThan(0);
  });
});

describe("transformApiUserToSelectUser", () => {
  it("maps fields and normalizes a null avatar to undefined", () => {
    expect(
      transformApiUserToSelectUser({
        id: "u1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        avatarUrl: null,
      })
    ).toEqual({
      id: "u1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: undefined,
      initials: "AL",
    });
  });
});
