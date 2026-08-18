import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mockWarn, error: vi.fn(), info: vi.fn() },
}));

import {
  InvalidCurrentPullRequestRelationLane,
  isCurrentPullRequestRelationValid,
  logInvalidCurrentPullRequestRelation,
} from "@/lib/resolve-pr-context";

/**
 * Truth table for the current-PR relation guard.
 *
 * `BranchDetail.currentPullRequestDetailId` is an unconstrained FK, so the row it
 * resolves to can belong to another branch — that is what this guard exists to
 * reject, and `branchArtifactId` is the whole ownership key.
 *
 * `repositoryId` is carried on both real row shapes but deliberately NOT
 * consulted: it is a per-installation surrogate
 * (`GitHubInstallationRepository @@unique([installationId, githubRepoId])`), so an
 * App reinstall mints a new one and the branch and its own PR are re-homed onto
 * it by different, independently gated writers. The cases below therefore pass
 * production-shaped rows that carry it, so a future change that starts comparing
 * it again fails here rather than in production.
 */

const BRANCH_ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BRANCH_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_REPOSITORY_ID = "44444444-4444-4444-8444-444444444444";
const PULL_REQUEST_DETAIL_ID = "55555555-5555-4555-8555-555555555555";

function branchRow(repositoryId: string | null) {
  return { artifactId: BRANCH_ARTIFACT_ID, repositoryId };
}

function pullRequestRow(branchArtifactId: string, repositoryId: string | null) {
  return {
    id: PULL_REQUEST_DETAIL_ID,
    branchArtifactId,
    repositoryId,
  };
}

describe("isCurrentPullRequestRelationValid", () => {
  it("accepts a PR that names this branch and shares its repositoryId", () => {
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(REPOSITORY_ID),
        pullRequestRow(BRANCH_ARTIFACT_ID, REPOSITORY_ID)
      )
    ).toBe(true);
  });

  it("accepts a repo-less PR row on a branch that carries a repositoryId", () => {
    // A suspended installation leaves a newly synced PR row unenriched while the
    // branch keeps the id it was adopted with.
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(REPOSITORY_ID),
        pullRequestRow(BRANCH_ARTIFACT_ID, null)
      )
    ).toBe(true);
  });

  it("accepts an enriched PR row on a repo-less branch", () => {
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(null),
        pullRequestRow(BRANCH_ARTIFACT_ID, REPOSITORY_ID)
      )
    ).toBe(true);
  });

  it("accepts a non-App pair where neither side carries a repositoryId", () => {
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(null),
        pullRequestRow(BRANCH_ARTIFACT_ID, null)
      )
    ).toBe(true);
  });

  it("accepts this branch's own PR when both sides carry DIFFERENT repositoryIds", () => {
    // The App-reinstall shape, and the reason the surrogate comparison is gone:
    // the reinstall mints a new installation-repo id, `branch-service` rewrites
    // `BranchDetail.repositoryId` to it unconditionally, and
    // `upsertCurrentPullRequestDetail` keys the PR on the reinstall-stable
    // `githubId` while omitting `repositoryId` from its update. The row still
    // names this branch, so it IS this branch's PR.
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(REPOSITORY_ID),
        pullRequestRow(BRANCH_ARTIFACT_ID, OTHER_REPOSITORY_ID)
      )
    ).toBe(true);
  });

  it("rejects a PR that names a different branch artifact", () => {
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(REPOSITORY_ID),
        pullRequestRow(OTHER_BRANCH_ARTIFACT_ID, REPOSITORY_ID)
      )
    ).toBe(false);
  });

  it("rejects a different branch artifact even when neither side is enriched", () => {
    // `branchArtifactId` is the whole ownership key, so the repo-less pair must
    // not become a hole in the cross-branch guard.
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(null),
        pullRequestRow(OTHER_BRANCH_ARTIFACT_ID, null)
      )
    ).toBe(false);
  });

  it("rejects a different branch artifact even when the repositoryIds agree", () => {
    // Two branches in the SAME repo is the ordinary case, so the surviving key
    // has to reject it on the branch half alone.
    expect(
      isCurrentPullRequestRelationValid(
        branchRow(REPOSITORY_ID),
        pullRequestRow(OTHER_BRANCH_ARTIFACT_ID, REPOSITORY_ID)
      )
    ).toBe(false);
  });

  it("rejects an absent relation", () => {
    const branch = branchRow(REPOSITORY_ID);
    expect(isCurrentPullRequestRelationValid(branch, null)).toBe(false);
    expect(isCurrentPullRequestRelationValid(branch, undefined)).toBe(false);
  });
});

describe("logInvalidCurrentPullRequestRelation", () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it.each([
    InvalidCurrentPullRequestRelationLane.Primary,
    InvalidCurrentPullRequestRelationLane.MissingContextFallback,
  ])("tags the %s lane on the shared warn", (lane) => {
    // Both readers share one warn, so the lane is the only thing telling a
    // monitor whether the corrupt FK was found on a readable installation.
    logInvalidCurrentPullRequestRelation({
      lane,
      branch: branchRow(REPOSITORY_ID),
      currentPullRequestDetail: pullRequestRow(
        OTHER_BRANCH_ARTIFACT_ID,
        OTHER_REPOSITORY_ID
      ),
    });

    expect(mockWarn).toHaveBeenCalledWith(
      "[resolve-pr-context] Ignoring invalid current PR relation",
      {
        lane,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        currentPullRequestDetailId: PULL_REQUEST_DETAIL_ID,
        currentPullRequestRepositoryId: OTHER_REPOSITORY_ID,
        currentPullRequestBranchArtifactId: OTHER_BRANCH_ARTIFACT_ID,
        repositoryId: REPOSITORY_ID,
      }
    );
  });
});
