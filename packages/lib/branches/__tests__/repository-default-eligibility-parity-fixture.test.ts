import { describe, expect, it } from "vitest";
import { repositoryDefaultEligibilityParityCases } from "./repository-default-eligibility-parity-fixture";

describe("repository default eligibility parity fixture", () => {
  it("uses unique names and covers the required fail-closed matrix", () => {
    const names = repositoryDefaultEligibilityParityCases.map(
      ({ name }) => name
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("custom default is excluded");
    expect(names).toContain("fork head uses its own authority");
    expect(names).toContain("missing authority fails closed");
    expect(names).toContain(
      "newest default replacement re-evaluates old evidence"
    );
  });
});
