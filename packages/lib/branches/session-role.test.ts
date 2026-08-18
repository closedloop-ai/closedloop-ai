import { BranchSessionRole } from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  type BranchSessionRoleEvidence,
  classifyBranchSessionRole,
} from "./session-role";

const target = {
  repositoryFullName: "closedloop-ai/symphony-alpha",
  branchName: "codex/fea-3752-branch-session-role-classifier",
  prNumber: 3752,
};

describe("classifyBranchSessionRole", () => {
  it("returns related for no evidence", () => {
    expect(classifyBranchSessionRole({ evidence: [] })).toBe(
      BranchSessionRole.Related
    );
  });

  it("classifies PR created evidence as build", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [prEvidence([SessionPrRelationType.Created])],
      })
    ).toBe(BranchSessionRole.Build);
  });

  it("classifies branch write relation evidence as build", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [
          branchEvidence({ relation: ArtifactRefRelation.Created }),
          branchEvidence({ relation: ArtifactRefRelation.Output }),
        ],
      })
    ).toBe(BranchSessionRole.Build);
  });

  it("classifies branch push method evidence as build", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [branchEvidence({ method: BRANCH_PUSH_METHOD_VALUES[0] })],
      })
    ).toBe(BranchSessionRole.Build);
  });

  it("classifies PR reviewed and referenced evidence as review", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [prEvidence([SessionPrRelationType.Reviewed])],
      })
    ).toBe(BranchSessionRole.Review);

    expect(
      classifyBranchSessionRole({
        evidence: [prEvidence([SessionPrRelationType.Referenced])],
      })
    ).toBe(BranchSessionRole.Review);
  });

  it("classifies branch workspace and reference evidence as review", () => {
    for (const relation of [
      ArtifactRefRelation.Workspace,
      ArtifactRefRelation.Input,
      ArtifactRefRelation.Referenced,
      ArtifactRefRelation.Reviewed,
    ]) {
      expect(
        classifyBranchSessionRole({
          evidence: [branchEvidence({ relation })],
        })
      ).toBe(BranchSessionRole.Review);
    }
  });

  it("keeps passive references as review membership context only", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [
          prEvidence([SessionPrRelationType.Referenced]),
          branchEvidence({ relation: ArtifactRefRelation.Workspace }),
        ],
      })
    ).toBe(BranchSessionRole.Review);
  });

  it("keeps build precedence over review evidence across link kinds", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [
          prEvidence([SessionPrRelationType.Reviewed]),
          branchEvidence({ relation: ArtifactRefRelation.Workspace }),
          branchEvidence({ relation: ArtifactRefRelation.Output }),
        ],
      })
    ).toBe(BranchSessionRole.Build);
  });

  it("dedupes repeated cross-link evidence without changing precedence", () => {
    const repeatedPrReview = prEvidence([SessionPrRelationType.Reviewed]);
    const repeatedBranchBuild = branchEvidence({
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [
        SessionArtifactLinkKind.SessionPr,
        SessionArtifactLinkKind.SessionBranch,
      ],
      relation: ArtifactRefRelation.Created,
    });

    expect(
      classifyBranchSessionRole({
        evidence: [
          repeatedPrReview,
          repeatedPrReview,
          repeatedBranchBuild,
          repeatedBranchBuild,
        ],
      })
    ).toBe(BranchSessionRole.Build);
  });

  it("keeps PR build precedence for merged branch and PR evidence", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [
          branchEvidence({
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [
              SessionArtifactLinkKind.SessionBranch,
              SessionArtifactLinkKind.SessionPr,
            ],
            relation: ArtifactRefRelation.Workspace,
            relationTypes: [SessionPrRelationType.Created],
          }),
        ],
      })
    ).toBe(BranchSessionRole.Build);
  });

  it("does not drop matching branch evidence when merged PR evidence targets another PR", () => {
    expect(
      classifyBranchSessionRole({
        target,
        evidence: [
          branchEvidence({
            linkKinds: [
              SessionArtifactLinkKind.SessionBranch,
              SessionArtifactLinkKind.SessionPr,
            ],
            prNumber: 1234,
            relation: ArtifactRefRelation.Created,
            relationTypes: [SessionPrRelationType.Created],
          }),
        ],
      })
    ).toBe(BranchSessionRole.Build);
  });

  it("ignores foreign target build evidence", () => {
    expect(
      classifyBranchSessionRole({
        target,
        evidence: [
          branchEvidence({
            branchName: "codex/another-branch",
            relation: ArtifactRefRelation.Created,
          }),
          branchEvidence({
            branchName: target.branchName,
            relation: ArtifactRefRelation.Workspace,
          }),
        ],
      })
    ).toBe(BranchSessionRole.Review);
  });

  it("returns related for low-confidence build-looking evidence", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [
          prEvidence([SessionPrRelationType.Created], { confidence: 0.49 }),
          branchEvidence({
            confidence: 0.49,
            relation: ArtifactRefRelation.Created,
          }),
        ],
      })
    ).toBe(BranchSessionRole.Related);
  });

  it("returns related for unknown evidence without throwing", () => {
    expect(
      classifyBranchSessionRole({
        evidence: [
          {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            method: "unknown_method",
          },
          { linkKind: SessionArtifactLinkKind.SessionPr },
        ],
      })
    ).toBe(BranchSessionRole.Related);
  });
});

function prEvidence(
  relationTypes: readonly SessionPrRelationType[],
  overrides: Partial<BranchSessionRoleEvidence> = {}
): BranchSessionRoleEvidence {
  return {
    linkKind: SessionArtifactLinkKind.SessionPr,
    relationTypes,
    repositoryFullName: target.repositoryFullName,
    prNumber: target.prNumber,
    ...overrides,
  };
}

function branchEvidence(
  overrides: Partial<BranchSessionRoleEvidence>
): BranchSessionRoleEvidence {
  return {
    linkKind: SessionArtifactLinkKind.SessionBranch,
    repositoryFullName: target.repositoryFullName,
    branchName: target.branchName,
    ...overrides,
  };
}
