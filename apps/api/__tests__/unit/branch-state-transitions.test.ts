import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  applyDeleteTransition,
  applyHeadTransition,
  decideBranchStatus,
  resolveBaseProvenance,
  scheduleFileChangeCacheRefresh,
} from "@/app/branches/branch-state-transitions";

const ZERO_GIT_SHA = "0000000000000000000000000000000000000000";

describe("branchService helpers", () => {
  it("rejects stale push observations without clobbering stored head state", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-3",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "unrelated",
      },
      {
        headSha: "sha-2",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: "sha-1",
      }
    );

    expect(result).toMatchObject({
      accepted: false,
      reason: "stale_push",
      headSha: "sha-2",
      lastPushBeforeSha: "sha-1",
    });
  });

  it("accepts force-push-back-to-earlier-SHA when stored head matches before", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-earlier",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "sha-current",
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: "sha-previous",
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "sequential_push",
      headSha: "sha-earlier",
      lastPushBeforeSha: "sha-current",
    });
  });

  it("accepts GitHub-created zero-before pushes as tombstoned branch recreates", () => {
    const observedAt = new Date("2026-05-15T04:00:00Z");
    const deletedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-recreated",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        observedAt,
        isCreate: true,
      },
      {
        headSha: "sha-before-delete",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T02:00:00Z"),
        lastPushBeforeSha: "sha-before-delete-parent",
        deletedAt,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "recreated_after_delete",
      headSha: "sha-recreated",
      headShaObservedAt: observedAt,
      lastPushBeforeSha: ZERO_GIT_SHA,
    });
  });

  it("accepts delete-first tombstone recreates even when no head is stored", () => {
    const observedAt = new Date("2026-05-15T04:00:00Z");
    const deletedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-recreated",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        observedAt,
        isCreate: true,
      },
      {
        headSha: null,
        headShaSource: null,
        headShaObservedAt: null,
        lastPushBeforeSha: null,
        deletedAt,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "recreated_after_delete",
      headSha: "sha-recreated",
      lastPushBeforeSha: ZERO_GIT_SHA,
    });
  });

  it("rejects original create redeliveries after delete as stale pushes", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-before-delete",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        observedAt: new Date("2026-05-15T01:00:00Z"),
        isCreate: true,
      },
      {
        headSha: "sha-before-delete",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T01:00:00Z"),
        lastPushBeforeSha: ZERO_GIT_SHA,
        deletedAt: new Date("2026-05-15T03:00:00Z"),
      }
    );

    expect(result).toMatchObject({
      accepted: false,
      reason: "stale_push",
      headSha: "sha-before-delete",
      lastPushBeforeSha: ZERO_GIT_SHA,
    });
  });

  it("does not treat zero-before create pushes as recreates for active branches", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-recreated",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        isCreate: true,
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T02:00:00Z"),
        lastPushBeforeSha: "sha-parent",
      }
    );

    expect(result).toMatchObject({
      accepted: false,
      reason: "stale_push",
      headSha: "sha-current",
    });
  });

  it("treats duplicate harness head callbacks as idempotent replays", () => {
    const observedAt = new Date("2026-05-15T00:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.HarnessInput,
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: observedAt,
        lastPushBeforeSha: "sha-previous",
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "duplicate_harness_input",
      headSha: "sha-current",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: "sha-previous",
    });
  });

  it("accepts same-head push webhooks as remote confirmation for non-push branches", () => {
    const observedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "sha-previous",
        observedAt,
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: null,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "push_confirmed",
      headSha: "sha-current",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: "sha-previous",
    });
  });

  it("keeps same-head push confirmation observed time monotonic", () => {
    const existingObservedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "sha-previous",
        observedAt: new Date("2026-05-15T01:00:00Z"),
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: existingObservedAt,
        lastPushBeforeSha: null,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "push_confirmed",
      headShaObservedAt: existingObservedAt,
    });
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt: new Date("2026-05-15T02:00:00Z"),
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-current",
        currentHeadSha: result.headSha,
        currentHeadShaObservedAt: result.headShaObservedAt,
      })
    ).toBeNull();
  });

  it("accepts newer harness callbacks for an existing materialized branch", () => {
    const observedAt = new Date("2026-05-15T00:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-from-new-callback",
        headShaSource: BranchHeadShaSource.HarnessInput,
      },
      {
        headSha: "sha-from-existing-branch",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: observedAt,
        lastPushBeforeSha: "sha-before-newer-head",
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "authoritative_refresh",
      headSha: "sha-from-new-callback",
      headShaSource: BranchHeadShaSource.HarnessInput,
      headShaObservedAt: expect.any(Date),
      lastPushBeforeSha: null,
    });
  });

  it("keeps higher-priority PR base provenance over repository default", () => {
    const result = resolveBaseProvenance(
      {
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      },
      {
        baseBranch: "release",
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      }
    );

    expect(result).toEqual({
      baseBranch: "release",
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    });
  });

  it("does not schedule cache refresh for rejected head transitions", () => {
    const schedule = scheduleFileChangeCacheRefresh({
      isDelete: false,
      headTransition: {
        accepted: false,
        reason: "stale_push",
        headSha: "sha-2",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: null,
        lastPushBeforeSha: "sha-1",
      },
    });

    expect(schedule).toEqual({ shouldSchedule: false });
  });

  it("does not schedule cache refresh for duplicate harness callbacks", () => {
    const schedule = scheduleFileChangeCacheRefresh({
      isDelete: false,
      headTransition: {
        accepted: true,
        reason: "duplicate_harness_input",
        headSha: "sha-from-existing-branch",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: "sha-before-newer-head",
      },
    });

    expect(schedule).toEqual({ shouldSchedule: false });
  });

  it("preserves current PR status when no PR or delete input is authoritative", () => {
    expect(decideBranchStatus({ currentStatus: GitHubPRState.Merged })).toBe(
      GitHubPRState.Merged
    );
    expect(decideBranchStatus({ currentStatus: GitHubPRState.Closed })).toBe(
      GitHubPRState.Closed
    );
  });

  it("uses PR state as the authoritative branch status when present", () => {
    expect(
      decideBranchStatus({
        currentStatus: GitHubPRState.Merged,
        pullRequestState: GitHubPRState.Open,
      })
    ).toBe(GitHubPRState.Open);
  });

  it("applies delete transitions while preserving merged terminal state", () => {
    const deletedAt = new Date("2026-05-15T03:00:00Z");

    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt,
        currentStatus: GitHubPRState.Merged,
      })
    ).toEqual({ deletedAt, status: GitHubPRState.Merged });
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt,
        currentStatus: GitHubPRState.Open,
      })
    ).toEqual({ deletedAt, status: GitHubPRState.Closed });
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt,
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-current",
        currentHeadSha: "sha-current",
        currentHeadShaObservedAt: new Date("2026-05-15T02:00:00Z"),
      })
    ).toEqual({ deletedAt, status: GitHubPRState.Closed });
    expect(applyDeleteTransition({ isDelete: false })).toBeNull();
  });

  it("rejects stale delete redeliveries after a newer head observation", () => {
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt: new Date("2026-05-15T03:00:00Z"),
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-recreated",
        currentHeadSha: "sha-recreated",
        currentHeadShaObservedAt: new Date("2026-05-15T04:00:00Z"),
      })
    ).toBeNull();
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt: new Date("2026-05-15T05:00:00Z"),
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-before-delete",
        currentHeadSha: "sha-recreated",
        currentHeadShaObservedAt: new Date("2026-05-15T04:00:00Z"),
      })
    ).toBeNull();
  });
});
