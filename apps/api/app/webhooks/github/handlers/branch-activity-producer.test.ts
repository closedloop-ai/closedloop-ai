import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { buildPullRequestLifecycleActivityRecords } from "@/app/branches/pull-request-lifecycle-activity";
import {
  GitHubBranchActivityAction,
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
const BEFORE_SHA = "1111111111111111111111111111111111111111";
const AFTER_SHA = "2222222222222222222222222222222222222222";
const MERGE_BASE_SHA = "3333333333333333333333333333333333333333";

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
      sourceEventId: `${PULL_REQUEST_ID}:opened`,
      completeness: BranchActivityEvidenceCompleteness.Complete,
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
      sourceEventId: `${PULL_REQUEST_ID}:merged`,
      completeness: BranchActivityEvidenceCompleteness.Complete,
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
      sourceEventId: `${PULL_REQUEST_ID}:closed:${CLOSED_AT}`,
      completeness: BranchActivityEvidenceCompleteness.Complete,
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
  ])(
    "maps $name from its action-specific provider timestamp",
    ({
      eventName,
      payload,
      source,
      occurredAt,
      attributionKind,
      sourceEventId,
      completeness,
    }: MappingCase) => {
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
          sourceEventId: sourceEventId ?? "delivery-1",
          occurredAt,
          attribution:
            attributionKind === BranchActivityAttributionKind.PullRequest
              ? {
                  kind: BranchActivityAttributionKind.PullRequest,
                  pullRequestId: PULL_REQUEST_ID,
                }
              : { kind: BranchActivityAttributionKind.Branch },
          completeness:
            completeness ?? BranchActivityEvidenceCompleteness.Partial,
        },
      });
    }
  );

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

  it.each([null, undefined, "", "   "])(
    "fails closed for missing delivery identity %#",
    (deliveryId) => {
      expect(mapGitHubBranchActivity(input({ deliveryId }))).toEqual(
        noWrite(GitHubBranchActivityNoWriteReason.MissingDeliveryIdentity)
      );
    }
  );

  it.each([23, "x".repeat(513)])(
    "fails closed for invalid delivery identity %#",
    (deliveryId) => {
      expect(mapGitHubBranchActivity(input({ deliveryId }))).toEqual(
        noWrite(GitHubBranchActivityNoWriteReason.InvalidDeliveryIdentity)
      );
    }
  );

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
      name: "pull request closed without a merge flag",
      eventName: GitHubBranchActivityEventName.PullRequest,
      payload: {
        action: GitHubBranchActivityAction.Closed,
        pull_request: { closed_at: CLOSED_AT, merged_at: MERGED_AT },
      },
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      name: "pull request closed with a non-boolean merge flag",
      eventName: GitHubBranchActivityEventName.PullRequest,
      payload: {
        action: GitHubBranchActivityAction.Closed,
        pull_request: {
          merged: "true",
          closed_at: CLOSED_AT,
          merged_at: MERGED_AT,
        },
      },
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
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
      name: "edited review thread",
      eventName: GitHubBranchActivityEventName.PullRequestReviewThread,
      payload: {
        action: GitHubBranchActivityAction.Edited,
        thread: { updated_at: UPDATED_AT },
      },
      reason: GitHubBranchActivityNoWriteReason.UnsupportedAction,
    },
  ])("returns a typed no-write for $name", ({ eventName, payload, reason }) => {
    expect(mapGitHubBranchActivity(input({ eventName, payload }))).toEqual(
      noWrite(reason)
    );
  });

  // ISS-10009 replaces the previous expectation that every push is a no-write
  // for a missing authoritative timestamp. Operator ruling 1 names the newest
  // `commits[].timestamp` as a push's occurrence time, so a push carrying one
  // now writes an atom; a push carrying none still writes nothing.
  it("maps a push to a non-canonical push_loc atom at its newest commit time", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          attribution: branchAttribution(),
          eventName: GitHubBranchActivityEventName.Push,
          // Push order, NOT timestamp order, and the newest carries a local
          // offset: a positional read returns the 10:00Z entry and an offset
          // read that ignores the zone returns 13:00.
          payload: pushPayload({
            commits: [
              { timestamp: CREATED_AT },
              { timestamp: "2026-08-12T13:00:00+02:00" },
            ],
          }),
          pushLineDelta: { linesAdded: 12, linesRemoved: 3 },
        })
      )
    ).toEqual({
      status: GitHubBranchActivityMappingStatus.Mapped,
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      atom: {
        version: BranchActivityAtomVersion.V1,
        source: BranchActivitySource.PushLoc,
        sourceEventId: "delivery-1",
        occurredAt: "2026-08-12T11:00:00.000Z",
        attribution: { kind: BranchActivityAttributionKind.Branch },
        completeness: BranchActivityEvidenceCompleteness.Partial,
      },
      pushEvidence: {
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        lineDelta: { linesAdded: 12, linesRemoved: 3 },
      },
    });
  });

  // GitHub truncates `commits[]` at 20 and sends the push's last commit
  // separately as `head_commit` (measured in webhook-body-caps.test.ts: a
  // 400-commit push arrives with 20 entries). Reading the array alone computes a
  // confident occurrence time from a capped set.
  it("folds head_commit into the newest time, so a capped commits[] cannot understate it", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          attribution: branchAttribution(),
          eventName: GitHubBranchActivityEventName.Push,
          payload: pushPayload({
            commits: [{ timestamp: CREATED_AT }],
            head_commit: { timestamp: "2026-08-12T13:00:00+02:00" },
          }),
          pushLineDelta: { linesAdded: 1, linesRemoved: 0 },
        })
      )
    ).toMatchObject({
      status: GitHubBranchActivityMappingStatus.Mapped,
      atom: { occurredAt: "2026-08-12T11:00:00.000Z" },
    });
  });

  // The payload's `before` is the branch's previous TIP, not the base the
  // caller's compare measured against: on a branch create it is the all-zero
  // sha and on a force-push it is a commit the diff never saw. Storing it beside
  // totals computed over another range is what part 2 would then attribute by.
  it("persists the caller's compared base over the payload's before sha", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          attribution: branchAttribution(),
          eventName: GitHubBranchActivityEventName.Push,
          payload: pushPayload({
            before: "0".repeat(40),
            commits: [{ timestamp: CREATED_AT }],
          }),
          pushBaseSha: MERGE_BASE_SHA,
          pushLineDelta: { linesAdded: 7, linesRemoved: 1 },
        })
      )
    ).toMatchObject({
      status: GitHubBranchActivityMappingStatus.Mapped,
      pushEvidence: {
        beforeSha: MERGE_BASE_SHA,
        afterSha: AFTER_SHA,
        lineDelta: { linesAdded: 7, linesRemoved: 1 },
      },
    });
  });

  it("falls back to the payload's before sha when no compare was read", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          attribution: branchAttribution(),
          eventName: GitHubBranchActivityEventName.Push,
          payload: pushPayload({ commits: [{ timestamp: CREATED_AT }] }),
          pushBaseSha: undefined,
          pushLineDelta: null,
        })
      )
    ).toMatchObject({
      status: GitHubBranchActivityMappingStatus.Mapped,
      pushEvidence: { beforeSha: BEFORE_SHA, lineDelta: null },
    });
  });

  it.each([
    {
      name: "a zero-commit push",
      payload: pushPayload({ commits: [], head_commit: null }),
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      // A branch delete and a force-push to an existing sha both send zero
      // commits WITH a populated `head_commit` — the branch's prior tip. Reading
      // the timestamp fold first would time a row by a commit this push never
      // carried, against the stated zero-commit no-write rule.
      name: "a zero-commit push whose head_commit is still populated",
      payload: pushPayload({
        commits: [],
        head_commit: { timestamp: UPDATED_AT },
      }),
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      name: "a push whose commits are not an array at all",
      payload: pushPayload({ commits: undefined }),
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    },
    {
      name: "a push whose commit times are all unparseable",
      payload: pushPayload({
        commits: [{ timestamp: "yesterday" }],
        head_commit: { timestamp: "yesterday" },
      }),
      reason: GitHubBranchActivityNoWriteReason.InvalidAuthoritativeTimestamp,
    },
    {
      name: "a push with no usable sha range",
      payload: pushPayload({
        after: "not-a-sha",
        commits: [{ timestamp: CREATED_AT }],
      }),
      reason: GitHubBranchActivityNoWriteReason.MissingPushRange,
    },
  ])("writes no row for $name", ({ payload, reason }) => {
    expect(
      mapGitHubBranchActivity(
        input({
          attribution: branchAttribution(),
          eventName: GitHubBranchActivityEventName.Push,
          payload,
          pushLineDelta: { linesAdded: 12, linesRemoved: 3 },
        })
      )
    ).toEqual(noWrite(reason));
  });

  it.each([
    { name: "absent", lineDelta: undefined },
    { name: "negative", lineDelta: { linesAdded: -1, linesRemoved: 0 } },
    { name: "fractional", lineDelta: { linesAdded: 1.5, linesRemoved: 0 } },
    { name: "half populated", lineDelta: { linesAdded: 4 } },
  ])(
    "records a $name line delta as unknown rather than coercing it",
    ({ lineDelta }) => {
      expect(
        mapGitHubBranchActivity(
          input({
            attribution: branchAttribution(),
            eventName: GitHubBranchActivityEventName.Push,
            payload: pushPayload({ commits: [{ timestamp: CREATED_AT }] }),
            pushLineDelta: lineDelta,
          })
        )
      ).toMatchObject({
        status: GitHubBranchActivityMappingStatus.Mapped,
        pushEvidence: {
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          lineDelta: null,
        },
      });
    }
  );

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

  it.each(
    Object.entries(PERSISTENCE_NO_WRITE_REASONS).map(
      ([persistenceStatus, reason]) => ({ persistenceStatus, reason })
    )
  )(
    "maps writer $persistenceStatus to $reason",
    async ({ persistenceStatus, reason }) => {
      mocks.persistAtom.mockResolvedValue({ status: persistenceStatus });

      await expect(persistGitHubBranchActivity(mappedInput())).resolves.toEqual(
        noWrite(reason)
      );
    }
  );

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

describe("ISS-7018 PR lifecycle identity is shared across producer lanes", () => {
  it.each([
    {
      name: "opened",
      payload: { action: "opened", pull_request: { created_at: CREATED_AT } },
      lifecycle: { openedAt: new Date(CREATED_AT) },
    },
    {
      name: "merged",
      payload: {
        action: "closed",
        pull_request: {
          merged: true,
          merged_at: MERGED_AT,
          closed_at: CLOSED_AT,
        },
      },
      lifecycle: { mergedAt: new Date(MERGED_AT) },
    },
    {
      name: "closed without a merge",
      payload: {
        action: "closed",
        pull_request: {
          merged: false,
          merged_at: null,
          closed_at: CLOSED_AT,
        },
      },
      lifecycle: { closedAt: new Date(CLOSED_AT) },
    },
  ])(
    "emits for $name exactly the atom the non-webhook lanes emit",
    ({ payload, lifecycle }) => {
      const [nonWebhook] = buildPullRequestLifecycleActivityRecords({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
        pullRequestDetailId: PULL_REQUEST_ID,
        openedAt: null,
        mergedAt: null,
        closedAt: null,
        ...lifecycle,
      });

      expect(
        mapGitHubBranchActivity(
          input({
            eventName: GitHubBranchActivityEventName.PullRequest,
            payload,
          })
        )
      ).toMatchObject({
        status: GitHubBranchActivityMappingStatus.Mapped,
        atom: nonWebhook.atom,
      });
    }
  );

  it("normalizes a second-precision provider close time onto the shared key", () => {
    const closedAt = "2026-08-12T12:00:00Z";

    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.PullRequest,
          payload: {
            action: "closed",
            pull_request: { merged: false, closed_at: closedAt },
          },
        })
      )
    ).toMatchObject({
      atom: {
        sourceEventId: `${PULL_REQUEST_ID}:closed:${new Date(
          closedAt
        ).toISOString()}`,
      },
    });
  });

  it("keeps the delivery identity for lanes with no occurrence key", () => {
    expect(
      mapGitHubBranchActivity(
        input({
          eventName: GitHubBranchActivityEventName.PullRequestReview,
          payload: {
            action: "submitted",
            review: { submitted_at: CREATED_AT },
          },
        })
      )
    ).toMatchObject({
      atom: {
        sourceEventId: "delivery-1",
        completeness: BranchActivityEvidenceCompleteness.Partial,
      },
    });
  });
});

/**
 * `sourceEventId` and `completeness` are stated only where the lane departs
 * from the delivery-keyed partial default, so the PR lifecycle rows read as
 * the deliberate exception they are.
 */
type MappingCase = {
  name: string;
  eventName: GitHubBranchActivityEventName;
  payload: unknown;
  source: BranchActivitySource;
  occurredAt: string;
  attributionKind: BranchActivityAttributionKind;
  sourceEventId?: string;
  completeness?: BranchActivityEvidenceCompleteness;
};

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

function pushPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    before: BEFORE_SHA,
    after: AFTER_SHA,
    repository: { pushed_at: UPDATED_AT },
    head_commit: { timestamp: CREATED_AT },
    commits: [{ timestamp: CREATED_AT }],
    ...overrides,
  };
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

/**
 * Derived rather than hand-listed so a new non-terminal writer outcome fails
 * `tsc` here instead of silently losing its producer coverage.
 */
const PERSISTENCE_NO_WRITE_REASONS = {
  [BranchActivityPersistStatus.Conflict]:
    GitHubBranchActivityNoWriteReason.PersistenceConflict,
  [BranchActivityPersistStatus.Invalid]:
    GitHubBranchActivityNoWriteReason.PersistenceInvalid,
  [BranchActivityPersistStatus.NotFound]:
    GitHubBranchActivityNoWriteReason.PersistenceNotFound,
  [BranchActivityPersistStatus.InvalidAttribution]:
    GitHubBranchActivityNoWriteReason.PersistenceInvalidAttribution,
  [BranchActivityPersistStatus.FutureTimestamp]:
    GitHubBranchActivityNoWriteReason.PersistenceFutureTimestamp,
} as const satisfies Record<
  Exclude<
    BranchActivityPersistStatus,
    | typeof BranchActivityPersistStatus.Inserted
    | typeof BranchActivityPersistStatus.Replayed
  >,
  GitHubBranchActivityNoWriteReason
>;
