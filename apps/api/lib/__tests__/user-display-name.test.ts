import { describe, expect, it } from "vitest";
import { displayUserName, formatUserFullName } from "@/lib/user-display-name";

describe("formatUserFullName", () => {
  it("joins both name parts", () => {
    expect(formatUserFullName({ firstName: "Ada", lastName: "Lovelace" })).toBe(
      "Ada Lovelace"
    );
  });

  it("drops a missing part", () => {
    expect(formatUserFullName({ firstName: "Ada", lastName: null })).toBe(
      "Ada"
    );
    expect(formatUserFullName({ firstName: null, lastName: "Lovelace" })).toBe(
      "Lovelace"
    );
  });

  it("drops empty-string parts without leaving stray separators", () => {
    expect(formatUserFullName({ firstName: "", lastName: "Lovelace" })).toBe(
      "Lovelace"
    );
  });

  it("normalizes surrounding whitespace", () => {
    expect(formatUserFullName({ firstName: "Ada ", lastName: null })).toBe(
      "Ada"
    );
  });

  it("returns an empty string when no name part is set", () => {
    expect(formatUserFullName({ firstName: null, lastName: null })).toBe("");
  });
});

describe("displayUserName", () => {
  it("prefers the full name", () => {
    expect(
      displayUserName({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      })
    ).toBe("Ada Lovelace");
  });

  it("falls back to email when no name part is set", () => {
    expect(
      displayUserName({
        firstName: null,
        lastName: null,
        email: "ada@example.com",
      })
    ).toBe("ada@example.com");
  });

  it("falls back to email when name parts are empty strings", () => {
    expect(
      displayUserName({ firstName: "", lastName: "", email: "ada@example.com" })
    ).toBe("ada@example.com");
  });
});
