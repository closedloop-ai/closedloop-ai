import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BranchCloudHydrationStatus,
  BranchStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks.js";
import { GitHubPRState } from "@repo/api/src/types/github.js";
import { getSharedBranchDetail } from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

test("detail identity stays aligned with its persisted associated-PR collection", async () => {
  const source = makeSource({
    links: [link({ branch_name: "feature/x", session_id: "s1" })],
    prs: [
      {
        repo_full_name: "acme/web",
        branch_name: "feature/x",
        pr_number: 42,
        pr_url: "https://github.com/acme/web/pull/42",
        title: "Persisted title",
        state: "open",
        observed_at: "2026-06-10T12:00:00.000Z",
      },
    ],
  });
  const id = encodeBranchId({
    repoFullName: "acme/web",
    branchName: "feature/x",
  });

  const detail = await getSharedBranchDetail(source, id, {
    hydrate: async () => ({
      status: BranchCloudHydrationStatus.Fresh,
      overlays: {
        "acme/web::feature/x": {
          status: BranchStatus.Merged,
          prNumber: 77,
          prTitle: "Cloud title",
          prState: GitHubPRState.Merged,
          prUrl: "https://github.com/acme/web/pull/77",
          reviewDecision: ReviewDecision.Approved,
          checksStatus: ChecksStatus.Passing,
        },
      },
    }),
  });

  assert.equal(detail?.prNumber, 42);
  assert.equal(detail?.prTitle, "Persisted title");
  assert.equal(detail?.prState, GitHubPRState.Open);
  assert.equal(detail?.status, BranchStatus.Open);
  assert.equal(detail?.reviewDecision, null);
  assert.equal(detail?.checksStatus, ChecksStatus.Passing);
  assert.equal(detail?.associatedPullRequests?.selectedId, "acme/web#42");
  assert.deepEqual(
    detail?.associatedPullRequests?.items.map(({ number }) => number),
    [42]
  );
});
