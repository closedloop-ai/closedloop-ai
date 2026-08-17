import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  deriveLifecycleBadge,
  LifecycleTone,
} from "../merge-status-derivation";

describe("deriveLifecycleBadge", () => {
  it.each([
    [BranchStatus.Open, "Open", LifecycleTone.Open],
    [BranchStatus.Review, "In review", LifecycleTone.Review],
    [BranchStatus.Merged, "Merged", LifecycleTone.Merged],
    [BranchStatus.Draft, "Draft", LifecycleTone.Draft],
    [BranchStatus.Blocked, "Blocked", LifecycleTone.Blocked],
    [BranchStatus.Closed, "Closed", LifecycleTone.Closed],
  ])("maps the projected %s status to %s", (status, label, tone) => {
    expect(
      deriveLifecycleBadge({ persisted: { prState: null, status } })
    ).toEqual({ label, tone });
  });

  it.each([
    [GitHubPRState.Merged, "Merged", LifecycleTone.Merged],
    [GitHubPRState.Closed, "Closed", LifecycleTone.Closed],
    [GitHubPRState.Open, "Open", LifecycleTone.Open],
  ])("falls back to the projected PR state %s when no branch status is set", (prState, label, tone) => {
    expect(
      deriveLifecycleBadge({ persisted: { prState, status: null } })
    ).toEqual({ label, tone });
  });

  it("prefers the branch status over the PR state when both are present", () => {
    expect(
      deriveLifecycleBadge({
        persisted: { prState: GitHubPRState.Open, status: BranchStatus.Merged },
      })
    ).toEqual({ label: "Merged", tone: LifecycleTone.Merged });
  });

  it("says the status is unavailable rather than guessing one when the projection holds neither", () => {
    expect(
      deriveLifecycleBadge({ persisted: { prState: null, status: null } })
    ).toEqual({ label: "Status unavailable", tone: LifecycleTone.Gated });
  });
});
