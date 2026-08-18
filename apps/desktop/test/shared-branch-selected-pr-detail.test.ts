import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  BranchLinkedArtifactEvidenceKind,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import { BranchAssociatedPullRequestSelectionReason } from "@repo/api/src/types/branch-associated-pull-request.js";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics.js";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link.js";
import { getSharedBranchDetail } from "../src/main/branch/shared-branches-api.js";
import {
  lifecycleEvent,
  link,
  makeSource,
} from "./shared-branches-test-helpers.js";

const BRANCH_ID = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/ISS-4473-x",
});

describe("Desktop local selected pull-request detail", () => {
  test("projects an explicitly selected persisted historical PR", async () => {
    const detail = await getSharedBranchDetail(
      sourceWithHistory(),
      BRANCH_ID,
      undefined,
      {
        repositoryFullName: "acme/web",
        pullRequestNumber: 41,
      }
    );

    assert.equal(detail?.prNumber, 41);
    assert.equal(detail?.prTitle, "Historical PR");
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
    const detail = await getSharedBranchDetail(
      sourceWithHistory(),
      BRANCH_ID,
      undefined,
      {
        repositoryFullName: "other/repo",
        pullRequestNumber: 41,
      }
    );

    assert.equal(detail, null);
  });

  test("keeps the deterministic default for an old renderer request", async () => {
    const detail = await getSharedBranchDetail(sourceWithHistory(), BRANCH_ID);

    assert.equal(detail?.prNumber, 42);
    assert.equal(detail?.selectedPullRequest?.number, 42);
    assert.equal(detail?.associatedPullRequests?.selectedId, "acme/web#42");
  });

  test("projects LOC from the selected historical PR when branch LOC is unavailable", async () => {
    const detail = await getSharedBranchDetail(
      sourceWithHistory(),
      BRANCH_ID,
      undefined,
      {
        repositoryFullName: "acme/web",
        pullRequestNumber: 41,
      }
    );

    assert.equal(detail?.additions, 41);
    assert.equal(detail?.deletions, 4);
    assert.equal(detail?.filesChanged, 2);
  });

  test("does not hydrate an explicit historical selection through the default-only overlay lane", async () => {
    let hydrationCalls = 0;
    const detail = await getSharedBranchDetail(
      sourceWithHistory(),
      BRANCH_ID,
      {
        hydrate: () => {
          hydrationCalls += 1;
          return Promise.resolve({ status: "fresh" });
        },
      },
      {
        repositoryFullName: "acme/web",
        pullRequestNumber: 41,
      }
    );

    assert.equal(detail?.selectedPullRequest?.number, 41);
    assert.equal(hydrationCalls, 0);
  });

  test("anchors a later selected PR cycle to persisted post-boundary push evidence", async () => {
    const detail = await getSharedBranchDetail(
      sourceWithSequentialHistory(),
      BRANCH_ID,
      undefined,
      {
        repositoryFullName: "acme/web",
        pullRequestNumber: 42,
      }
    );

    assert.equal(detail?.associatedPullRequests?.selectedId, "acme/web#42");
    assert.equal(
      detail?.canonicalMetrics?.leadTimeMs.state,
      BranchMetricAvailability.NotApplicable
    );
    assert.deepEqual(detail?.canonicalMetrics?.abandonmentTimeMs, {
      state: BranchMetricAvailability.Complete,
      value: 26 * 60 * 60 * 1000,
    });
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
        title: "Historical PR",
        state: "closed",
        lines_added: 41,
        lines_removed: 4,
        files_changed: 2,
        closed_at: "2026-06-09T12:00:00.000Z",
        observed_at: "2026-06-09T12:00:00.000Z",
      },
      {
        repo_full_name: "acme/web",
        branch_name: "feature/ISS-4473-x",
        pr_number: 42,
        pr_url: "https://github.com/acme/web/pull/42",
        title: "Active PR",
        state: "open",
        lines_added: 42,
        lines_removed: 5,
        files_changed: 3,
        opened_at: "2026-06-10T12:00:00.000Z",
        observed_at: "2026-06-10T12:00:00.000Z",
      },
    ],
  });
}

function sourceWithSequentialHistory() {
  return makeSource({
    links: [link({ branch_name: "feature/ISS-4473-x", session_id: "s1" })],
    prs: [
      {
        repo_full_name: "acme/web",
        branch_name: "feature/ISS-4473-x",
        pr_number: 41,
        state: "closed",
        opened_at: "2026-06-08T12:00:00.000Z",
        closed_at: "2026-06-09T12:00:00.000Z",
        observed_at: "2026-06-09T12:00:00.000Z",
      },
      {
        repo_full_name: "acme/web",
        branch_name: "feature/ISS-4473-x",
        pr_number: 42,
        state: "closed",
        opened_at: "2026-06-10T12:00:00.000Z",
        closed_at: "2026-06-11T12:00:00.000Z",
        observed_at: "2026-06-11T12:00:00.000Z",
      },
    ],
    lifecycleEvents: [
      lifecycleEvent({
        link_id: "push-before-prior-terminal",
        branch_name: "feature/ISS-4473-x",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        target_kind: ArtifactRefTargetKind.Branch,
        observed_at: "2026-06-09T11:00:00.000Z",
      }),
      lifecycleEvent({
        link_id: "push-in-selected-cycle",
        branch_name: "feature/ISS-4473-x",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        target_kind: ArtifactRefTargetKind.Branch,
        observed_at: "2026-06-10T10:00:00.000Z",
      }),
    ],
  });
}
