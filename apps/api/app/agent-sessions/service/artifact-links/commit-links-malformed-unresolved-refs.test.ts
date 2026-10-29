import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { persistSessionCommitRefs } from "./commit-links";

const ORGANIZATION_ID = "org-1";
const SESSION_ARTIFACT_ID = "session-artifact-1";

describe("persistSessionCommitRefs malformed stored unresolved refs", () => {
  it("filters malformed stored unresolved commit refs while keeping valid ones and the new one", async () => {
    const branchFindMany = vi.fn().mockResolvedValue([]);
    const sessionDetailUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      branchDetail: { findMany: branchFindMany },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({
          metadata: {
            _unresolvedCommitRefs: [
              // Invalid: not an object at all.
              null,
              // Invalid: not an object at all (string).
              "not-an-object",
              // Invalid: repositoryFullName present but not a string.
              { repositoryFullName: 123, branchName: "b", sha: "s" },
              // Invalid: branchName present but not a string.
              { repositoryFullName: "r", branchName: 123, sha: "s" },
              // Invalid: sha present but not a string.
              { repositoryFullName: "r", branchName: "b", sha: 123 },
              // Valid — must survive the filter.
              { repositoryFullName: "r0", branchName: "b0", sha: "s0" },
            ],
          },
        }),
        update: sessionDetailUpdate,
      },
    };

    // No branches resolve, so the new ref is ALSO deferred, alongside whatever
    // survives the filter over the previously stored malformed/valid mix.
    await persistSessionCommitRefs(
      tx as never,
      ORGANIZATION_ID,
      SESSION_ARTIFACT_ID,
      [
        {
          kind: ArtifactRefTargetKind.Commit,
          repositoryFullName: "r1",
          branchName: "b1",
          sha: "s1",
          method: ArtifactRefMethod.GitCommand,
          relation: ArtifactRefRelation.Created,
        },
      ]
    );

    expect(branchFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        OR: [{ repositoryFullName: "r1", branchName: "b1" }],
      },
      select: {
        artifactId: true,
        repositoryFullName: true,
        branchName: true,
      },
    });
    expect(sessionDetailUpdate).toHaveBeenCalledTimes(1);
    const [update] = sessionDetailUpdate.mock.calls[0];
    expect(update.where).toEqual({ artifactId: SESSION_ARTIFACT_ID });
    expect(update.data.metadata._unresolvedCommitRefs).toEqual([
      { repositoryFullName: "r0", branchName: "b0", sha: "s0" },
      { repositoryFullName: "r1", branchName: "b1", sha: "s1" },
    ]);
  });
});
