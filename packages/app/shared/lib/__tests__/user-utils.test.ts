import { describe, expect, it } from "vitest";
import {
  compareAssigneeNames,
  getInitials,
  getUserDisplayName,
  getUserInitials,
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
