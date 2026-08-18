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
        branch: { deletedAt: null },
      },
    });
    expect(where).not.toHaveProperty("targetId");
  });
});

function sessionBranchLink(sourceId: string, targetId: string) {
  return {
    sourceId,
    targetId,
    branchParticipation: BranchParticipationKind.Wrote,
    metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
  };
}
