import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { collectBranchRefs, collectPullRequestRefs } from "./shared";

const REPOSITORY = "closedloop-ai/symphony-alpha";

describe("generic artifact-link materialization", () => {
  it("excludes transport-only monitored activity refs from Branch and PR links", () => {
    const refs = [
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPOSITORY,
        branchName: "feat/regular",
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Created,
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPOSITORY,
        branchName: "feat/activity-only",
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Reviewed,
        monitoredActivityOnly: true,
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: 6060,
        method: ArtifactRefMethod.PrReviewCommand,
        relation: ArtifactRefRelation.Reviewed,
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: 6061,
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Reviewed,
        monitoredActivityOnly: true,
      },
    ] satisfies SyncedArtifactRef[];

    expect(collectBranchRefs(refs).map((ref) => ref.branchName)).toEqual([
      "feat/regular",
    ]);
    expect(collectPullRequestRefs(refs).map((ref) => ref.prNumber)).toEqual([
      6060,
    ]);
  });
});
