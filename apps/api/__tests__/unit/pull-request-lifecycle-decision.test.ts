import type { PullRequest } from "@octokit/webhooks-types";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  type LifecyclePrState,
  pullRequestState,
  shouldApplyCurrentBranchPrEvent,
  shouldApplyPullRequestLifecycleUpdate,
} from "@/app/webhooks/github/handlers/pull-request-lifecycle-decision";

/**
 * Pure predicates extracted from the (grandfathered) pull_request handler.
 * These exercise the webhook at-least-once / stale-event protections directly,
 * without a transaction client.
 */

function makeCurrent(
  overrides: Partial<LifecyclePrState> = {}
): LifecyclePrState {
  return {
    currentPullRequestDetailId: null,
    pullRequestDetailId: null,
    prState: GitHubPRState.Open,
    isDraft: false,
    closedAt: null,
    mergedAt: null,
    headSha: "sha-1",
    hasBranchArtifact: false,
    ...overrides,
  };
}

type IncomingOverrides = {
  state?: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  updatedAt?: string;
  headSha?: string;
};

function makeIncoming(overrides: IncomingOverrides = {}): PullRequest {
  return {
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
    draft: overrides.draft ?? false,
    updated_at: overrides.updatedAt ?? "2026-07-31T12:00:00.000Z",
    head: { sha: overrides.headSha ?? "sha-1" },
  } as PullRequest;
}

describe("pullRequestState", () => {
  it("maps closed+merged to Merged", () => {
    expect(
      pullRequestState(makeIncoming({ state: "closed", merged: true }))
    ).toBe(GitHubPRState.Merged);
  });

  it("maps closed+unmerged to Closed", () => {
    expect(
      pullRequestState(makeIncoming({ state: "closed", merged: false }))
    ).toBe(GitHubPRState.Closed);
  });

  it("maps open to Open", () => {
    expect(pullRequestState(makeIncoming({ state: "open" }))).toBe(
      GitHubPRState.Open
    );
  });
});

describe("shouldApplyPullRequestLifecycleUpdate", () => {
  it("applies when there is no persisted PR", () => {
    expect(
      shouldApplyPullRequestLifecycleUpdate(null, makeIncoming(), "opened")
    ).toEqual({ apply: true });
  });

  it("suppresses a duplicate redelivery (same state/draft/sha, non-edit/non-sync action)", () => {
    const decision = shouldApplyPullRequestLifecycleUpdate(
      makeCurrent({ prState: GitHubPRState.Open, headSha: "sha-1" }),
      makeIncoming({ headSha: "sha-1" }),
      "ready_for_review"
    );
    expect(decision).toEqual({ apply: false, reason: "duplicate" });
  });

  it("does not treat an edit or synchronize as a duplicate (they carry real changes)", () => {
    const base = makeCurrent({ prState: GitHubPRState.Open, headSha: "sha-1" });
    const incoming = makeIncoming({ headSha: "sha-1" });
    expect(
      shouldApplyPullRequestLifecycleUpdate(base, incoming, "edited")
    ).toEqual({ apply: true });
    expect(
      shouldApplyPullRequestLifecycleUpdate(base, incoming, "synchronize")
    ).toEqual({ apply: true });
  });

  it("never overwrites a merged terminal state", () => {
    const decision = shouldApplyPullRequestLifecycleUpdate(
      makeCurrent({ prState: GitHubPRState.Merged }),
      makeIncoming({ state: "open", headSha: "sha-2" }),
      "reopened"
    );
    expect(decision).toEqual({ apply: false, reason: "merged_terminal" });
  });

  it("drops an open-ish event older than the terminal timestamp", () => {
    const decision = shouldApplyPullRequestLifecycleUpdate(
      makeCurrent({
        prState: GitHubPRState.Closed,
        closedAt: new Date("2026-07-31T13:00:00.000Z"),
      }),
      makeIncoming({
        state: "open",
        updatedAt: "2026-07-31T12:00:00.000Z",
        headSha: "sha-2",
      }),
      "synchronize"
    );
    expect(decision).toEqual({ apply: false, reason: "stale_open_event" });
  });

  it("blocks a non-reopen open-ish action on a closed PR", () => {
    const decision = shouldApplyPullRequestLifecycleUpdate(
      makeCurrent({ prState: GitHubPRState.Closed }),
      makeIncoming({ state: "open", headSha: "sha-2" }),
      "synchronize"
    );
    expect(decision).toEqual({
      apply: false,
      reason: "closed_terminal_for_action",
    });
  });

  it("applies a reopen on a closed PR", () => {
    const decision = shouldApplyPullRequestLifecycleUpdate(
      makeCurrent({ prState: GitHubPRState.Closed }),
      makeIncoming({ state: "open", headSha: "sha-2" }),
      "reopened"
    );
    expect(decision).toEqual({ apply: true });
  });
});

describe("shouldApplyCurrentBranchPrEvent", () => {
  it("applies when there is no branch artifact", () => {
    expect(
      shouldApplyCurrentBranchPrEvent(makeCurrent({ hasBranchArtifact: false }))
    ).toBe(true);
  });

  it("applies when either detail id is missing", () => {
    expect(
      shouldApplyCurrentBranchPrEvent(
        makeCurrent({
          hasBranchArtifact: true,
          currentPullRequestDetailId: "detail-1",
          pullRequestDetailId: null,
        })
      )
    ).toBe(true);
  });

  it("suppresses a stale event whose detail is not the branch's current PR", () => {
    expect(
      shouldApplyCurrentBranchPrEvent(
        makeCurrent({
          hasBranchArtifact: true,
          currentPullRequestDetailId: "detail-current",
          pullRequestDetailId: "detail-other",
        })
      )
    ).toBe(false);
  });

  it("applies when the event's detail is the branch's current PR", () => {
    expect(
      shouldApplyCurrentBranchPrEvent(
        makeCurrent({
          hasBranchArtifact: true,
          currentPullRequestDetailId: "detail-x",
          pullRequestDetailId: "detail-x",
        })
      )
    ).toBe(true);
  });
});
