import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import type { BranchRefAggregate } from "./branch-ref-aggregate";
import {
  buildSessionBranchLinkWriteData,
  SessionBranchLinkEvidenceSource,
  upsertSessionBranchLink,
  withoutSessionBranchProjectionFields,
} from "./session-branch-link-writer";
import { SESSION_PR_LINK_SOURCE } from "./session-pr-link-source";

const OBSERVED_AT = "2026-08-31T12:00:00.000Z";
const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;

describe("session Branch link writer metadata", () => {
  it("writes exact PR identity without branchLinked for PR-head Branch evidence", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: prHeadAggregate(),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Created],
        repositoryFullName: "acme/web",
        prNumber: 7,
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Created],
          },
        ],
        source: SESSION_PR_LINK_SOURCE,
        confidence: 1,
        extractorVersion: 1,
      },
    });

    expect(writeData).toMatchObject({
      branchParticipation: BranchParticipationKind.Wrote,
      branchParticipationMethod: ArtifactRefMethod.PrCreateOutput,
      branchParticipationObservedAt: new Date(OBSERVED_AT),
    });
    expect(writeData.metadata).toMatchObject({
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [
        SessionArtifactLinkKind.SessionBranch,
        SessionArtifactLinkKind.SessionPr,
      ],
      repositoryFullName: "acme/web",
      prNumber: 7,
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 7,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
      branchName: "feat/x",
      branchRepositoryFullName: "acme/web",
      branchParticipation: BranchParticipationKind.Wrote,
    });
    expect(writeData.metadata).not.toHaveProperty("branchLinked");
  });

  it("derives Reviewed participation instead of asserting Wrote", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: prHeadAggregate({
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
        relation: ArtifactRefRelation.Reviewed,
        directParticipation: BranchParticipationKind.Reviewed,
        directParticipationMethod: ArtifactRefMethod.PrReviewFeedbackCommand,
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Reviewed],
          },
        ],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Reviewed],
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Reviewed],
          },
        ],
      },
    });

    expect(writeData.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
    expect(writeData.metadata.branchParticipation).toBe(
      BranchParticipationKind.Reviewed
    );
  });

  it("does not declare a Branch link for passive PR-head evidence alone", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: prHeadAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Referenced],
          },
        ],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Referenced],
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Referenced],
          },
        ],
      },
    });

    expect(writeData.branchParticipation).toBeNull();
    expect(writeData.metadata.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionPr,
    ]);
    expect(writeData.metadata).not.toHaveProperty("branchLinked");
    expect(writeData.metadata).not.toHaveProperty("branchParticipation");
  });

  it("does not preserve stale PR-derived Wrote participation without independent branch evidence", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: prHeadAggregate({
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Referenced,
        directParticipation: undefined,
        directParticipationMethod: undefined,
        directParticipationObservedAt: undefined,
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationTypes: [SessionPrRelationType.Referenced],
          },
        ],
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      existing: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [
            SessionArtifactLinkKind.SessionBranch,
            SessionArtifactLinkKind.SessionPr,
          ],
          branchName: "feat/x",
          branchRepositoryFullName: "acme/web",
          branchParticipation: BranchParticipationKind.Wrote,
          prRefs: [
            {
              repositoryFullName: "acme/web",
              prNumber: 7,
              relationTypes: [SessionPrRelationType.Created],
            },
          ],
        },
        branchParticipation: BranchParticipationKind.Wrote,
        branchParticipationMethod: ArtifactRefMethod.PrCreateOutput,
        branchParticipationObservedAt: new Date(OBSERVED_AT),
      },
    });

    expect(writeData).toMatchObject({
      branchParticipation: null,
      branchParticipationMethod: null,
      branchParticipationObservedAt: null,
    });
    expect(writeData.metadata.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionPr,
    ]);
    expect(writeData.metadata.prRefs).toEqual([
      {
        repositoryFullName: "acme/web",
        prNumber: 7,
        relationTypes: [
          SessionPrRelationType.Created,
          SessionPrRelationType.Referenced,
        ],
      },
    ]);
    expect(writeData.metadata).not.toHaveProperty("branchLinked");
    expect(writeData.metadata).not.toHaveProperty("branchParticipation");
  });

  it("preserves PR-lane shared metadata when no Branch projection is present", () => {
    const metadata = withoutSessionBranchProjectionFields({
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Referenced,
      observedAt: OBSERVED_AT,
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 7,
          relationTypes: [SessionPrRelationType.Referenced],
        },
      ],
    });

    expect(metadata).toMatchObject({
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Referenced,
      observedAt: OBSERVED_AT,
    });
  });

  it("strips shared metadata only when it belongs to a Branch projection", () => {
    const metadata = withoutSessionBranchProjectionFields({
      method: ArtifactRefMethod.PrCreateOutput,
      relation: ArtifactRefRelation.Created,
      observedAt: OBSERVED_AT,
      branchName: "feat/x",
      branchRepositoryFullName: "acme/web",
    });

    expect(metadata).not.toHaveProperty("method");
    expect(metadata).not.toHaveProperty("relation");
    expect(metadata).not.toHaveProperty("observedAt");
    expect(metadata).not.toHaveProperty("branchName");
    expect(metadata).not.toHaveProperty("branchRepositoryFullName");
  });

  it("preserves independent Branch evidence while adding PR identity", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: prHeadAggregate(),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      existing: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionBranch],
          branchLinked: true,
          branchName: "feat/x",
          branchRepositoryFullName: "acme/web",
        },
        branchParticipation: BranchParticipationKind.Wrote,
        branchParticipationMethod: GIT_PUSH_METHOD,
        branchParticipationObservedAt: new Date("2026-08-30T12:00:00.000Z"),
      },
    });

    expect(writeData.metadata).toMatchObject({
      branchLinked: true,
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [
        SessionArtifactLinkKind.SessionBranch,
        SessionArtifactLinkKind.SessionPr,
      ],
      repositoryFullName: "acme/web",
      prNumber: 7,
    });
    expect(writeData.branchParticipationMethod).toBe(GIT_PUSH_METHOD);
  });

  it("preserves all PR identity metadata on a shared Branch link", () => {
    const writeData = buildSessionBranchLinkWriteData({
      aggregate: prHeadAggregate({
        prRefs: Array.from(
          { length: SHARED_LINK_PR_REF_COUNT },
          (_, index) => ({
            repositoryFullName: "acme/web",
            prNumber: index + 1,
            relationTypes: [SessionPrRelationType.Created],
          })
        ),
      }),
      evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
      initialMetadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
      },
    });

    expect(writeData.metadata.prRefs).toHaveLength(SHARED_LINK_PR_REF_COUNT);
  });

  it("propagates artifact-link upsert races", async () => {
    await expect(
      upsertSessionBranchLink(
        branchLinkTx({ code: "P2002" }),
        branchLinkInput()
      )
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      upsertSessionBranchLink(
        branchLinkTx({ code: "P2034" }),
        branchLinkInput()
      )
    ).rejects.toMatchObject({ code: "P2034" });
  });
});

function prHeadAggregate(
  overrides: Partial<BranchRefAggregate> = {}
): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    observedAt: OBSERVED_AT,
    branchLifecycleEvents: [],
    pullRequestObserved: true,
    branchRefObserved: false,
    directParticipation: BranchParticipationKind.Wrote,
    directParticipationMethod: ArtifactRefMethod.PrCreateOutput,
    directParticipationObservedAt: OBSERVED_AT,
    prRefs: [
      {
        repositoryFullName: "acme/web",
        prNumber: 7,
        relationTypes: [SessionPrRelationType.Created],
      },
    ],
    ...overrides,
  };
}

function branchLinkInput(): Parameters<typeof upsertSessionBranchLink>[1] {
  return {
    organizationId: "org-1",
    sessionArtifactId: "session-1",
    branchArtifactId: "branch-1",
    aggregate: prHeadAggregate({ branchRefObserved: true }),
  };
}

function branchLinkTx(
  error: unknown
): Parameters<typeof upsertSessionBranchLink>[0] {
  type BranchLinkTx = Parameters<typeof upsertSessionBranchLink>[0];
  type BranchLinkTxMock = Partial<Omit<BranchLinkTx, "artifactLink">> & {
    artifactLink: Pick<BranchLinkTx["artifactLink"], "findFirst" | "upsert">;
  };
  const tx: BranchLinkTxMock = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockRejectedValue(error),
    },
  };
  return tx as BranchLinkTx;
}

/** Past the retired 100-ref cap (ISS-9859), so a reinstated cap would fail. */
const SHARED_LINK_PR_REF_COUNT = 150;
