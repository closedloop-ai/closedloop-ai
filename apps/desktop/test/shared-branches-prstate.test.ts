import assert from "node:assert/strict";
import { BranchStatus } from "@repo/api/src/types/branch.js";
import { describe, test } from "vitest";
import { getSharedBranches } from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

// PR-lifecycle-state → branch-status projection cases, extracted from
// shared-branches-api.test.ts (a shrink-only grandfathered file) so these
// cohesive lifecycle assertions live in a focused sibling module (AGENTS.md
// file-size discipline). They exercise the same `getSharedBranches` list
// projection over `derivePrState` / `deriveStatus`.
// Desktop stores no GitHub lifecycle (operator ruling, ISS-12709): a PR the
// transcript named stays visible by number, `prState` is null and never
// fabricated as OPEN, and the branch status reads as Open (ISS-9664: the shared
// derivation both surfaces call treats an unobserved PR as no PR evidence).
describe("getSharedBranches PR-lifecycle → status projection", () => {
  test("a PR with no stored lifecycle stays visible, unobserved, never fabricated as OPEN", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/n" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/n",
          pr_number: 11,
          pr_url: null,
          title: null,
          closed_at: null,
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.prNumber, 11);
    assert.equal(row.prState, null);
    assert.equal(row.status, BranchStatus.Open);
  });
});
