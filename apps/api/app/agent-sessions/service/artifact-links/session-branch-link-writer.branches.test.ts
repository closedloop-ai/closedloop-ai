import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionArtifactLinkKind,
  SessionPrRelationType,
  type SyncedBranchLifecycleEvent,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import type { BranchRefAggregate } from "./branch-ref-aggregate";
import {
  buildSessionBranchLinkWriteData,
  SessionBranchLinkEvidenceSource,
} from "./session-branch-link-writer";

describe("session Branch link writer metadata (branch coverage)", () => {
  it("skips PR-identity projection when PR-head evidence source carries no PR identity", () => {
    // pins current behavior; looks odd because a PullRequestHead evidence
    // source requires `pullRequestObserved === true` to accept the ref's own
    // prRefs, so a ref carrying real prRefs but no pullRequestObserved bit
    // never has them merged into metadata.
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        pullRequestObserved: undefined,
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Created],
          },
        ],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionBranch],
      },
    });

    expect(writeData.metadata).not.toHaveProperty("prRefs");
    expect(writeData.metadata).not.toHaveProperty("repositoryFullName");
    expect(writeData.metadata).not.toHaveProperty("prNumber");
  });

  it("falls through to the SessionPrSet lane when no Branch or SessionPr kind is declared", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {
        linkKind: SessionArtifactLinkKind.SessionPrSet,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      },
    });

    expect(writeData.metadata.linkKind).toBe(
      SessionArtifactLinkKind.SessionBranch
    );
  });

  it("falls through to the SessionPrProse lane when no Branch/SessionPr/SessionPrSet kind is declared", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {
        // A stale `linkKind` distinct from SessionPrProse, so the fallback
        // ternary at the end of sessionBranchTopLevelLinkKind (which returns
        // `current` when the linkKinds set matches none of the named kinds)
        // would surface a DIFFERENT value than SessionPrProse if the
        // SessionPrProse check above it were ever skipped — proving this
        // test actually exercises that check rather than the fallback.
        linkKind: "zzz_unrelated_legacy_kind",
        linkKinds: [SessionArtifactLinkKind.SessionPrProse],
      },
    });

    expect(writeData.metadata.linkKind).toBe(
      SessionArtifactLinkKind.SessionPrProse
    );
  });

  it("returns SessionBranch from the has-check even when a stale linkKind string differs", () => {
    // Same discrimination as above, for the SessionBranch check: linkKinds
    // carries SessionBranch, but the persisted `linkKind` scalar is a
    // different stale string, so a passing assertion here can only mean the
    // `linkKinds.has(SessionBranch)` check fired, not the ternary fallback.
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate(),
      initialMetadata: {
        linkKind: "zzz_unrelated_legacy_kind",
        linkKinds: [SessionArtifactLinkKind.SessionBranch],
      },
    });

    expect(writeData.metadata.linkKind).toBe(
      SessionArtifactLinkKind.SessionBranch
    );
  });

  it("defaults an unrecognized linkKind to SessionBranch when no known kind is declared", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {},
    });

    expect(writeData.metadata.linkKind).toBe(
      SessionArtifactLinkKind.SessionBranch
    );
  });

  it("preserves a legacy string linkKind when no known kind is declared", () => {
    // pins current behavior; looks odd because "legacy_kind" is not a member
    // of SessionArtifactLinkKind, but collectSessionArtifactLinkKinds still
    // folds any string linkKind into the working set, and the fallback
    // ternary hands it straight back out.
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: { linkKind: "legacy_kind" },
    });

    expect(writeData.metadata.linkKind).toBe("legacy_kind");
  });

  it("ignores a non-string entry in a persisted linkKinds array", () => {
    // Trust-boundary input: `metadata` is a persisted jsonb blob, so a
    // malformed linkKinds array (a stray number) is reachable at runtime even
    // though the TS type says string[].
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate(),
      initialMetadata: {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionBranch, 42],
      },
    });

    expect(writeData.metadata.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionBranch,
    ]);
    expect(writeData.metadata.linkKind).toBe(
      SessionArtifactLinkKind.SessionBranch
    );
  });

  it("nulls out the participation method when direct evidence carries no method", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        directParticipation: BranchParticipationKind.Wrote,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [],
      }),
    });

    expect(writeData).toMatchObject({
      branchParticipation: BranchParticipationKind.Wrote,
      branchParticipationMethod: null,
      branchParticipationObservedAt: null,
    });
  });

  it("falls back to the aggregate's own observedAt when no lifecycle event carries a timestamp", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        observedAt: "2026-05-01T00:00:00.000Z",
        branchLifecycleEvents: [
          lifecycleEvent(BranchLifecycleBoundaryKind.ReviewFeedback),
        ],
        prRefs: [],
      }),
    });

    expect(writeData.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(writeData.branchParticipationObservedAt).toEqual(
      new Date("2026-05-01T00:00:00.000Z")
    );
  });

  it("keeps the latest of several Review-Feedback timestamps, skipping other kinds and missing timestamps", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        branchLifecycleEvents: [
          lifecycleEvent(
            BranchLifecycleBoundaryKind.SessionStart,
            "2026-01-01T00:00:00.000Z"
          ),
          lifecycleEvent(BranchLifecycleBoundaryKind.ReviewFeedback),
          lifecycleEvent(
            BranchLifecycleBoundaryKind.ReviewFeedback,
            "2026-01-05T00:00:00.000Z"
          ),
          lifecycleEvent(
            BranchLifecycleBoundaryKind.ReviewFeedback,
            "2026-01-03T00:00:00.000Z"
          ),
        ],
        prRefs: [],
      }),
    });

    expect(writeData.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(writeData.branchParticipationObservedAt).toEqual(
      new Date("2026-01-05T00:00:00.000Z")
    );
  });

  it("reads a legacy relation-derived participation from stored metadata when method/observedAt are absent", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [],
      }),
      initialMetadata: {
        relation: ArtifactRefRelation.Created,
      },
    });

    expect(writeData.branchParticipation).toBe(BranchParticipationKind.Wrote);
    expect(writeData.branchParticipationMethod).toBeNull();
    expect(writeData.branchParticipationObservedAt).toBeNull();
  });

  it("reads a legacy lifecycle-derived Reviewed participation from stored metadata with no valid timestamp", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [],
      }),
      initialMetadata: {
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.McpToolCall,
        branchLifecycleEvents: [
          lifecycleEvent(BranchLifecycleBoundaryKind.ReviewFeedback),
        ],
      },
    });

    expect(writeData.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(writeData.branchParticipationMethod).toBeNull();
    expect(writeData.branchParticipationObservedAt).toBeNull();
  });

  it("keeps the SessionBranch linkKind when the only PR ref is prose-derived", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: baseAggregate({
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 9,
            relationTypes: [SessionPrRelationType.Referenced],
            method: ArtifactRefMethod.PrMentionInProse,
          },
        ],
      }),
    });

    expect(writeData.metadata.linkKind).toBe(
      SessionArtifactLinkKind.SessionBranch
    );
  });
});

function baseAggregate(
  overrides: Partial<BranchRefAggregate> = {}
): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    observedAt: "2026-08-31T12:00:00.000Z",
    branchLifecycleEvents: [],
    directParticipation: BranchParticipationKind.Wrote,
    directParticipationMethod: ArtifactRefMethod.PrCreateOutput,
    directParticipationObservedAt: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

function lifecycleEvent(
  kind: BranchLifecycleBoundaryKind,
  observedAt?: string
): SyncedBranchLifecycleEvent {
  return { kind, ...(observedAt ? { observedAt } : {}) };
}
