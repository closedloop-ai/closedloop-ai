import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { expect, it, vi } from "vitest";
import {
  ArtifactType,
  GitHubPRState,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
} from "../../../../generated/client";
import { seedBranchProductEvidence } from "../../branch-product-evidence";
import { baselineContext } from "../fixtures/baseline-org";
import { createMockPrisma } from "../fixtures/mock-prisma";

const input = {
  organizationId: baselineContext.organizationId,
  githubRepositoryId: "00000000-0000-4000-8000-000000000003",
  projectId: "00000000-0000-4000-8000-000000000004",
  computeTargetId: "00000000-0000-4000-8000-000000000005",
};

const observedAt = new Date("2026-01-01T11:00:00.000Z");

it("seeds a merged PR with complete proof for every lane, and one missing the reviews lane", async () => {
  const prisma = createMockPrisma();
  await seedBranchProductEvidence(prisma, input);

  const branchIds = new Map(
    vi
      .mocked(prisma.artifact.upsert)
      .mock.calls.map(([call]) => [call.create.name, call.create.id])
  );
  const pullRequests = vi
    .mocked(prisma.pullRequestDetail.upsert)
    .mock.calls.map(([call]) => call.create);
  const proof = vi
    .mocked(prisma.pullRequestCommentAcquisition.upsert)
    .mock.calls.map(([call]) => call.create);
  const pullRequestFor = (branchName: string) =>
    pullRequests.find(
      (row) => row.branchArtifactId === branchIds.get(branchName)
    );
  const lanesFor = (branchName: string) => {
    const pullRequest = pullRequestFor(branchName);
    expect(pullRequest).toMatchObject({
      organizationId: input.organizationId,
      repositoryId: input.githubRepositoryId,
      prState: GitHubPRState.MERGED,
    });
    const rows = proof.filter(
      (row) => row.pullRequestDetailId === pullRequest?.id
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        organizationId: input.organizationId,
        status: PullRequestCommentLaneStatus.COMPLETE,
      });
    }
    return rows.map((row) => row.lane).sort();
  };

  expect(lanesFor("seed/pr-comment-proof-complete")).toEqual(
    Object.values(PullRequestCommentLane).sort()
  );
  expect(lanesFor("seed/pr-comment-proof-missing-lane")).toEqual(
    [
      PullRequestCommentLane.ISSUE_COMMENTS,
      PullRequestCommentLane.REVIEW_COMMENTS,
    ].sort()
  );
  expect(
    pullRequestFor("seed/pr-comment-proof-complete")?.commentsReconciledAt
  ).toEqual(observedAt);
  expect(
    pullRequestFor("seed/pr-comment-proof-missing-lane")?.commentsReconciledAt
  ).toBeNull();
});

it("links each proof Branch to a Session that Wrote it, so Product eligibility lists it", async () => {
  const prisma = createMockPrisma();
  await seedBranchProductEvidence(prisma, input);

  const artifacts = vi
    .mocked(prisma.artifact.upsert)
    .mock.calls.map(([call]) => call.create);
  const links = vi
    .mocked(prisma.artifactLink.upsert)
    .mock.calls.map(([call]) => call.create);
  for (const branchName of [
    "seed/pr-comment-proof-complete",
    "seed/pr-comment-proof-missing-lane",
  ]) {
    const branch = artifacts.find((row) => row.name === branchName);
    expect(branch?.type).toBe(ArtifactType.BRANCH);
    const wrote = links.filter((link) => link.targetId === branch?.id);
    expect(wrote).toHaveLength(1);
    expect(wrote[0]).toMatchObject({
      organizationId: input.organizationId,
      linkType: LinkType.RelatesTo,
      branchParticipation: BranchParticipationKind.Wrote,
      metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
    });
    const session = artifacts.find((row) => row.id === wrote[0]?.sourceId);
    expect(session).toMatchObject({
      type: ArtifactType.SESSION,
      organizationId: input.organizationId,
      session: { create: { computeTargetId: input.computeTargetId } },
    });
  }
});
