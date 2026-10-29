import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { getSessionBranchCounts } from "./session-branch-divisor";

describe("getSessionBranchCounts", () => {
  it("counts distinct global corpus targets only for persisted sessions", async () => {
    const artifactLinkFindMany = vi
      .fn()
      .mockResolvedValue([
        sessionBranchLink("session-1", "branch-visible"),
        sessionBranchLink("session-1", "branch-visible"),
        sessionBranchLink("session-1", "branch-off-page"),
      ]);
    const db = {
      artifactLink: { findMany: artifactLinkFindMany },
    } as unknown as Parameters<typeof getSessionBranchCounts>[0];

    const counts = await getSessionBranchCounts(db, "org-1", ["session-1"]);

    expect(counts).toEqual(new Map([["session-1", 2]]));
    expect(artifactLinkFindMany).toHaveBeenCalledOnce();
    const where = artifactLinkFindMany.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      organizationId: "org-1",
      linkType: LinkType.RelatesTo,
      sourceId: { in: ["session-1"] },
      source: {
        organizationId: "org-1",
        type: ArtifactType.SESSION,
        session: { isNot: null },
      },
      target: {
        organizationId: "org-1",
        type: ArtifactType.BRANCH,
        branch: { isNot: null },
      },
    });
    expect(where).not.toHaveProperty("targetId");
  });

  it("limits the canonical divisor to globally eligible authority Branches", async () => {
    const artifactLinkFindMany = vi
      .fn()
      .mockResolvedValue([
        sessionBranchLink("session-1", "branch-eligible"),
        sessionBranchLink("session-1", "branch-default"),
      ]);
    const db = {
      artifactLink: { findMany: artifactLinkFindMany },
    } as unknown as Parameters<typeof getSessionBranchCounts>[0];

    const counts = await getSessionBranchCounts(
      db,
      "org-1",
      ["session-1"],
      ["branch-eligible"]
    );

    expect(counts).toEqual(new Map([["session-1", 1]]));
    expect(artifactLinkFindMany.mock.calls[0]?.[0].where).not.toHaveProperty(
      "targetId"
    );
  });

  it("excludes explicit and metadata-derived Reviewed branches from the divisor", async () => {
    const artifactLinkFindMany = vi.fn().mockResolvedValue([
      sessionBranchLink("session-1", "branch-wrote"),
      sessionBranchLink("session-1", "branch-reviewed", {
        branchParticipation: BranchParticipationKind.Reviewed,
      }),
      sessionBranchLink("session-1", "branch-metadata-reviewed", {
        branchParticipation: null,
        metadata: {
          branchParticipation: BranchParticipationKind.Reviewed,
          linkKind: SessionArtifactLinkKind.SessionBranch,
        },
      }),
      sessionBranchLink("session-1", "branch-legacy", {
        branchParticipation: null,
      }),
    ]);
    const db = {
      artifactLink: { findMany: artifactLinkFindMany },
    } as unknown as Parameters<typeof getSessionBranchCounts>[0];

    const counts = await getSessionBranchCounts(db, "org-1", ["session-1"]);

    expect(counts).toEqual(new Map([["session-1", 2]]));
  });
});

function sessionBranchLink(
  sourceId: string,
  targetId: string,
  overrides: {
    branchParticipation?: BranchParticipationKind | null;
    metadata?: Record<string, unknown>;
  } = {}
) {
  return {
    sourceId,
    targetId,
    branchParticipation:
      overrides.branchParticipation === undefined
        ? BranchParticipationKind.Wrote
        : overrides.branchParticipation,
    metadata: overrides.metadata ?? {
      linkKind: SessionArtifactLinkKind.SessionBranch,
    },
  };
}
