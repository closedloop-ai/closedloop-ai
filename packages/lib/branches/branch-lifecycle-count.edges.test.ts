/**
 * Edge cases for branch-lifecycle-count: the assertUnreachablePrState default
 * arm (line 74) — exercised by casting an unknown state through the type.
 */
import { describe, expect, it } from "vitest";
import { derivePrLifecycle } from "./branch-lifecycle-count";

describe("derivePrLifecycle — assertUnreachablePrState", () => {
  it("throws for an unknown GitHubPRState value that bypasses the union (switch default arm)", () => {
    // Cast an unknown string through the type boundary to exercise the
    // default: assertUnreachablePrState(input.prState) path.
    expect(() =>
      derivePrLifecycle({
        prState: "UNKNOWN_STATE" as Parameters<
          typeof derivePrLifecycle
        >[0]["prState"],
        mergedAt: null,
      })
    ).toThrow("Unhandled GitHubPRState");
  });
});
