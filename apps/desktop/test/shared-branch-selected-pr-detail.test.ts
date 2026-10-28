import assert from "node:assert/strict";
import {
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  BranchLinkedArtifactEvidenceKind,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import { BranchAssociatedPullRequestSelectionReason } from "@repo/api/src/types/branch-associated-pull-request.js";
import { describe, test } from "vitest";
import { getSharedBranchDetail } from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

const BRANCH_ID = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/ISS-4473-x",
});

describe("Desktop local selected pull-request detail", () => {
  test("projects an explicitly selected persisted historical PR", async () => {
    const detail = await getSharedBranchDetail(sourceWithHistory(), BRANCH_ID, {
      repositoryFullName: "acme/web",
      pullRequestNumber: 41,
    });

    assert.equal(detail?.prNumber, 41);
    assert.equal(detail?.prTitle, null);
    assert.equal(detail?.selectedPullRequest?.repositoryFullName, "acme/web");
    assert.equal(detail?.selectedPullRequest?.number, 41);
    assert.equal(detail?.selectedPullRequest?.body, null);
    assert.equal(detail?.selectedPullRequest?.headRefOid, null);
    assert.deepEqual(detail?.selectedPullRequestChecks, {
      status: "unavailable",
      source: "evidence",
      reason: "missing_immutable_revision",
    });
    assert.equal(detail?.associatedPullRequests?.selectedId, "acme/web#41");
    assert.equal(
      detail?.associatedPullRequests?.selectionReason,
      BranchAssociatedPullRequestSelectionReason.Explicit
    );
    assert.deepEqual(detail?.linkedArtifacts, [
      {
        slug: "ISS-4473",
        evidence: { kind: BranchLinkedArtifactEvidenceKind.BranchNameSlug },
      },
    ]);
    assert.deepEqual(detail?.linkedArtifactsCollection, {
      state: BranchLinkedArtifactCollectionState.Incomplete,
      provenance: BranchLinkedArtifactCollectionProvenance.BranchNameOnly,
    });
  });

  test("fails closed for an unassociated explicit identity", async () => {
    const detail = await getSharedBranchDetail(sourceWithHistory(), BRANCH_ID, {
      repositoryFullName: "other/repo",
      pullRequestNumber: 41,
    });

    assert.equal(detail, null);
  });

  test("offers no default selection when several PRs are unobserved and none is requested", async () => {
    const detail = await getSharedBranchDetail(sourceWithHistory(), BRANCH_ID);

    assert.equal(detail?.prNumber, null);
    assert.equal(detail?.associatedPullRequests?.selectedId, null);
    assert.equal(
      detail?.associatedPullRequests?.selectionReason,
      BranchAssociatedPullRequestSelectionReason.Ambiguous
    );
    assert.deepEqual(
      detail?.associatedPullRequests?.items.map(({ number }) => number),
      [41, 42]
    );
    assert.equal(detail?.multiPrWarning, true);
  });
});

function sourceWithHistory() {
  return makeSource({
    links: [link({ branch_name: "feature/ISS-4473-x", session_id: "s1" })],
    prs: [
      {
        repo_full_name: "acme/web",
        branch_name: "feature/ISS-4473-x",
        pr_number: 41,
        pr_url: "https://github.com/acme/web/pull/41",
        closed_at: "2026-06-09T12:00:00.000Z",
        observed_at: "2026-06-09T12:00:00.000Z",
      },
      {
        repo_full_name: "acme/web",
        branch_name: "feature/ISS-4473-x",
        pr_number: 42,
        pr_url: "https://github.com/acme/web/pull/42",
        title: "Active PR",
        opened_at: "2026-06-10T12:00:00.000Z",
        observed_at: "2026-06-10T12:00:00.000Z",
      },
    ],
  });
}
