import { describe, expect, it } from "vitest";
import { branchRows } from "../mock";
import { sortBranchRows } from "./branch-sort";

describe("sortBranchRows", () => {
  it("sorts Last active by its timestamp instead of the display label", () => {
    const sorted = sortBranchRows(branchRows, "lastActivity", "desc");

    expect(sorted.map(({ id }) => id)).toEqual([
      "br_1284",
      "br_1270",
      "br_1281",
      "br_session_cost",
      "br_saml",
      "br_dependabot",
      "br_1289",
      "br_dark_mode",
    ]);
  });
});
