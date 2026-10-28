import { describe, expect, it } from "vitest";
import { requireRepositoryIdentity } from "./repository-identity";

describe("requireRepositoryIdentity", () => {
  it("returns the addressable target for a well-formed name", () => {
    expect(requireRepositoryIdentity("closedloop-ai/closedloop-ai")).toEqual({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
    });
  });

  it.each(["org/repo/extra", "badformat", "", "/repo", "org/"])(
    "throws for %s rather than addressing the repo its first two segments name",
    (fullName) => {
      expect(() => requireRepositoryIdentity(fullName)).toThrow(
        "Invalid repository fullName format"
      );
    }
  );
});
