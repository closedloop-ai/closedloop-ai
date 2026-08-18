import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BranchStatus } from "@repo/api/src/types/branch.js";
import { GitHubPRState } from "@repo/api/src/types/github.js";
import { getSharedBranches } from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

// PR-lifecycle-state → branch-status projection cases, extracted from
// shared-branches-api.test.ts (a shrink-only grandfathered file) so these
// cohesive lifecycle assertions live in a focused sibling module (AGENTS.md
// file-size discipline). They exercise the same `getSharedBranches` list
// projection over `derivePrState` / `deriveStatus`.
describe("getSharedBranches PR-lifecycle → status projection", () => {
  test("merged PR → MERGED state maps to Merged status", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/done" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/done",
          pr_number: 7,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.prState, GitHubPRState.Merged);
    assert.equal(row.status, BranchStatus.Merged);
  });

  test("closed-unmerged PR (state=closed, merged_at=null) → Closed, NOT Merged (FEA-4289)", async () => {
    // A PR closed WITHOUT being merged is a distinct terminal state — it must
    // never be conflated with merged/done. The one signal separating the two is
    // `merged_at`: a closed-unmerged PR carries a `closed_at` but no `merged_at`.
    // Guards against a regression that keys off `state === "closed"` alone.
    const source = makeSource({
      links: [link({ branch_name: "feature/abandoned" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/abandoned",
          pr_number: 8,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: null,
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.prState, GitHubPRState.Closed);
    assert.equal(row.status, BranchStatus.Closed);
    assert.notEqual(row.status, BranchStatus.Merged);
  });

  test("literal merged state without merged_at is unavailable, not selected", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/m" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/m",
          pr_number: 9,
          pr_url: null,
          title: null,
          state: "merged",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.prNumber, null);
    assert.equal(row.prState, null);
    assert.equal(row.status, BranchStatus.Draft);
  });

  test("null PR state is unavailable, never fabricated as OPEN", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/n" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/n",
          pr_number: 11,
          pr_url: null,
          title: null,
          state: null,
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.prNumber, null);
    assert.equal(row.prState, null);
    assert.equal(row.status, BranchStatus.Draft);
  });

  test("unrecognized PR state is indeterminate → null prState (no fabrication)", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/u" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/u",
          pr_number: 12,
          pr_url: null,
          title: null,
          state: "draft-ish-garbage",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.prState, null);
    assert.equal(row.prNumber, null);
    assert.equal(row.status, BranchStatus.Draft);
  });
});
