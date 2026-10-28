import { describe, expect, it } from "vitest";
import { parseDispatchRepo } from "../dispatch-repo";

describe("parseDispatchRepo", () => {
  it("returns the addressable target for a well-formed value", () => {
    expect(parseDispatchRepo("closedloop-ai/closedloop-ai")).toEqual({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
    });
  });

  it.each(["org/repo/extra", "org/repo/", "badformat", "", "/repo", "org/"])(
    "throws for %s rather than addressing the repo its first two segments name",
    (fullName) => {
      expect(() => parseDispatchRepo(fullName)).toThrow(
        "GITHUB_APP_DISPATCH_REPO must be exactly owner/repo"
      );
    }
  );
});
