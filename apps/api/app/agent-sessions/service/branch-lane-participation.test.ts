import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { describe, expect, it } from "vitest";
import { branchLaneParticipationKind } from "./provenance-eligibility";

describe("branchLaneParticipationKind (ISS-12552, PRD-800)", () => {
  it("reads no participation from a slug-lane mention, whatever its relation", () => {
    for (const relation of [
      ArtifactRefRelation.Output,
      ArtifactRefRelation.Created,
    ]) {
      expect(
        branchLaneParticipationKind({
          branchParticipation: null,
          metadata: {
            role: "output",
            method: ArtifactRefMethod.McpToolCall,
            isPrimary: false,
            relation,
          },
        })
      ).toBeUndefined();
    }
  });

  it("keeps the participation a branch or pull request link records", () => {
    expect(
      branchLaneParticipationKind({
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: {},
      })
    ).toBe(ProvenanceRelationshipKind.Contribution);
    expect(
      branchLaneParticipationKind({
        branchParticipation: null,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          relation: ArtifactRefRelation.Output,
        },
      })
    ).toBe(ProvenanceRelationshipKind.Contribution);
  });
});
