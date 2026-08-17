/**
 * Edge cases for branchPhaseLifecycleFromAssociatedPullRequests:
 * the `collection?.items ?? []` binary-expression arm=1 —
 * triggered by passing undefined as the collection.
 */
import { describe, expect, it } from "vitest";
import { branchPhaseLifecycleFromAssociatedPullRequests } from "./branch-phase-lifecycle";

describe("branchPhaseLifecycleFromAssociatedPullRequests — undefined collection", () => {
  it("returns empty cycles and boundaries when collection is undefined (null-coalesce arm)", () => {
    // `collection?.items ?? []` — when collection is undefined, the `??` arm
    // (arm=1) fires and returns [], producing empty output.
    const result = branchPhaseLifecycleFromAssociatedPullRequests(undefined);
    expect(result).toEqual({
      pullRequestCycles: [],
      ambiguousWriteAfter: [],
    });
  });
});
