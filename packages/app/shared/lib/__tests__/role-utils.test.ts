import { describe, expect, it } from "vitest";
import { isAdminRole } from "../role-utils";

describe("isAdminRole", () => {
  it("accepts admin and owner roles", () => {
    expect(isAdminRole("org:admin")).toBe(true);
    expect(isAdminRole("org:owner")).toBe(true);
  });

  it("rejects member and unknown roles", () => {
    expect(isAdminRole("org:member")).toBe(false);
    expect(isAdminRole("org:billing")).toBe(false);
  });

  it("rejects empty and undefined roles", () => {
    expect(isAdminRole("")).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});
