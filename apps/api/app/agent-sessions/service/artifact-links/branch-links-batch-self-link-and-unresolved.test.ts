/**
 * ISS-11280: three arms of the batch entry point
 * `persistSessionBranchArtifactLinks` that the existing push-gate /
 * materialization-budget suites never exercise:
 *  - a branch resolving to the SESSION's own artifact id (self-link skip),
 *  - priority seeding on a freshly materialized branch, and
 *  - `isUnresolvedBranchRef`'s runtime type guard over a session's own
 *    stored `_unresolvedBranchRefs`, a trust-boundary read (persisted JSON,
 *    not a type-checked in-process value).
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  branchAuthorityMap,
  makeBranchLinksTx,
} from "@/__tests__/support/agent-sessions/branch-links.test-harness";
import { CloudBranchNonMaterializationKind } from "@/app/branches/branch-write-eligibility";
import { persistSessionBranchArtifactLinks } from "./branch-links";

const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;
const ORG = "org-1";
const REPO = "acme/web";
const BRANCH = "feat/x";
const SESSION_ARTIFACT_ID = "persisted-session-1";
const OBSERVED_AT = "2026-05-20T17:03:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("persistSessionBranchArtifactLinks — self-link and priority-seed arms", () => {
  it("writes no session link when a branch resolves to the session's own artifact id", async () => {
    const double = makeBranchLinksTx(SESSION_ARTIFACT_ID);

    await persistSessionBranchArtifactLinks(
      double.tx,
      ORG,
      null,
      SESSION_ARTIFACT_ID,
      [
        {
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPO,
          branchName: BRANCH,
          method: GIT_PUSH_METHOD,
          relation: ArtifactRefRelation.Created,
          observedAt: OBSERVED_AT,
        },
      ],
      branchAuthorityMap([REPO])
    );

    expect(double.linkRow).not.toHaveBeenCalled();
    // The branch already exists (as the session's own artifact) — nothing new
    // to create either.
    expect(double.artifactCreateMany).not.toHaveBeenCalled();
  });

  it("seeds a freshly materialized branch's priority from the synced ref (ISS-10332)", async () => {
    const double = makeBranchLinksTx();
    const artifactUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const branchArtifact = double.tx.artifact as unknown as {
      createMany: unknown;
      updateMany: ReturnType<typeof vi.fn>;
    };
    branchArtifact.updateMany = artifactUpdateMany;

    await persistSessionBranchArtifactLinks(
      double.tx,
      ORG,
      null,
      SESSION_ARTIFACT_ID,
      [
        {
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPO,
          branchName: BRANCH,
          method: GIT_PUSH_METHOD,
          relation: ArtifactRefRelation.Created,
          observedAt: OBSERVED_AT,
          priority: Priority.High,
        },
      ],
      branchAuthorityMap([REPO])
    );

    expect(double.artifactCreateMany).toHaveBeenCalledTimes(1);
    const createdId = double.artifactCreateMany.mock.calls[0][0].data[0].id;
    expect(artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [createdId] },
        organizationId: ORG,
        type: ArtifactType.Branch,
        priority: null,
      },
      data: { priority: Priority.High },
    });
  });

  it("drops malformed entries from a session's stored unresolved-branch list while keeping valid ones", async () => {
    const double = makeBranchLinksTx();
    const existingUnresolved: unknown[] = [
      null,
      "garbage",
      {
        repositoryFullName: "acme/existing",
        branchName: "old-branch",
        cause: CloudBranchNonMaterializationKind.DefaultBranch,
      },
      { repositoryFullName: "acme/missing-branch-name" },
      { repositoryFullName: 123, branchName: "x" },
      {
        repositoryFullName: "acme/bogus-cause",
        branchName: "y",
        cause: "not_a_real_cause",
      },
      { repositoryFullName: "acme/existing4", branchName: "z" },
    ];
    (
      double.tx.sessionDetail.findUnique as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      metadata: { _unresolvedBranchRefs: existingUnresolved },
    });

    // "main" is the repository's default branch (branchAuthorityMap), which
    // `isCloudBranchEligible` rejects — a non-retryable cause, so it lands in
    // `_unresolvedBranchRefs`.
    await persistSessionBranchArtifactLinks(
      double.tx,
      ORG,
      null,
      SESSION_ARTIFACT_ID,
      [
        {
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPO,
          branchName: "main",
          method: GIT_PUSH_METHOD,
          relation: ArtifactRefRelation.Created,
          observedAt: OBSERVED_AT,
        },
      ],
      branchAuthorityMap([REPO])
    );

    const call = double.sessionDetailUpdate.mock.calls.find(
      (entry) =>
        (entry[0] as { data?: { metadata?: Record<string, unknown> } }).data
          ?.metadata?._unresolvedBranchRefs !== undefined
    );
    expect(call).toBeDefined();
    const stored = (
      call![0] as { data: { metadata: { _unresolvedBranchRefs: unknown } } }
    ).data.metadata._unresolvedBranchRefs;
    expect(stored).toEqual([
      {
        repositoryFullName: "acme/existing",
        branchName: "old-branch",
        cause: CloudBranchNonMaterializationKind.DefaultBranch,
      },
      { repositoryFullName: "acme/existing4", branchName: "z" },
      {
        repositoryFullName: REPO,
        branchName: "main",
        cause: CloudBranchNonMaterializationKind.DefaultBranch,
      },
    ]);
  });
});
