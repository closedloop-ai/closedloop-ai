import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDeleteTransition,
  applyHeadTransition,
  decideBranchStatus,
  resolveBaseProvenance,
} from "./branch-state-transitions";

describe("decideBranchStatus", () => {
  it("keeps a deleted branch Merged when its current status was already Merged", () => {
    expect(
      decideBranchStatus({
        isDelete: true,
        currentStatus: GitHubPRState.Merged,
      })
    ).toBe(GitHubPRState.Merged);
  });
});

describe("resolveBaseProvenance", () => {
  it("keeps a null existing base branch when its higher-priority source wins", () => {
    const result = resolveBaseProvenance(
      {
        baseBranch: "feature/mcp-input",
        baseBranchSource: BranchBaseBranchSource.McpInput,
      },
      {
        baseBranch: null,
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      }
    );

    expect(result).toEqual({
      baseBranch: null,
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    });
  });
});

describe("applyHeadTransition", () => {
  it("defaults lastPushBeforeSha to null on first observation with no beforeSha", () => {
    const result = applyHeadTransition(
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.PushWebhook,
        observedAt: new Date("2026-08-12T00:00:00.000Z"),
      },
      null
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "first_observation",
      lastPushBeforeSha: null,
    });
  });

  it("confirms a same-SHA push with no beforeSha, defaulting lastPushBeforeSha to null", () => {
    const result = applyHeadTransition(
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.PushWebhook,
        observedAt: new Date("2026-08-12T01:00:00.000Z"),
      },
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: new Date("2026-08-12T00:00:00.000Z"),
        // Differs from the incoming (undefined -> null) beforeSha, so the
        // duplicate_push check fails and push_confirmed applies instead.
        lastPushBeforeSha: "prior-before-sha",
        deletedAt: null,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "push_confirmed",
      lastPushBeforeSha: null,
    });
  });

  it("treats an undefined beforeSha as equal to a stored null on duplicate-push detection", () => {
    const existing = {
      headSha: "head-1",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-08-12T00:00:00.000Z"),
      lastPushBeforeSha: null,
      deletedAt: null,
    };

    const result = applyHeadTransition(
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.PushWebhook,
        observedAt: new Date("2026-08-12T01:00:00.000Z"),
      },
      existing
    );

    expect(result).toMatchObject({ accepted: true, reason: "duplicate_push" });
  });

  it("keeps the earlier observed time when confirming a push with no newer observedAt", () => {
    const existingObservedAt = new Date("2026-08-12T00:00:00.000Z");
    const result = applyHeadTransition(
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.PushWebhook,
        observedAt: new Date("2026-08-11T00:00:00.000Z"),
      },
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: existingObservedAt,
        lastPushBeforeSha: null,
        deletedAt: null,
      }
    );

    // latestDate keeps the later of the two timestamps — here the STORED one,
    // since the incoming observedAt is earlier.
    expect(result.headShaObservedAt).toEqual(existingObservedAt);
  });

  it("uses the incoming observedAt directly when no prior observed time is stored", () => {
    const incomingObservedAt = new Date("2026-08-11T00:00:00.000Z");
    const result = applyHeadTransition(
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.PushWebhook,
        observedAt: incomingObservedAt,
      },
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: null,
        lastPushBeforeSha: "prior-before-sha",
        deletedAt: null,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "push_confirmed",
      headShaObservedAt: incomingObservedAt,
    });
  });

  it("rejects a GitHub-recreate replay observed before the branch's own delete", () => {
    const deletedAt = new Date("2026-08-12T00:00:00.000Z");
    const result = applyHeadTransition(
      {
        headSha: "head-2",
        beforeSha: "0".repeat(40),
        isCreate: true,
        observedAt: new Date("2026-08-11T00:00:00.000Z"),
      },
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-08-10T00:00:00.000Z"),
        lastPushBeforeSha: null,
        deletedAt,
      }
    );

    expect(result).toMatchObject({ accepted: false, reason: "stale_push" });
  });

  it("treats a GitHub-recreate with no observed time as not-after the delete, rejecting it as stale", () => {
    const result = applyHeadTransition(
      {
        headSha: "head-2",
        beforeSha: "0".repeat(40),
        isCreate: true,
        // No `observedAt` at all — `isAfter` must treat a missing candidate
        // instant as NOT after the delete rather than throwing or defaulting
        // to "now".
      },
      {
        headSha: "head-1",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-08-10T00:00:00.000Z"),
        lastPushBeforeSha: null,
        deletedAt: new Date("2026-08-12T00:00:00.000Z"),
      }
    );

    expect(result).toMatchObject({ accepted: false, reason: "stale_push" });
  });
});

describe("applyDeleteTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the current instant when no deletedAt is supplied", () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    vi.setSystemTime(now);

    const result = applyDeleteTransition({ isDelete: true });

    expect(result).toEqual({ deletedAt: now, status: GitHubPRState.Closed });
  });
});
