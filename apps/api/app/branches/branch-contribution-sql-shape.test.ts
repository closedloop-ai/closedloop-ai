import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { eligibleBranchSessionEventExistsSql } from "./branch-analytics-rollup-sql";
import {
  branchLinkedSessionExistsSql,
  branchProductWroteExistsSql,
} from "./branch-contribution-sql";

describe("Branch contribution link-kind SQL", () => {
  it.each([
    ["linked-session", branchLinkedSessionExistsSql],
    ["Product-wrote", branchProductWroteExistsSql],
  ])(
    "keeps canonical multi-PR evidence in the %s selector",
    (_label, build) => {
      const query = build();

      expect(query.values).toEqual(
        expect.arrayContaining([
          SessionArtifactLinkKind.SessionPr,
          SessionArtifactLinkKind.SessionBranch,
          JSON.stringify([SessionArtifactLinkKind.SessionPrSet]),
        ])
      );
    }
  );

  it("keeps analytics on the canonical Wrote and unclassified legacy predicate", () => {
    const query = eligibleBranchSessionEventExistsSql();

    expect(query.values).toContain(BranchParticipationKind.Wrote);
    expect(query.values).toContain(BranchParticipationKind.Reviewed);
    expect(query.strings.join(" ")).toContain("branch_participation IS NULL");
    expect(query.strings.join(" ")).toContain("NOT");
  });
});
