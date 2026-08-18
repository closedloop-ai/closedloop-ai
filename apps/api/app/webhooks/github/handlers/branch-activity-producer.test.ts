import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import {
  GitHubBranchActivityEventName,
  GitHubBranchActivityMappingStatus,
  GitHubBranchActivityNoWriteReason,
  type GitHubBranchActivityProducerInput,
  GitHubBranchActivityProductionStatus,
  mapGitHubBranchActivity,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";

const mocks = vi.hoisted(() => ({
  persistAtom: vi.fn(),
}));

vi.mock("@/app/branches/branch-activity-evidence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    persistBranchActivityAtom: mocks.persistAtom,
  };
});

const ORGANIZATION_ID = "019ff6d4-51f8-7ad0-8a95-40d1f06400dc";
const BRANCH_ID = "019ff6d4-9f0b-70df-b07d-aa44ce3a432e";
const PULL_REQUEST_ID = "019ff6d4-c23d-77d9-a3f2-943fef790c95";
const CREATED_AT = "2026-08-12T10:00:00.000Z";
const UPDATED_AT = "2026-08-12T11:00:00.000Z";
const CLOSED_AT = "2026-08-12T12:00:00.000Z";
const MERGED_AT = "2026-08-12T13:00:00.000Z";

describe("GitHub Branch activity mapping", () => {
  it.each([
    {
      name: "pull request opened",
      eventName: GitHubBranchActivityEventName.PullRequest,
      payload: {
        action: "opened",
        pull_request: { created_at: CREATED_AT },
      },
      source: BranchActivitySource.PullRequestLifecycle,
      occurredAt: CREATED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "pull request merged",
      eventName: GitHubBranchActivityEventName.PullRequest,
      payload: {
        action: "closed",
        pull_request: {
          merged: true,
          merged_at: MERGED_AT,
          closed_at: CLOSED_AT,
        },
      },
      source: BranchActivitySource.PullRequestLifecycle,
      occurredAt: MERGED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "pull request closed without merge",
      eventName: GitHubBranchActivityEventName.PullRequest,
      payload: {
        action: "closed",
        pull_request: {
          merged: false,
          merged_at: MERGED_AT,
          closed_at: CLOSED_AT,
        },
      },
      source: BranchActivitySource.PullRequestLifecycle,
      occurredAt: CLOSED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "review submitted",
      eventName: GitHubBranchActivityEventName.PullRequestReview,
      payload: {
        action: "submitted",
        review: { submitted_at: CREATED_AT },
      },
      source: BranchActivitySource.PullRequestReview,
      occurredAt: CREATED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "review comment created",
      eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
      payload: {
        action: "created",
        comment: { created_at: CREATED_AT, updated_at: UPDATED_AT },
      },
      source: BranchActivitySource.PullRequestReview,
      occurredAt: CREATED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "review comment edited",
      eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
      payload: {
        action: "edited",
        comment: { created_at: CREATED_AT, updated_at: UPDATED_AT },
      },
      source: BranchActivitySource.PullRequestReview,
      occurredAt: UPDATED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "PR issue comment created",
      eventName: GitHubBranchActivityEventName.IssueComment,
      payload: {
        action: "created",
        issue: { pull_request: { url: "https://api.github.test/pulls/1" } },
        comment: { created_at: CREATED_AT, updated_at: UPDATED_AT },
      },
      source: BranchActivitySource.PullRequestReview,
      occurredAt: CREATED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "PR issue comment edited",
      eventName: GitHubBranchActivityEventName.IssueComment,
      payload: {
        action: "edited",
        issue: { pull_request: { url: "https://api.github.test/pulls/1" } },
        comment: { created_at: CREATED_AT, updated_at: UPDATED_AT },
      },
      source: BranchActivitySource.PullRequestReview,
      occurredAt: UPDATED_AT,
      attributionKind: BranchActivityAttributionKind.PullRequest,
    },
    {
      name: "check run completed",
      eventName: GitHubBranchActivityEventName.CheckRun,
      payload: {
        action: "completed",
        check_run: { completed_at: CLOSED_AT },
      },
      source: BranchActivitySource.GitHubWebhook,
      occurredAt: CLOSED_AT,
      attributionKind: BranchActivityAttributionKind.Branch,
    },
    {
      name: "deployment status created",
      eventName: GitHubBranchActivityEventName.DeploymentStatus,
      payload: {
        action: "created",
        deployment_status: { created_at: UPDATED_AT },
      },
      source: BranchActivitySource.GitHubWebhook,
      occurredAt: UPDATED_AT,
      attributionKind: BranchActivityAttributionKind.Branch,
    },
  ])("maps $name from its action-specific provider timestamp", ({
    eventName,
    payload,
    source,
    occurredAt,
    attributionKind,
  }) => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName,
          payload,
          attribution:
            attributionKind === BranchActivityAttributionKind.PullRequest
              ? pullRequestAttribution()
              : branchAttribution(),
        })
      )
    ).toEqual({
      status: GitHubBranchActivityMappingStatus.Mapped,
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      atom: {
        version: BranchActivityAtomVersion.V1,
        source,
        sourceEventId: "delivery-1",
        occurredAt,
        attribution:
          attributionKind === BranchActivityAttributionKind.PullRequest
            ? {
                kind: BranchActivityAttributionKind.PullRequest,
                pullRequestId: PULL_REQUEST_ID,
              }
            : { kind: BranchActivityAttributionKind.Branch },
        completeness: BranchActivityEvidenceCompleteness.Partial,
      },
    });
  });

  it("trims the stable delivery identity once", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          deliveryId: "  delivery-1  ",
          eventName: GitHubBranchActivityEventName.CheckRun,
          payload: {
            action: "completed",
            check_run: { completed_at: CREATED_AT },
          },
          attribution: branchAttribution(),
        })
      )
    ).toMatchObject({
      status: GitHubBranchActivityMappingStatus.Mapped,
      atom: { sourceEventId: "delivery-1" },
    });
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
  ])("fails closed for missing delivery identity %#", (deliveryId) => {
    expect(mapGitHubBranchActivity(input({ deliveryId }))).toEqual(
      noWrite(GitHubBranchActivityNoWriteReason.MissingDeliveryIdentity)
    );
  });

  it.each([
    23,
    "x".repeat(513),
  ])("fails closed for invalid delivery identity %#", (deliveryId) => {
    expect(mapGitHubBranchActivity(input({ deliveryId }))).toEqual(
      noWrite(GitHubBranchActivityNoWriteReason.InvalidDeliveryIdentity)
    );
  });

  it.each([
    "edited",
    "reopened",
    "synchronize",
    "converted_to_draft",
    "ready_for_review",
  ])("does not infer PR activity for the %s action", (action) => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.PullRequest,
          payload: { action, pull_request: { updated_at: UPDATED_AT } },
        })
      )
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction));
  });

  it.each([
    {
      name: "dismissed review",
      eventName: GitHubBranchActivityEventName.PullRequestReview,
      payload: {
        action: "dismissed",
        review: { submitted_at: CREATED_AT },
      },
      reason: GitHubBranchActivityNoWriteReason.UnsupportedAction,
    },
    {
      name: "deleted review comment",
      eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
      payload: {
        action: "deleted",
        comment: { created_at: CREATED_AT, updated_at: UPDATED_AT },
      },
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      name: "deleted PR issue comment",
      eventName: GitHubBranchActivityEventName.IssueComment,
      payload: {
        action: "deleted",
        issue: { pull_request: { url: "https://api.github.test/pulls/1" } },
        comment: { created_at: CREATED_AT, updated_at: UPDATED_AT },
      },
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      name: "resolved review thread",
      eventName: GitHubBranchActivityEventName.PullRequestReviewThread,
      payload: {
        action: "resolved",
        thread: { updated_at: UPDATED_AT },
      },
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      name: "unresolved review thread",
      eventName: GitHubBranchActivityEventName.PullRequestReviewThread,
      payload: {
        action: "unresolved",
        thread: { updated_at: UPDATED_AT },
      },
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      name: "push",
      eventName: GitHubBranchActivityEventName.Push,
      payload: {
        repository: { pushed_at: UPDATED_AT },
        head_commit: { timestamp: CREATED_AT },
        commits: [{ timestamp: CREATED_AT }],
      },
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
  ])("returns a typed no-write for $name", ({ eventName, payload, reason }) => {
    expect(mapGitHubBranchActivity(input({ eventName, payload }))).toEqual(
      noWrite(reason)
    );
  });

  it("fails closed for an array at the raw JSON object boundary", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.CheckRun,
          payload: [],
          attribution: branchAttribution(),
        })
      )
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction));
  });

  it("fails closed when an event/action-specific timestamp is missing", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.CheckRun,
          payload: {
            action: "completed",
            check_run: { updated_at: UPDATED_AT },
          },
          attribution: branchAttribution(),
        })
      )
    ).toEqual(
      noWrite(GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp)
    );
  });

  it("fails closed when an authoritative timestamp is malformed", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
          payload: {
            action: "edited",
            comment: { updated_at: "yesterday" },
          },
        })
      )
    ).toEqual(
      noWrite(GitHubBranchActivityNoWriteReason.InvalidAuthoritativeTimestamp)
    );
  });

  it("fails closed for unsupported event and action literals", () => {
    expect(
      mapGitHubBranchActivity(input({ eventName: "workflow_run" }))
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.UnsupportedEvent));
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.CheckRun,
          payload: {
            action: "requested_action",
            check_run: { completed_at: CREATED_AT },
          },
          attribution: branchAttribution(),
        })
      )
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction));
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.DeploymentStatus,
          payload: {
            action: "inactive",
            deployment_status: { created_at: CREATED_AT },
          },
          attribution: branchAttribution(),
        })
      )
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction));
  });

  it("preserves an explicit provider timestamp without consulting local time", () => {
    const futureProviderTime = "2099-01-01T00:00:00.000Z";

    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.CheckRun,
          payload: {
            action: "completed",
            check_run: { completed_at: futureProviderTime },
          },
          attribution: branchAttribution(),
        })
      )
    ).toMatchObject({
      status: GitHubBranchActivityMappingStatus.Mapped,
      atom: { occurredAt: futureProviderTime },
    });
  });

  it("requires issue comments to belong to a pull request", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.IssueComment,
          payload: {
            action: "created",
            issue: {},
            comment: { created_at: CREATED_AT },
          },
        })
      )
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.MissingAttribution));
  });

  it("requires an internal associated PR UUID for PR-attributed events", () => {
    const producerInput = input({
      eventName: GitHubBranchActivityEventName.PullRequest,
      payload: {
        action: "opened",
        pull_request: { created_at: CREATED_AT },
      },
    });
    expect(
      mapGitHubBranchActivity({ ...producerInput, attribution: undefined })
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.MissingAttribution));
    expect(
      mapGitHubBranchActivity({
        ...producerInput,
        attribution: {
          ...branchAttribution(),
          pullRequestDetailId: 12_345,
        },
      })
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.InvalidAttribution));
  });

  it("rejects ambiguous PR attribution on a direct Branch event", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.CheckRun,
          payload: {
            action: "completed",
            check_run: { completed_at: CREATED_AT },
          },
          attribution: pullRequestAttribution(),
        })
      )
    ).toEqual(noWrite(GitHubBranchActivityNoWriteReason.InvalidAttribution));
  });
});

describe("GitHub Branch activity persistence", () => {
  afterEach(() => {
    mocks.persistAtom.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    BranchActivityPersistStatus.Inserted,
    BranchActivityPersistStatus.Replayed,
  ])("returns persisted for a writer %s outcome", async (persistenceStatus) => {
    mocks.persistAtom.mockResolvedValue({ status: persistenceStatus });
    await expect(persistGitHubBranchActivity(mappedInput())).resolves.toEqual({
      status: GitHubBranchActivityProductionStatus.Persisted,
      persistenceStatus,
    });
    expect(mocks.persistAtom).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      atom: expect.objectContaining({
        sourceEventId: "delivery-1",
        occurredAt: CREATED_AT,
      }),
    });
  });

  it.each([
    {
      persistenceStatus: BranchActivityPersistStatus.Conflict,
      reason: GitHubBranchActivityNoWriteReason.PersistenceConflict,
    },
    {
      persistenceStatus: BranchActivityPersistStatus.Invalid,
      reason: GitHubBranchActivityNoWriteReason.PersistenceInvalid,
    },
    {
      persistenceStatus: BranchActivityPersistStatus.NotFound,
      reason: GitHubBranchActivityNoWriteReason.PersistenceNotFound,
    },
    {
      persistenceStatus: BranchActivityPersistStatus.InvalidAttribution,
      reason: GitHubBranchActivityNoWriteReason.PersistenceInvalidAttribution,
    },
  ])("maps writer $persistenceStatus to $reason", async ({
    persistenceStatus,
    reason,
  }) => {
    mocks.persistAtom.mockResolvedValue({ status: persistenceStatus });

    await expect(persistGitHubBranchActivity(mappedInput())).resolves.toEqual(
      noWrite(reason)
    );
  });

  it("does not access persistence for a mapper no-write", async () => {
    await expect(
      persistGitHubBranchActivity(input({ deliveryId: null }))
    ).resolves.toEqual(
      noWrite(GitHubBranchActivityNoWriteReason.MissingDeliveryIdentity)
    );
    expect(mocks.persistAtom).not.toHaveBeenCalled();
  });

  it("propagates unexpected database failures", async () => {
    const failure = new Error("database unavailable");
    mocks.persistAtom.mockRejectedValue(failure);

    await expect(persistGitHubBranchActivity(mappedInput())).rejects.toBe(
      failure
    );
  });
});

function input(
  overrides: Partial<GitHubBranchActivityProducerInput> = {}
): GitHubBranchActivityProducerInput {
  return {
    eventName: GitHubBranchActivityEventName.PullRequest,
    deliveryId: "delivery-1",
    payload: {
      action: "opened",
      pull_request: { created_at: CREATED_AT },
    },
    attribution: pullRequestAttribution(),
    ...overrides,
  };
}

function mappedInput(): GitHubBranchActivityProducerInput {
  return input({
    eventName: GitHubBranchActivityEventName.CheckRun,
    payload: {
      action: "completed",
      check_run: { completed_at: CREATED_AT },
    },
    attribution: branchAttribution(),
  });
}

function branchAttribution(): Record<string, string> {
  return {
    organizationId: ORGANIZATION_ID,
    branchArtifactId: BRANCH_ID,
  };
}

function pullRequestAttribution(): Record<string, string> {
  return {
    ...branchAttribution(),
    pullRequestDetailId: PULL_REQUEST_ID,
  };
}

function noWrite(reason: GitHubBranchActivityNoWriteReason): {
  status: typeof GitHubBranchActivityMappingStatus.NoWrite;
  reason: GitHubBranchActivityNoWriteReason;
} {
  return { status: GitHubBranchActivityMappingStatus.NoWrite, reason };
}
