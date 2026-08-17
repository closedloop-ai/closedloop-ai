import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS,
  SessionArtifactLinkKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSyncedSession,
  installBranchIngestDb,
  syncBranchRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../../service";
import { mergeBranchLifecycleEvents } from "./shared";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts a SESSION→BRANCH link carrying method/relation/observedAt (FEA-2729)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:03:00.000Z",
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.BranchWrite,
            observedAt: "2026-05-20T17:03:00.000Z",
            evidenceId: "desktop-artifact-link:l-1",
          },
        ],
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const arg = m.artifactLinkUpsert.mock.calls[0][0];
    // Idempotent: keyed on the (sourceId,targetId,linkType) unique constraint.
    expect(arg.where.sourceId_targetId_linkType).toEqual({
      sourceId: "persisted-session-1",
      targetId: "branch-x",
      linkType: LinkType.RelatesTo,
    });
    expect(arg.create.metadata).toMatchObject({
      linkKind: SessionArtifactLinkKind.SessionBranch,
      linkKinds: [SessionArtifactLinkKind.SessionBranch],
      branchParticipation: BranchParticipationKind.Wrote,
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-05-20T17:03:00.000Z",
      branchName: "feat/x",
      branchRepositoryFullName: "acme/web",
      branchLinked: true,
      branchSource: "desktop_sync",
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          observedAt: "2026-05-20T17:03:00.000Z",
          evidenceId: "desktop-artifact-link:l-1",
        },
      ],
    });
    expect(arg.create.branchParticipation).toBe(BranchParticipationKind.Wrote);
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.GitCommand
    );
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:03:00.000Z")
    );
    // Same metadata on the update branch → re-sync converges in place.
    expect(arg.update.metadata).toEqual(arg.create.metadata);
    expect(arg.update.branchParticipation).toBe(arg.create.branchParticipation);
  });

  it("persists explicit branch participation from synced branch refs", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_commit",
        relation: ArtifactRefRelation.Workspace,
        branchParticipation: BranchParticipationKind.Wrote,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.branchParticipation).toBe(
      BranchParticipationKind.Wrote
    );
    expect(arg.create.branchParticipation).toBe(BranchParticipationKind.Wrote);
    expect(arg.create.branchParticipationMethod).toBe("git_commit");
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:03:00.000Z")
    );
  });

  it("keeps the newest branch lifecycle events when applying the sync cap", () => {
    const events = Array.from(
      { length: MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS + 2 },
      (_, index) => ({
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        observedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
        evidenceId: `desktop-artifact-link:${index}`,
      })
    );

    const merged = mergeBranchLifecycleEvents(events);

    expect(merged).toHaveLength(MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS);
    expect(merged[0]?.evidenceId).toBe("desktop-artifact-link:2");
    expect(merged.at(-1)?.evidenceId).toBe(
      `desktop-artifact-link:${MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS + 1}`
    );
  });

  it("replaces an earlier lifecycle event with the same evidenceId (FEA-3851 method correction)", () => {
    // A reviewed-PR boundary first synced as ReviewFeedback, then the desktop
    // extractor corrects the method and re-syncs the SAME boundary (same
    // evidenceId) as a read-only reference. The corrected (later) event must
    // REPLACE the stale one, not sit beside it.
    const stale = {
      kind: BranchLifecycleBoundaryKind.ReviewFeedback,
      observedAt: "2026-07-01T00:00:00.000Z",
      evidenceId: "desktop-artifact-link:l-42",
    };
    const corrected = {
      kind: BranchLifecycleBoundaryKind.ReadOnlyReference,
      observedAt: "2026-07-01T00:00:00.000Z",
      evidenceId: "desktop-artifact-link:l-42",
    };

    const merged = mergeBranchLifecycleEvents([stale], [corrected]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe(BranchLifecycleBoundaryKind.ReadOnlyReference);
    expect(
      merged.some(
        (event) => event.kind === BranchLifecycleBoundaryKind.ReviewFeedback
      )
    ).toBe(false);
  });

  it("keeps distinct evidence-less lifecycle events even when kinds differ", () => {
    // Evidence-less events have no durable id, so they must fall back to the
    // composite-key dedupe and not collapse into one another.
    const readOnly = {
      kind: BranchLifecycleBoundaryKind.ReadOnlyReference,
      observedAt: "2026-07-01T00:00:00.000Z",
    };
    const feedback = {
      kind: BranchLifecycleBoundaryKind.ReviewFeedback,
      observedAt: "2026-07-01T00:00:00.000Z",
    };

    const merged = mergeBranchLifecycleEvents([readOnly], [feedback]);

    expect(merged).toHaveLength(2);
  });

  it("orders capped lifecycle events deterministically with ties and missing timestamps", () => {
    const events = [
      ...Array.from(
        { length: MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS },
        (_, index) => ({
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          observedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
          evidenceId: `desktop-artifact-link:${index}`,
        })
      ),
      {
        kind: BranchLifecycleBoundaryKind.ReviewFeedback,
        observedAt: new Date(
          Date.UTC(2026, 6, 1, 0, MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS - 1)
        ).toISOString(),
        evidenceId: "desktop-artifact-link:tie",
      },
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        evidenceId: "desktop-artifact-link:no-time-b",
      },
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        evidenceId: "desktop-artifact-link:no-time-a",
      },
    ];

    const merged = mergeBranchLifecycleEvents(events);

    expect(merged).toHaveLength(MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS);
    expect(
      merged.some((event) => event.evidenceId === "desktop-artifact-link:0")
    ).toBe(false);
    expect(
      merged.some((event) => event.evidenceId === "desktop-artifact-link:1")
    ).toBe(false);
    expect(
      merged.some((event) => event.evidenceId === "desktop-artifact-link:2")
    ).toBe(false);
    expect(merged.at(-2)?.evidenceId).toBe("desktop-artifact-link:no-time-a");
    expect(merged.at(-1)?.evidenceId).toBe("desktop-artifact-link:no-time-b");
  });
  it("dedupes replayed branch lifecycle metadata while preserving existing events", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.PrRaised,
              observedAt: "2026-05-20T17:00:00.000Z",
              evidenceId: "desktop-artifact-link:pr-1",
            },
          ],
        },
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:03:00.000Z",
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.BranchWrite,
            observedAt: "2026-05-20T17:03:00.000Z",
            evidenceId: "desktop-artifact-link:l-1",
          },
          {
            kind: BranchLifecycleBoundaryKind.PrRaised,
            observedAt: "2026-05-20T17:00:00.000Z",
            evidenceId: "desktop-artifact-link:pr-1",
          },
        ],
      },
    ]);

    const metadata = m.artifactLinkUpsert.mock.calls[0][0].create.metadata;
    expect(metadata.branchLifecycleEvents).toEqual([
      {
        kind: BranchLifecycleBoundaryKind.PrRaised,
        observedAt: "2026-05-20T17:00:00.000Z",
        evidenceId: "desktop-artifact-link:pr-1",
      },
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        observedAt: "2026-05-20T17:03:00.000Z",
        evidenceId: "desktop-artifact-link:l-1",
      },
    ]);
  });
  it("materializes a feature branch but excludes the repository default without aborting the sync", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
        {
          artifactId: "branch-main",
          repositoryId: "repo-1",
          branchName: "main",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "main",
        method: "git_command",
        relation: ArtifactRefRelation.Workspace,
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const relationByTarget = new Map(
      m.artifactLinkUpsert.mock.calls.map((call) => [
        call[0].where.sourceId_targetId_linkType.targetId,
        call[0].create.metadata.relation,
      ])
    );
    expect(relationByTarget.get("branch-x")).toBe(ArtifactRefRelation.Created);
    expect(relationByTarget.has("branch-main")).toBe(false);
  });
  it("picks the strongest relation when one branch is touched several ways", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    expect(m.artifactLinkUpsert.mock.calls[0][0].create.metadata).toMatchObject(
      {
        relation: ArtifactRefRelation.Created,
        method: "git_command",
      }
    );
  });
  it("stamps firstPushedAt + pushSource=session for a C1-verified in-session push (git_push) (PLN-1099 Phase 2b)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    // A synced push-method ref is C1-verified upstream (the desktop extractor
    // drops failed pushes), so the session lane stamps push state. The
    // set-once / earliest-wins DB behavior itself is covered by the
    // branch-artifact-flows integration suite against a real database.
    expect(m.branchDetailUpdateMany).toHaveBeenCalledTimes(1);
    const call = m.branchDetailUpdateMany.mock.calls[0][0];
    expect(call.where.artifactId).toBe("branch-x");
    expect(call.data).toEqual({
      firstPushedAt: new Date("2026-05-20T17:03:00.000Z"),
      pushSource: BranchPushSource.Session,
    });
  });
  it("does NOT stamp push state for an observation-only ref (no push method) (PLN-1099 Phase 2b)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    // A checkout/workspace touch is "observed", not "pushed" (PRD-510 D3): the
    // row exists but stays firstPushedAt-null, so no org list surfaces it (FR12).
    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });
  it("persists reviewed participation for branch review-feedback evidence without push attribution", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:03:00.000Z",
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.ReviewFeedback,
            observedAt: "2026-05-20T17:03:00.000Z",
            evidenceId: "desktop-artifact-link:review",
          },
        ],
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.PrReviewFeedbackCommand
    );
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:03:00.000Z")
    );
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });
  it("omits the evidence method when reviewed participation only comes from lifecycle events", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:01:00.000Z",
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_status",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:03:00.000Z",
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.ReviewFeedback,
            observedAt: "2026-05-20T17:02:00.000Z",
            evidenceId: "desktop-artifact-link:review",
          },
        ],
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.method).toBe("git_checkout");
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBeNull();
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:02:00.000Z")
    );
  });
  it("keeps direct review-feedback method evidence across same-rank branch refs", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:01:00.000Z",
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:02:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.method).toBe("git_checkout");
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.PrReviewFeedbackCommand
    );
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:02:00.000Z")
    );
  });
  it("keeps review-feedback command method ahead of relation-only reviewed refs", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:02:00.000Z",
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "review_relation",
        relation: ArtifactRefRelation.Reviewed,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.PrReviewFeedbackCommand
    );
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:02:00.000Z")
    );
  });
  it("clears stale reviewed evidence time when undated wrote evidence wins later", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:02:00.000Z",
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Created,
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.branchParticipation).toBe(BranchParticipationKind.Wrote);
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.GitCommand
    );
    expect(arg.create.branchParticipationObservedAt).toBeNull();
  });
  it("does not reuse persisted reviewed observedAt when undated wrote evidence wins later", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchParticipation: BranchParticipationKind.Reviewed,
          method: ArtifactRefMethod.PrReviewFeedbackCommand,
          observedAt: "2026-05-20T17:02:00.000Z",
        },
        branchParticipation: BranchParticipationKind.Reviewed,
        branchParticipationMethod: ArtifactRefMethod.PrReviewFeedbackCommand,
        branchParticipationObservedAt: new Date("2026-05-20T17:02:00.000Z"),
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Created,
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.branchParticipation).toBe(BranchParticipationKind.Wrote);
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.GitCommand
    );
    expect(arg.create.branchParticipationObservedAt).toBeNull();
  });
  it("does not reuse stale passive metadata method for lifecycle-only reviewed participation", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          method: "git_checkout",
          observedAt: "2026-05-20T17:01:00.000Z",
        },
        branchParticipation: null,
        branchParticipationMethod: null,
        branchParticipationObservedAt: null,
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_status",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:03:00.000Z",
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.ReviewFeedback,
            observedAt: "2026-05-20T17:02:00.000Z",
            evidenceId: "desktop-artifact-link:review",
          },
        ],
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBeNull();
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:02:00.000Z")
    );
  });
  it("does not backfill stale passive metadata method after lifecycle-only reviewed re-sync", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchParticipation: BranchParticipationKind.Reviewed,
          method: "git_checkout",
          observedAt: "2026-05-20T17:01:00.000Z",
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.ReviewFeedback,
              observedAt: "2026-05-20T17:02:00.000Z",
              evidenceId: "desktop-artifact-link:review",
            },
          ],
        },
        branchParticipation: BranchParticipationKind.Reviewed,
        branchParticipationMethod: null,
        branchParticipationObservedAt: new Date("2026-05-20T17:02:00.000Z"),
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_status",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBeNull();
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:02:00.000Z")
    );
  });
  it("uses legacy lifecycle review event time instead of passive metadata observedAt", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          method: "git_checkout",
          observedAt: "2026-05-20T17:01:00.000Z",
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.ReviewFeedback,
              observedAt: "2026-05-20T17:02:00.000Z",
              evidenceId: "desktop-artifact-link:review",
            },
          ],
        },
        branchParticipation: null,
        branchParticipationMethod: null,
        branchParticipationObservedAt: null,
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_status",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBeNull();
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:02:00.000Z")
    );
  });
  it("preserves existing reviewed participation when a later sync only has passive branch evidence", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchParticipation: BranchParticipationKind.Reviewed,
          method: ArtifactRefMethod.PrReviewFeedbackCommand,
          observedAt: "2026-05-20T17:03:00.000Z",
        },
        branchParticipation: null,
        branchParticipationMethod: null,
        branchParticipationObservedAt: null,
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:10:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.PrReviewFeedbackCommand
    );
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:03:00.000Z")
    );
  });
  it("does not attribute legacy review-feedback metadata to a later passive sync", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          method: ArtifactRefMethod.PrReviewFeedbackCommand,
          observedAt: "2026-05-20T17:03:00.000Z",
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.ReviewFeedback,
              observedAt: "2026-05-20T17:03:00.000Z",
              evidenceId: "desktop-artifact-link:review",
            },
          ],
        },
        branchParticipation: null,
        branchParticipationMethod: null,
        branchParticipationObservedAt: null,
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:10:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(arg.create.branchParticipationMethod).toBe(
      ArtifactRefMethod.PrReviewFeedbackCommand
    );
    expect(arg.create.branchParticipationObservedAt).toEqual(
      new Date("2026-05-20T17:03:00.000Z")
    );
  });
  it("stamps the EARLIEST observed push across multiple push refs (earliest-wins) (PLN-1099 Phase 2b)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    // Two pushes on one branch in a session, later delivered before earlier.
    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T18:00:00.000Z",
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Output,
        observedAt: "2026-05-20T17:00:00.000Z",
      },
    ]);

    expect(m.branchDetailUpdateMany).toHaveBeenCalledTimes(1);
    expect(
      m.branchDetailUpdateMany.mock.calls[0][0].data.firstPushedAt
    ).toEqual(new Date("2026-05-20T17:00:00.000Z"));
  });
  it("enriches a created App-repo branch with repositoryId despite a .git/mixed-case ref (PLN-1099 D2 normalization)", async () => {
    const SOURCE_ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
    const m = installBranchIngestDb({
      // App repo: the installation repo's stored full_name uses GitHub's
      // canonical casing and carries no `.git` suffix.
      installation: { id: "install-1" },
      repos: [{ id: "repo-1", fullName: "acme/web" }],
      branches: [],
      artifactProjects: [{ id: SOURCE_ARTIFACT_ID, projectId: "project-1" }],
    });

    await syncBranchRefs(
      [
        {
          kind: ArtifactRefTargetKind.Branch,
          // Desktop ref from an SSH remote: `.git` suffix + different casing.
          repositoryFullName: "Acme/Web.git",
          branchName: "feat/x",
          method: "git_command",
          relation: ArtifactRefRelation.Created,
        },
      ],
      { sourceArtifactId: SOURCE_ARTIFACT_ID }
    );

    // Enrichment resolves through the normalized name, so the branch is created
    // as an App branch (repositoryId set) rather than misclassified non-App.
    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    expect(m.artifactCreate.mock.calls[0][0].data.branch.create).toMatchObject({
      repositoryId: "repo-1",
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
  });
  it("creates and links an unparented branch when the session resolves no project (FEA-1749)", async () => {
    /* Was: "defers a branch ref whose branch artifact has not synced yet
       (late-target tolerance)". The late target was never the BRANCH — this lane
       mints those. It was the PROJECT, which the desktop lane never has, so the
       ref deferred on every sync forever and FR8's non-App producer never fired.
       Branch identity (PRD-510 D2) is (org, repo, branchName) — no project. */
    const m = installBranchIngestDb({ branches: [] });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    const created = m.artifactCreate.mock.calls[0][0].data;
    expect(created.type).toBe("BRANCH");
    // Unparented: no `project` connect at all (not a null one).
    expect(created.project).toBeUndefined();
    expect(created.branch.create).toMatchObject({
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
    // The link is now made rather than deferred...
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    // ...and nothing is written to the deferral list.
    const deferralUpdate = m.sessionDetailUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data?: { metadata?: Record<string, unknown> } }).data
          ?.metadata?._unresolvedBranchRefs !== undefined
    );
    expect(deferralUpdate).toBeUndefined();
  });
  it("resolves branches only within the caller's org (isolation, PRD-510 FR11)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    // Current authority is locked by organization across every active
    // installation; it is never selected through an arbitrary first install.
    const authorityQuery = m.authorityQueryRaw.mock.calls.find((call) =>
      call[0]?.sql?.includes("github_installation_repositories")
    )?.[0];
    expect(authorityQuery?.sql).toContain("installation.organization_id");
    expect(authorityQuery?.sql).toContain("installation.status");
    expect(authorityQuery?.sql).toContain("FOR SHARE OF repository");
    // Branch resolved/created on the org-scoped D2 key (organizationId,
    // normalized repositoryFullName, branchName) — a same-named branch in
    // another org is a different organizationId and never matches.
    const branchWhere = m.branchFindFirst.mock.calls[0][0].where;
    expect(branchWhere).toEqual({
      organizationId: "org-1",
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
  });
  it("ignores pull_request-kind refs in the branch lane (FEA-2732 owns PR persistence)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "acme/web",
        prNumber: 7,
        method: "pr_create_output",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    // No branch-kind refs → the branch lane resolves/creates nothing and writes
    // no link.
    expect(m.branchFindFirst).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
  });
  it("resolves org + repos once per batch, not per session (N+1 hoist, FEA-2729)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });
    const branchRef = {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "acme/web",
      branchName: "feat/x",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
    } satisfies SyncedArtifactRef;

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "branch-batch",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 2,
        sessions: [
          buildSyncedSession({
            externalSessionId: "s1",
            artifactRefs: [branchRef],
          }),
          buildSyncedSession({
            externalSessionId: "s2",
            artifactRefs: [branchRef],
          }),
        ],
      }
    );

    // Authority is intentionally revalidated inside each per-session write
    // transaction. Each session issues one installed, one public, and one
    // persisted PR-head locked query for this chunk; no per-ref query is added.
    expect(m.authorityQueryRaw).toHaveBeenCalledTimes(6);
    // Branch resolution stays per-session (one findFirst per branch ref).
    expect(m.branchFindFirst).toHaveBeenCalledTimes(2);
  });
});
