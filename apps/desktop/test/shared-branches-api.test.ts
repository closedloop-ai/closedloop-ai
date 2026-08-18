import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BranchCloudHydrationStatus,
  BranchStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks.js";
import { BranchMetricAvailability as MetricAvailability } from "@repo/api/src/types/branch-metrics.js";
import { GitHubPRState } from "@repo/api/src/types/github.js";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import {
  type BranchCloudHydrationSource,
  type BranchSyncSource,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import {
  ensureOrgDirectory,
  resetOrgDirectoryCacheForTest,
} from "../src/main/session/org-directory-cache.js";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesPageDataResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";

import {
  type CannedRows,
  canonicalActivity,
  commit,
  eventFromToken,
  KIND_BRANCH_RE,
  link,
  makeSource,
  rawQueryClientOf,
  SQL_SECRET,
  throwingSource,
} from "./shared-branches-test-helpers.js";

describe("getSharedBranches (B1 list projection)", () => {
  test("missing source → empty canonical response, no read", async () => {
    assert.deepEqual(
      await getSharedBranches(null),
      emptySharedBranchesListResponse()
    );
  });

  test("cloud-only filter → empty response without touching the source", async () => {
    let queried = false;
    const source = makeSource({}, () => {
      queried = true;
    });
    assert.deepEqual(
      await getSharedBranches(source, { userId: "u1" }),
      emptySharedBranchesListResponse()
    );
    assert.deepEqual(
      await getSharedBranches(source, { contributorUserId: "u1" }),
      emptySharedBranchesListResponse()
    );
    assert.equal(queried, false);
  });

  test("single linked PR → prState/status set, multiPrWarning false", async () => {
    const source = makeSource({
      links: [link({})],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: "https://gh/acme/web/pull/42",
          title: "Add X",
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T11:00:00.000Z",
        },
      ],
    });
    const { items, total, viewerScope } = await getSharedBranches(source);
    assert.equal(total, 1);
    assert.equal(viewerScope, "self");
    const [row] = items;
    assert.equal(
      row.id,
      encodeBranchId({ repoFullName: "acme/web", branchName: "feature/x" })
    );
    assert.equal(row.prNumber, 42);
    assert.equal(row.prState, "OPEN");
    assert.equal(row.status, BranchStatus.Open);
    assert.equal(row.multiPrWarning, false);
    assert.deepEqual(row.sessionIds, ["s1"]);
  });

  test("session end and link scan do not fabricate canonical Last active", async () => {
    const source = makeSource({
      links: [
        link({
          observed_at: "2026-06-19T09:00:00.000Z",
          activity_at: "2026-05-15T12:00:00.000Z",
        }),
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "");
    assert.equal(
      row.canonicalLastActiveAt?.state,
      MetricAvailability.Unavailable
    );
  });

  test("local rows do not fabricate canonical Owner from Session ownership", async () => {
    resetOrgDirectoryCacheForTest();
    const okUsers = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "u1",
                email: "ada@example.com",
                firstName: "Ada",
                lastName: "Lovelace",
                avatarUrl: null,
              },
            ],
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch;
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api.test",
        getApiKey: () => "sk_live_test",
        fetchImpl: okUsers,
      },
      1000
    );
    const source = makeSource({ links: [link({ user_id: "u1" })] });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.ownerIdentity?.availability, row.owner ?? "unavailable");
    resetOrgDirectoryCacheForTest();
  });

  test("owner is null (unattributed) when no org-directory match", async () => {
    resetOrgDirectoryCacheForTest();
    const source = makeSource({ links: [link({ user_id: "ghost" })] });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.owner, null);
  });

  test("duplicate local links cannot manufacture canonical Owner", async () => {
    // `u1` owns ONE session but two link rows on the branch; `u2` owns TWO
    // distinct sessions. Per-session attribution → `u2` (2) beats `u1` (1);
    // folding per-link would wrongly tie or hand it to `u1`.
    resetOrgDirectoryCacheForTest();
    const okUsers = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "u1",
                email: "ada@example.com",
                firstName: "Ada",
                lastName: "Lovelace",
                avatarUrl: null,
              },
              {
                id: "u2",
                email: "bob@example.com",
                firstName: "Bob",
                lastName: "Kahn",
                avatarUrl: null,
              },
            ],
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch;
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api.test",
        getApiKey: () => "sk_live_test",
        fetchImpl: okUsers,
      },
      1000
    );
    const source = makeSource({
      links: [
        link({ session_id: "s-u1", user_id: "u1" }),
        // Duplicate link row for the SAME session — must not double-count u1.
        link({ session_id: "s-u1", user_id: "u1", is_primary: false }),
        link({ session_id: "s-u2a", user_id: "u2" }),
        link({ session_id: "s-u2b", user_id: "u2" }),
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.ownerIdentity?.availability, row.owner ?? "unavailable");
    resetOrgDirectoryCacheForTest();
  });

  test("later generic Session activity stays excluded without monitored evidence", async () => {
    const source = makeSource({
      links: [
        link({
          session_id: "s-old",
          observed_at: "2026-06-19T09:00:00.000Z",
          activity_at: "2026-06-01T08:00:00.000Z",
        }),
        link({
          session_id: "s-new",
          observed_at: "2026-06-18T09:00:00.000Z",
          activity_at: "2026-06-02T05:30:00-04:00", // = 2026-06-02T09:30Z
        }),
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "");
    assert.equal(
      row.canonicalLastActiveAt?.state,
      MetricAvailability.Unavailable
    );
    assert.deepEqual([...row.sessionIds].sort(), ["s-new", "s-old"]);
  });

  test("lastActivityAt is the latest commit time, not a newer session (PRD-486)", async () => {
    // A session ran AFTER the last commit; the branch must age by the COMMIT,
    // not the session — session activity alone never bumps a branch (the
    // PLN-1034 principle, now realized locally via event-time commit capture).
    const source = makeSource({
      links: [link({ activity_at: "2026-06-10T10:00:00.000Z" })],
      commits: [commit({ committed_at: "2026-06-08T08:00:00.000Z" })],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "2026-06-08T08:00:00.000Z");
  });

  test("lastActivityAt takes the latest of commit + PR lifecycle (PRD-486)", async () => {
    const source = makeSource({
      links: [link({ activity_at: "2026-06-10T10:00:00.000Z" })],
      commits: [commit({ committed_at: "2026-06-08T08:00:00.000Z" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 5,
          pr_url: null,
          title: null,
          state: "merged",
          merged_at: "2026-06-14T09:00:00.000Z",
          closed_at: "2026-06-14T09:00:00.000Z",
          opened_at: "2026-06-07T07:00:00.000Z",
          observed_at: "2026-06-14T09:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "2026-06-14T09:00:00.000Z");
  });

  test("lastActivityAt stays unavailable with only generic Session activity", async () => {
    const source = makeSource({
      links: [link({ activity_at: "2026-05-15T12:00:00.000Z" })],
      commits: [],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "");
    assert.equal(
      row.canonicalLastActiveAt?.state,
      MetricAvailability.Unavailable
    );
  });

  // PR-lifecycle → status projection cases (merged / closed-unmerged / literal
  // merged / null-state / unrecognized) live in the focused sibling module
  // shared-branches-prstate.test.ts (AGENTS.md file-size discipline; this file
  // is a shrink-only grandfathered file).

  test("raw branch reads constrain artifacts.kind = 'branch' (no non-branch inflation)", async () => {
    // The typed reads (link/distinct/usage) carry the kind='branch' constraint
    // as a Prisma `where` filter, proven behaviorally in branch-reads-contract;
    // this guards the remaining RAW reads (commit/PR/token-aggregate), whose SQL
    // scopes through `session_artifact_links → artifacts(kind='branch')`.
    const sqls: string[] = [];
    const source = makeSource({ links: [link({})] }, (sql) => sqls.push(sql));
    await getSharedBranches(source);
    const linkSqls = sqls.filter((sql) =>
      sql.includes("session_artifact_links")
    );
    assert.ok(
      linkSqls.length > 0,
      "expected raw reads scoped through session_artifact_links"
    );
    for (const sql of linkSqls) {
      assert.match(sql, KIND_BRANCH_RE);
    }
  });

  test(">1 active linked PR → warning true and no fabricated selection", async () => {
    const source = makeSource({
      links: [link({})],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T12:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 43,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T11:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.multiPrWarning, true);
    assert.equal(row.prNumber, null);
  });

  test("cloud hydration overlays GitHub fields into shared list rows", async () => {
    const source = makeSource({
      links: [link({})],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: "https://github.com/acme/web/pull/42",
          title: "Local title",
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T12:00:00.000Z",
        },
      ],
    });

    const [row] = (
      await getSharedBranches(
        source,
        {},
        {
          hydrate: async () => ({
            status: BranchCloudHydrationStatus.Fresh,
            overlays: {
              "acme/web::feature/x": {
                status: BranchStatus.Merged,
                prNumber: 77,
                prTitle: "Cloud title",
                prState: GitHubPRState.Merged,
                prUrl: "https://github.com/acme/web/pull/77",
                checksStatus: ChecksStatus.Passing,
                reviewDecision: ReviewDecision.Approved,
              },
            },
          }),
        }
      )
    ).items;

    assert.equal(row.checksStatus, ChecksStatus.Passing);
    assert.equal(row.reviewDecision, ReviewDecision.Approved);
    assert.equal(row.status, BranchStatus.Merged);
    assert.equal(row.prNumber, 77);
    assert.equal(row.prTitle, "Cloud title");
    assert.equal(row.prState, GitHubPRState.Merged);
    assert.equal(row.prUrl, "https://github.com/acme/web/pull/77");
    assert.equal(row.cloudHydrationStatus, BranchCloudHydrationStatus.Fresh);
  });

  test("no PR + no enrichment → Draft, every enrichment field null (never 0)", async () => {
    const source = makeSource({
      links: [
        link({
          repo_full_name: null,
          branch_name: "local-wip",
          is_primary: false,
        }),
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.status, BranchStatus.Draft);
    assert.equal(row.prState, null);
    assert.equal(row.repoFullName, null);
    assert.equal(row.owner, null);
    for (const field of [
      row.baseBranch,
      row.checksStatus,
      row.checksPassed,
      row.checksTotal,
      row.reviewDecision,
      row.ahead,
      row.behind,
      row.additions,
      row.deletions,
      row.filesChanged,
    ]) {
      assert.equal(field, null);
    }
  });

  test("estimatedCostUsd sums the captured per-branch cost; null when no priced rows", async () => {
    const withTokens = makeSource({
      links: [link({})],
      tokenAgg: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          // Captured cost mirrors stored values, not derived token counts.
          raw_cost_usd_estimated: 1.23,
          cost_usd_estimated: 1.23,
        },
      ],
    });
    const [row] = (await getSharedBranches(withTokens)).items;
    assert.equal(row.estimatedCostUsd, 1.23);

    // A branch whose token rows were never priced surfaces null, not $0.
    const noTokens = makeSource({
      links: [link({ branch_name: "feature/y" })],
    });
    const [yRow] = (await getSharedBranches(noTokens)).items;
    assert.equal(yRow.estimatedCostUsd, null);
  });

  test("O(grouped): issues exactly 6 set-based reads regardless of branch count", async () => {
    let count = 0;
    const source = makeSource(
      {
        links: [
          link({ branch_name: "a", session_id: "s1" }),
          link({ branch_name: "b", session_id: "s2" }),
        ],
      },
      () => {
        count += 1;
      }
    );
    const { items } = await getSharedBranches(source);
    assert.equal(items.length, 2);
    // Links + PRs + commits + canonical activity + token aggregate + divisor.
    assert.equal(count, 6);
  });

  test("a read failure rethrows a sanitized, code-only error (no SQL leak)", async () => {
    await assert.rejects(getSharedBranches(throwingSource), (err: Error) => {
      assert.equal(err.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
      assert.doesNotMatch(err.message, SQL_SECRET);
      return true;
    });
  });

  test("ids filter returns only requested branches (deduped/sanitized); total = matched", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "a", session_id: "s1" }),
        link({ branch_name: "b", session_id: "s2" }),
        link({ branch_name: "c", session_id: "s3" }),
      ],
    });
    const idA = encodeBranchId({ repoFullName: "acme/web", branchName: "a" });
    const idC = encodeBranchId({ repoFullName: "acme/web", branchName: "c" });
    const { items, total } = await getSharedBranches(source, {
      // Duplicate + empty entries are sanitized away.
      ids: [idA, idC, idA, ""],
    });
    assert.equal(total, 2);
    assert.deepEqual(
      [...items.map((item) => item.id)].sort(),
      [idA, idC].sort()
    );
  });

  test("empty/garbage-only ids → full list (no accidental narrowing)", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "a", session_id: "s1" }),
        link({ branch_name: "b", session_id: "s2" }),
      ],
    });
    assert.equal((await getSharedBranches(source, { ids: [] })).total, 2);
    assert.equal((await getSharedBranches(source, { ids: [""] })).total, 2);
  });

  test("limit/offset page the output; total stays the full matched count", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "a",
          session_id: "s1",
          observed_at: "2026-06-10T10:00:00.000Z",
        }),
        link({
          branch_name: "b",
          session_id: "s2",
          observed_at: "2026-06-09T10:00:00.000Z",
        }),
        link({
          branch_name: "c",
          session_id: "s3",
          observed_at: "2026-06-08T10:00:00.000Z",
        }),
      ],
    });
    const page = await getSharedBranches(source, { limit: 1, offset: 1 });
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 1);
    // All three are unavailable, so encoded Branch identity breaks the tie.
    assert.equal(page.items[0]?.branchName, "b");
  });

  test("negative offset/limit clamp to zero rather than throwing", async () => {
    const source = makeSource({ links: [link({ branch_name: "a" })] });
    const page = await getSharedBranches(source, { limit: -5, offset: -3 });
    assert.equal(page.total, 1);
    assert.equal(page.items.length, 0);
  });

  test("enriched branch surfaces net LOC as additions/deletions/filesChanged (FEA-1899)", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "enriched",
          lines_added: 120,
          lines_removed: 30,
          files_changed: 4,
        }),
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.additions, 120);
    assert.equal(row.deletions, 30);
    assert.equal(row.filesChanged, 4);
  });

  test("branch LOC is collapsed once across a branch's sessions (not summed)", async () => {
    // The LOC lives on the one branch artifact, so every link row repeats the
    // same value — the projection must not double-count it across sessions.
    const source = makeSource({
      links: [
        link({
          branch_name: "multi-sess",
          session_id: "s1",
          lines_added: 80,
          lines_removed: 10,
          files_changed: 3,
        }),
        link({
          branch_name: "multi-sess",
          session_id: "s2",
          lines_added: 80,
          lines_removed: 10,
          files_changed: 3,
        }),
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.additions, 80);
    assert.equal(row.deletions, 10);
    assert.equal(row.filesChanged, 3);
    assert.deepEqual([...row.sessionIds].sort(), ["s1", "s2"]);
  });
});

describe("getSharedBranchUsage (B1 usage rollup)", () => {
  test("missing source / cloud filter → empty canonical summary", async () => {
    assert.deepEqual(
      await getSharedBranchUsage(null),
      emptySharedBranchesUsageSummary()
    );
    assert.deepEqual(
      await getSharedBranchUsage(makeSource({}), { teamId: "t1" }),
      emptySharedBranchesUsageSummary()
    );
  });

  test("rolls up totals + single unattributed actor; phaseStacks empty", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "a", session_id: "s1" }),
        link({ branch_name: "b", session_id: "s2" }),
      ],
      usageTokens: [
        {
          session_id: "s1",
          model: "unknown-model",
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-10T10:00:00.000Z",
        },
      ],
    });
    const summary = await getSharedBranchUsage(source);
    assert.equal(summary.viewerScope, "self");
    assert.equal(summary.totalBranches, 2);
    assert.equal(summary.totalInputTokens, 10);
    assert.equal(summary.totalOutputTokens, 20);
    assert.deepEqual(summary.phaseStacks, []);
    assert.equal(summary.subscriptionEstimatedCost, 0);
    assert.equal(summary.apiEstimatedCost, 0);
    assert.equal(summary.byActor.length, 1);
    assert.equal(summary.byActor[0]?.owner, null);
    assert.equal(summary.byActor[0]?.inputTokens, 10);
  });

  // FEA-4280 out-of-range token degradation cases live in the focused sibling
  // `shared-branches-usage-degrade.test.ts` (kept out of this grandfathered file).

  test("billing split uses the canonical ledger — real modes no longer dropped", async () => {
    const source = makeSource({
      // billing_mode is a per-session column, so it rides the link row (the
      // usage read resolves it through the session relation, then joins it to
      // the token rows by session id).
      links: [
        // "pro" → subscription ledger (was dropped to null by the old 2-value
        // normalizer → counted as neither bucket).
        link({ branch_name: "a", session_id: "s-sub", billing_mode: "pro" }),
        // "cursor_api" → metered ledger → api bucket (also previously dropped).
        link({
          branch_name: "b",
          session_id: "s-api",
          billing_mode: "cursor_api",
        }),
      ],
      usageTokens: [
        {
          session_id: "s-sub",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: "2026-06-10T10:00:00.000Z",
          // Captured cost — the billing split sums stored cost per bucket.
          cost_usd_estimated: 0.05,
        },
        {
          session_id: "s-api",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: "2026-06-10T11:00:00.000Z",
          cost_usd_estimated: 0.05,
        },
      ],
    });
    const summary = await getSharedBranchUsage(source);
    assert.ok(
      summary.subscriptionEstimatedCost > 0,
      "'pro' counts toward the subscription bucket"
    );
    assert.ok(
      summary.apiEstimatedCost > 0,
      "'cursor_api' counts toward the api bucket"
    );
  });

  test("windows AI spend by each EVENT's created_at, splitting a long session across windows (FEA-4270)", async () => {
    // ONE branch, active in-window, with ONE long-running session `s-split` that
    // STARTED before the window but has usage EVENTS both inside AND outside it.
    // A windowed AI-spend read must count ONLY the in-window events — not the
    // session's whole lifetime spend, and not the pre-window turn — so a session's
    // cost splits across windows by turn. This matches the cloud per-event
    // producer so the shared Branches card reports the same windowed spend on both
    // adapters (shafty023 P1 rework of chatgpt-codex #3667842014). All-time uses
    // the aggregate token_usage totals so nothing regresses for legacy sessions.
    const source = makeSource({
      links: [
        link({
          branch_name: "active",
          session_id: "s-split",
          activity_at: "2026-06-20T10:00:00.000Z",
        }),
      ],
      // Aggregate lifetime totals — used ONLY by the all-time (no-window) path.
      usageTokens: [
        {
          session_id: "s-split",
          model: "unknown-model",
          input_tokens: 110,
          output_tokens: 55,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-20T10:00:00.000Z",
          cost_usd_estimated: 11,
        },
      ],
      // Per-event rows (token_events) — used by the WINDOWED path. Two in-window
      // events (10 in-tokens total, $1) and one pre-window event (100 in-tokens,
      // $10) that must be excluded under the window.
      usageEvents: [
        {
          session_id: "s-split",
          model: "unknown-model",
          input_tokens: 6,
          output_tokens: 3,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-20T10:00:00.000Z",
          session_started_at: "2026-06-10T09:00:00.000Z",
          cost_usd_estimated: 0.5,
        },
        {
          session_id: "s-split",
          model: "unknown-model",
          input_tokens: 4,
          output_tokens: 2,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-21T10:00:00.000Z",
          session_started_at: "2026-06-10T09:00:00.000Z",
          cost_usd_estimated: 0.5,
        },
        {
          session_id: "s-split",
          model: "unknown-model",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          // Pre-window turn — must be excluded under the window.
          created_at: "2026-06-10T10:00:00.000Z",
          session_started_at: "2026-06-10T09:00:00.000Z",
          cost_usd_estimated: 10,
        },
      ],
    });
    // All-time: the aggregate lifetime totals (110 input tokens, $11), one branch.
    const all = await getSharedBranchUsage(source);
    assert.equal(all.totalBranches, 1);
    assert.equal(all.totalInputTokens, 110);
    assert.equal(all.totalEstimatedCost, 11);
    // Windowed [06-17, 06-30]: the branch still qualifies, and only the two
    // in-window EVENTS count — 6 + 4 = 10 input tokens, $0.50 + $0.50 = $1 — while
    // the pre-window $10 turn (06-10) and the $11 lifetime aggregate are excluded.
    const windowed = await getSharedBranchUsage(source, {
      startDate: "2026-06-17T00:00:00.000Z",
      endDate: "2026-06-30T00:00:00.000Z",
    });
    assert.equal(windowed.totalBranches, 1);
    assert.equal(windowed.totalInputTokens, 10);
    assert.equal(windowed.totalOutputTokens, 5);
    assert.equal(windowed.totalEstimatedCost, 1);
  });

  test("excludes a token_event with a NULL created_at under an active window (FEA-4270)", async () => {
    // A per-event row whose `created_at` is null cannot be placed in a bounded
    // window, so a date-bounded spend read drops it (matching the cloud
    // `tokenEventInDateWindow` null-exclusion) — the windowed total stays equal to
    // the sum of the events actually shown.
    const source = makeSource({
      links: [
        link({
          branch_name: "active",
          session_id: "s-null",
          activity_at: "2026-06-20T10:00:00.000Z",
        }),
      ],
      usageEvents: [
        {
          session_id: "s-null",
          model: "unknown-model",
          input_tokens: 3,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-20T10:00:00.000Z",
          session_started_at: "2026-06-20T09:00:00.000Z",
          cost_usd_estimated: 1,
        },
        {
          session_id: "s-null",
          model: "unknown-model",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          // Null event time → excluded under a window.
          created_at: null,
          session_started_at: "2026-06-20T09:00:00.000Z",
          cost_usd_estimated: 8,
        },
      ],
    });
    const windowed = await getSharedBranchUsage(source, {
      startDate: "2026-06-17T00:00:00.000Z",
      endDate: "2026-06-30T00:00:00.000Z",
    });
    // Only the one dated in-window event — the null-timestamp $8 turn is dropped.
    assert.equal(windowed.totalInputTokens, 3);
    assert.equal(windowed.totalEstimatedCost, 1);
  });

  test("windows on the COMMIT-inclusive lastActivityAt, like the table (PRD-486 / FEA-2155)", async () => {
    // The branch's SESSION activity (06-10) is OUTSIDE a window starting 06-18,
    // but its latest COMMIT (06-20) is inside — and PRD-486 makes the commit the
    // primary last-active signal, so the table (getSharedBranches) shows it. The
    // rollup must window on the SAME commit-inclusive timestamp: dropping commits
    // would wrongly exclude the branch and undercount totals vs. the table.
    const source = makeSource({
      links: [
        link({
          branch_name: "commit-recent",
          session_id: "s1",
          activity_at: "2026-06-10T10:00:00.000Z",
        }),
      ],
      commits: [
        commit({
          branch_name: "commit-recent",
          committed_at: "2026-06-20T08:00:00.000Z",
        }),
      ],
      usageTokens: [
        {
          session_id: "s1",
          model: "unknown-model",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-20T10:00:00.000Z",
        },
      ],
      // The session's spend EVENT is in-window (06-20), so per-event windowing
      // counts it once the commit places the branch in the window.
      usageEvents: [eventFromToken("s1", "2026-06-20T10:00:00.000Z", 10, 5)],
    });
    const windowed = await getSharedBranchUsage(source, {
      startDate: "2026-06-18T00:00:00.000Z",
    });
    // Commit 06-20 places the branch in-window → counted, its tokens included.
    assert.equal(windowed.totalBranches, 1);
    assert.equal(windowed.totalInputTokens, 10);
  });

  test("hour buckets come from token_events (per-event time), not the aggregate", async () => {
    const source = makeSource({
      links: [link({ branch_name: "a", session_id: "s1" })],
      // One aggregate row — its single created_at would collapse to one hour.
      usageTokens: [
        {
          session_id: "s1",
          model: "unknown-model",
          input_tokens: 30,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-10T10:30:00.000Z",
        },
      ],
      // Per-event rows span two distinct hours.
      usageEvents: [
        {
          session_id: "s1",
          model: "unknown-model",
          input_tokens: 10,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-10T10:15:00.000Z",
        },
        {
          session_id: "s1",
          model: "unknown-model",
          input_tokens: 20,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-10T12:45:00.000Z",
        },
      ],
    });
    const summary = await getSharedBranchUsage(source);
    // Two event hours → two buckets (the aggregate alone would yield one).
    assert.deepEqual(
      summary.hourBuckets.map((bucket) => bucket.hourStart),
      ["2026-06-10T10:00:00.000Z", "2026-06-10T12:00:00.000Z"]
    );
    // Totals still come from the complete aggregate, not the events.
    assert.equal(summary.totalInputTokens, 30);
  });

  test("hour buckets price each event with its cache-write TTL split", async () => {
    const timestamp = "2026-06-10T10:15:00.000Z";
    const events = [
      {
        session_id: "s1",
        model: "claude-opus-4-5",
        input_tokens: 150_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 1000,
        cache_write_5m_tokens: 600,
        cache_write_1h_tokens: 400,
        billing_mode: "api",
        created_at: timestamp,
      },
      {
        session_id: "s1",
        model: "claude-opus-4-5",
        input_tokens: 150_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 500,
        cache_write_5m_tokens: 300,
        cache_write_1h_tokens: 200,
        billing_mode: "api",
        created_at: timestamp,
      },
    ];
    const source = makeSource({
      links: [link({ branch_name: "a", session_id: "s1" })],
      usageTokens: [],
      usageEvents: events,
    });

    const summary = await getSharedBranchUsage(source);
    const expected = events.reduce((sum, event) => {
      const estimate = estimateTokenCost({
        model: event.model,
        inputTokens: event.input_tokens,
        outputTokens: event.output_tokens,
        cacheReadTokens: event.cache_read_tokens,
        cacheWriteTokens: event.cache_write_tokens,
        cacheWrite1hTokens: event.cache_write_1h_tokens,
        observedAt: event.created_at,
      });
      assert.ok(estimate);
      return sum + estimate.costUsd;
    }, 0);

    assert.equal(
      summary.hourBuckets[0]?.byActor[0]?.estimatedCostUsd,
      expected
    );
  });
});

describe("getSharedBranchAnalytics (B6)", () => {
  test("analytics returns the empty canonical response for a missing source", async () => {
    assert.deepEqual(
      await getSharedBranchAnalytics(null),
      emptySharedBranchesAnalytics()
    );
  });

  test("analytics computes merge rate and active/merged PR counts locally", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "merged-branch", session_id: "s1" }),
        link({ branch_name: "closed-branch", session_id: "s2" }),
        link({ branch_name: "open-branch", session_id: "s3" }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "merged-branch",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
        // Closed WITHOUT merging → a decided (terminal) outcome that counts
        // toward the denominator but not the numerator.
        {
          repo_full_name: "acme/web",
          branch_name: "closed-branch",
          pr_number: 2,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: null,
          closed_at: "2026-06-11T09:00:00.000Z",
          observed_at: "2026-06-11T09:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "open-branch",
          pr_number: 3,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T10:00:00.000Z",
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    // FEA-2942: merge rate is over DECIDED branches (merged + closed). The
    // still-open branch is excluded from the denominator, so 1 merged / 2
    // decided (merged + closed) = 50% (pre-fix: 1 / 3 with-a-PR = 33%).
    assert.equal(analytics.mergeRate.state, "available");
    assert.equal(analytics.mergeRate.value, 50);
    // Neither the branch artifact nor its PR artifact carries LOC, so the merged
    // single-PR branch is un-enriched. FEA-2949: the median EXCLUDES un-enriched
    // PRs (dashboard parity) rather than folding them in as 0, so with no enriched
    // merged branch the card is unavailable ("—"), not 0.
    assert.equal(analytics.medianPrSize.state, "unavailable");
    assert.equal(analytics.medianPrSize.value, null);
    // Active/merged PR counts are computed locally from the same captured
    // pr_state/branch-status rows the web producer uses (FEA-2950), so the shared
    // card shows a real number on desktop too rather than a connect-GitHub "—".
    // One OPEN PR (open-branch) and one merged branch (merged-branch).
    assert.equal(analytics.activePrCount.state, "available");
    assert.equal(analytics.activePrCount.value, 1);
    assert.equal(analytics.mergedCount.state, "available");
    assert.equal(analytics.mergedCount.value, 1);
  });

  test("merge rate excludes multi-PR branches (ambiguous lifecycle)", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "single-merged", session_id: "s1" }),
        link({ branch_name: "multi-open", session_id: "s2" }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "single-merged",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
        // Two distinct open PRs on one branch → multiPrWarning, excluded.
        {
          repo_full_name: "acme/web",
          branch_name: "multi-open",
          pr_number: 2,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T12:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "multi-open",
          pr_number: 3,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T11:00:00.000Z",
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    // Only `single-merged` counts: 1/1 = 100% (NOT 1/2 = 50% with the
    // multi-PR branch wrongly included in the denominator).
    assert.equal(analytics.mergeRate.state, "available");
    assert.equal(analytics.mergeRate.value, 100);
  });

  test("mergedCount shares the merge-rate numerator set — excludes MERGED multi-PR branches (FEA-2997)", async () => {
    // The "Merged PRs" count and the merge-rate numerator must be the SAME set,
    // or the two KPIs on one card visibly disagree. `single-merged` is a merged,
    // single-PR branch (in the numerator); `multi-merged` is genuinely merged but
    // carries two distinct linked PRs → multiPrWarning, so its lifecycle is
    // ambiguous and it is excluded from the rate numerator. Before FEA-2997,
    // `mergedCount` classified by branch status alone (no `!multiPrWarning`), so it
    // counted BOTH (mergedCount=2) while the numerator counted ONE — a "Merged PRs"
    // count that contradicts a 100% rate whose numerator is 1. `mergedCount` must
    // now equal the numerator (1).
    const source = makeSource({
      links: [
        link({ branch_name: "single-merged", session_id: "s1" }),
        link({ branch_name: "multi-merged", session_id: "s2" }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "single-merged",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
        // Two distinct MERGED PRs on one branch → multiPrWarning true. Merged
        // status, so multiPrWarning is the SOLE ground for excluding it.
        {
          repo_full_name: "acme/web",
          branch_name: "multi-merged",
          pr_number: 2,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-12T10:00:00.000Z",
          closed_at: "2026-06-12T10:00:00.000Z",
          observed_at: "2026-06-12T12:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "multi-merged",
          pr_number: 3,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-12T09:00:00.000Z",
          closed_at: "2026-06-12T09:00:00.000Z",
          observed_at: "2026-06-12T11:00:00.000Z",
        },
      ],
    });

    // Pin the premise: multi-merged is MERGED yet multiPrWarning, so the only
    // reason it leaves the merged set is its ambiguous lifecycle.
    const listItems = (await getSharedBranches(source)).items;
    const multi = listItems.find((item) => item.branchName === "multi-merged");
    assert.ok(multi, "multi-merged branch present in the projection");
    assert.equal(multi.status, BranchStatus.Merged);
    assert.equal(multi.multiPrWarning, true);

    const analytics = await getSharedBranchAnalytics(source);
    // Numerator = 1 (single-merged only); denominator = 1 decided single-PR
    // branch → 100%. `mergedCount` must match the numerator exactly: 1, not 2.
    assert.equal(analytics.mergeRate.state, "available");
    assert.equal(analytics.mergeRate.value, 100);
    assert.equal(analytics.mergedCount.state, "available");
    assert.equal(analytics.mergedCount.value, 1);
  });

  test("analytics prices spend from the deduped per-session usage read, never the per-branch aggregate", async () => {
    const sqls: string[] = [];
    const source = makeSource(
      {
        links: [link({})],
        usageTokens: [
          {
            session_id: "s1",
            model: "claude-sonnet-4-5",
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            created_at: null,
          },
        ],
      },
      (sql) => sqls.push(sql)
    );
    await getSharedBranchAnalytics(source);
    // Spend comes from readBranchUsageTokenRows (deduped per session) so a session
    // linked to several branches is counted once. The per-branch token AGGREGATE
    // (`GROUP BY l.repo_full_name`) — whose column-sum over-counted multi-branch
    // sessions — must NOT be read by analytics anymore.
    assert.ok(
      sqls.includes("usageTokens"),
      "expected the deduped per-session usage read"
    );
    assert.ok(
      !sqls.some((sql) => sql.includes("GROUP BY l.repo_full_name")),
      "analytics must NOT read the per-branch token aggregate"
    );
  });

  test("analytics queries session_artifact_links once (reuses link-read ids for the usage read)", async () => {
    // The usage-token read reuses the session ids already collected by the link
    // read instead of re-querying session_artifact_links for them, so the link
    // table is hit exactly once — not twice (the redundant round-trip).
    const sqls: string[] = [];
    const source = makeSource(
      {
        links: [link({})],
        usageTokens: [
          {
            session_id: "s1",
            model: "claude-sonnet-4-5",
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            created_at: null,
            cost_usd_estimated: 0.42,
          },
        ],
      },
      (sql) => sqls.push(sql)
    );
    const analytics = await getSharedBranchAnalytics(source);
    assert.equal(
      sqls.filter((sql) => sql === "links").length,
      1,
      "expected a single session_artifact_links query, not a redundant re-read"
    );
    // The token rows are still fetched through the session-scoped read.
    assert.ok(sqls.includes("usageTokens"));
    assert.equal(analytics.totalSpendUsd.value, 0.42);
  });

  test("enriched LOC powers median PR size and LOC-per-$", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "big-merge",
          session_id: "s1",
          lines_added: 200,
          lines_removed: 50,
          files_changed: 5,
        }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "big-merge",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
      // Denominator now comes from the DEDUPED per-session usage read (keyed by
      // the enriched branch's session), summing the row's CAPTURED cost.
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.5,
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    // Merged single-PR branch with both LOC fields → median (200 + 50) = 250.
    assert.equal(analytics.medianPrSize.state, "available");
    assert.equal(analytics.medianPrSize.value, 250);
    // Churn (200 + 50 = 250) over captured cost ($0.50) → 500. Deletions ADD to
    // the numerator (gross churn); netting them out would report 150/0.5 = 300.
    assert.equal(analytics.locPerDollar.state, "available");
    assert.equal(analytics.locPerDollar.value, 500);
  });

  // ISS-4632 — the ratio numerator (branch churn) is the branch's LIFETIME
  // file-cache diff, so its denominator must be LIFETIME spend too. Under an
  // active window `totalSpendUsd` is windowed (FEA-4270), but Value-per-$ must
  // divide by the session's LIFETIME cost — otherwise narrowing the window
  // shrinks only the denominator and inflates the ratio.
  test("LOC-per-$ divides lifetime churn by lifetime spend under a window (ISS-4632)", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "big-merge",
          session_id: "s1",
          lines_added: 200,
          lines_removed: 50,
          files_changed: 5,
          activity_at: "2026-06-20T10:00:00.000Z",
        }),
      ],
      // Lifetime aggregate: the session's whole $1.00 cost.
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: "2026-06-20T10:00:00.000Z",
          cost_usd_estimated: 1,
        },
      ],
      // Per-event rows: only $0.25 falls inside the window; the $0.75 turn is
      // pre-window and excluded from the WINDOWED AI-spend headline.
      usageEvents: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 250,
          output_tokens: 125,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-20T10:00:00.000Z",
          session_started_at: "2026-06-10T09:00:00.000Z",
          cost_usd_estimated: 0.25,
        },
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 750,
          output_tokens: 375,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          // Pre-window turn — excluded under the window.
          created_at: "2026-06-10T10:00:00.000Z",
          session_started_at: "2026-06-10T09:00:00.000Z",
          cost_usd_estimated: 0.75,
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source, {
      startDate: "2026-06-17T00:00:00.000Z",
      endDate: "2026-06-30T00:00:00.000Z",
    });
    // Windowed AI-spend headline: only the in-window $0.25.
    assert.equal(analytics.totalSpendUsd.state, "available");
    assert.equal(analytics.totalSpendUsd.value, 0.25);
    // Churn 250 ÷ LIFETIME $1.00 = 250 — NOT 250 / $0.25 = 1000 (the inflated
    // windowed-denominator ratio this fix removes). Window-stable.
    assert.equal(analytics.locPerDollar.state, "available");
    assert.equal(analytics.locPerDollar.value, 250);
  });

  test("median PR size falls back to the merged PR artifact's LOC when the branch artifact is un-enriched (FEA-2159)", async () => {
    // The real-world bug: the branch artifact carries NO LOC (link has no
    // lines_added/lines_removed) while its merged PR artifact IS enriched — the
    // same enriched source the delivery dashboard medians. `readLocalBranchPrRows`
    // joins that PR-artifact LOC onto the PR row, and the list projection adopts
    // it, so the card reports a real size instead of reading null off the branch.
    const source = makeSource({
      links: [link({ branch_name: "pr-enriched", session_id: "s1" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "pr-enriched",
          pr_number: 7,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
          // LOC from the joined `kind='pull_request'` artifact (FEA-2159).
          lines_added: 600,
          lines_removed: 22,
          files_changed: 9,
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    // Median (600 + 22) = 622 from the PR artifact, even though the branch
    // artifact's own LOC is null.
    assert.equal(analytics.medianPrSize.state, "available");
    assert.equal(analytics.medianPrSize.value, 622);
  });

  test("analytics uses cloud-hydrated PR LOC when local desktop LOC is missing", async () => {
    const source = makeSource({
      links: [link({ branch_name: "prod-hydrated", session_id: "s1" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "prod-hydrated",
          pr_number: 8,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const hydration: BranchCloudHydrationSource = {
      hydrate: async () => ({
        status: BranchCloudHydrationStatus.Fresh,
        overlays: {
          "acme/web::prod-hydrated": {
            additions: 140,
            deletions: 10,
            filesChanged: 4,
          },
        },
      }),
    };

    const analytics = await getSharedBranchAnalytics(source, {}, hydration);

    assert.equal(analytics.medianPrSize.state, "available");
    assert.equal(analytics.medianPrSize.value, 150);
  });

  test("analytics ignores cloud legacy Last active when selecting a window", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "cloud-recent",
          session_id: "s1",
          activity_at: "2026-06-01T10:00:00.000Z",
        }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "cloud-recent",
          pr_number: 9,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-01T10:00:00.000Z",
          closed_at: "2026-06-01T10:00:00.000Z",
          observed_at: "2026-06-01T10:00:00.000Z",
        },
      ],
    });
    const hydration: BranchCloudHydrationSource = {
      hydrate: async () => ({
        status: BranchCloudHydrationStatus.Fresh,
        overlays: {
          "acme/web::cloud-recent": {
            additions: 140,
            deletions: 10,
            filesChanged: 4,
            lastActivityAt: "2026-06-20T10:00:00.000Z",
          },
        },
      }),
    };

    const analytics = await getSharedBranchAnalytics(
      source,
      { startDate: "2026-06-18T00:00:00.000Z" },
      hydration
    );

    assert.equal(analytics.medianPrSize.state, "unavailable");
    assert.equal(analytics.medianPrSize.value, null);
  });

  test("median PR size excludes MERGED multi-PR branches (ambiguous lifecycle) even when LOC-enriched (FEA-2159)", async () => {
    // Both branches are MERGED and LOC-enriched. The single-PR branch contributes
    // 200 + 50 = 250; the multi-PR branch (two distinct linked PRs →
    // multiPrWarning) carries 4000 + 1000 = 5000. Because BOTH are merged, the ONLY
    // reason the multi-PR branch stays out of the median is its ambiguous lifecycle
    // (multiPrWarning) — the row only carries the latest PR's state. So the median
    // must be 250 (the single-PR branch alone). If the `!multiPrWarning` guard were
    // dropped from the median filter, the 5000 would join and median([250, 5000])
    // would be 2625 — this assertion fails closed, guarding the clause.
    const source = makeSource({
      links: [
        link({
          branch_name: "single-merged",
          session_id: "s1",
          lines_added: 200,
          lines_removed: 50,
          files_changed: 5,
        }),
        link({
          branch_name: "multi-merged",
          session_id: "s2",
          lines_added: 4000,
          lines_removed: 1000,
          files_changed: 40,
        }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "single-merged",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
        // Two distinct MERGED PRs on one branch → multiPrWarning true. The newest
        // by observed_at (pr 2) is displayed and its MERGED state makes the branch
        // status Merged, so multiPrWarning is the sole ground for its exclusion.
        {
          repo_full_name: "acme/web",
          branch_name: "multi-merged",
          pr_number: 2,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-12T10:00:00.000Z",
          closed_at: "2026-06-12T10:00:00.000Z",
          observed_at: "2026-06-12T12:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "multi-merged",
          pr_number: 3,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-12T09:00:00.000Z",
          closed_at: "2026-06-12T09:00:00.000Z",
          observed_at: "2026-06-12T11:00:00.000Z",
        },
      ],
    });

    // Pin the exclusion PREMISE explicitly (self-diagnosing guard): the same list
    // projection analytics medians over must classify multi-merged as a MERGED,
    // multi-PR (ambiguous-lifecycle) branch and single-merged as a MERGED,
    // single-PR one. Asserting these directly means a future break surfaces as the
    // exact invariant that moved (e.g. "multiPrWarning false") rather than only as
    // a shifted median, and it proves the branch's exclusion is due to
    // multiPrWarning ALONE — both branches are otherwise merged + LOC-enriched.
    const listItems = (await getSharedBranches(source)).items;
    const single = listItems.find(
      (item) => item.branchName === "single-merged"
    );
    const multi = listItems.find((item) => item.branchName === "multi-merged");
    assert.ok(single, "single-merged branch present in the projection");
    assert.ok(multi, "multi-merged branch present in the projection");
    // multi-merged: genuinely merged AND unambiguously multi-PR (2 distinct PRs).
    assert.equal(multi.status, BranchStatus.Merged);
    assert.equal(multi.multiPrWarning, true);
    assert.equal((multi.additions ?? 0) + (multi.deletions ?? 0), 5000);
    // single-merged: merged and single-PR — the only branch that may enter the set.
    assert.equal(single.status, BranchStatus.Merged);
    assert.equal(single.multiPrWarning, false);
    assert.equal((single.additions ?? 0) + (single.deletions ?? 0), 250);

    const analytics = await getSharedBranchAnalytics(source);
    // Only the single-PR merged branch contributes: median([250]) = 250. The
    // merged multi-PR branch's 5000 is EXCLUDED (multiPrWarning); wrongly
    // including it would make median([250, 5000]) = 2625.
    assert.equal(analytics.medianPrSize.state, "available");
    assert.equal(analytics.medianPrSize.value, 250);
  });

  test("LOC-per-$ excludes the un-enriched-branch share of a mixed session (even-split)", async () => {
    // One session PUSHED an ENRICHED branch (churn 200) AND an UN-enriched one
    // (unknown LOC). FEA-2531: both are active-write links (the `method` records
    // the push that got them past the branch-reads display gate; `makeSource`
    // serves canned post-read rows, so the divisor here IS the active-write-link
    // count — 2). Its $1.00 is even-split across those 2 branches, so only the
    // enriched half ($0.50) — the spend backed by known LOC — counts in the
    // denominator. Counting the full $1.00 would drag the un-enriched half (no LOC
    // to offset it) in and HALVE the ratio (200/$1 = 200 vs 200/$0.50 = 400).
    const source = makeSource({
      links: [
        link({
          branch_name: "enriched",
          session_id: "s1",
          method: "git_push",
          lines_added: 150,
          lines_removed: 50,
          files_changed: 5,
        }),
        // Same session, a second PUSHED branch with NO LOC enrichment (lines null).
        link({
          branch_name: "unenriched",
          session_id: "s1",
          method: "git_push",
        }),
      ],
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 1.0,
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    // Numerator = churn of the lone enriched branch (150 + 50 = 200); the
    // un-enriched branch contributes nothing. Denominator = $1.00 × 1/2 = $0.50.
    assert.equal(analytics.locPerDollar.state, "available");
    assert.equal(analytics.locPerDollar.value, 400);
    // Headline AI spend still counts the session's full cost ONCE (it isn't the
    // LOC-per-$ denominator — the apportionment only scopes the ratio).
    assert.equal(analytics.totalSpendUsd.state, "available");
    assert.equal(analytics.totalSpendUsd.value, 1.0);
  });

  test("LOC-per-$ counts a 0-LOC enriched branch but not an un-enriched one", async () => {
    // KNOWN-zero LOC (both line counts present, no lines touched) is included;
    // UNKNOWN LOC (un-enriched) is excluded. Session sZero works a 0-LOC enriched
    // branch; session sUnknown works only an un-enriched branch. Only sZero's
    // spend may enter the denominator — and with 0 churn across the enriched set
    // the ratio is 0, NOT a fabricated value from the un-enriched session's $.
    const source = makeSource({
      links: [
        link({
          branch_name: "zero-loc",
          session_id: "sZero",
          lines_added: 0,
          lines_removed: 0,
          files_changed: 0,
        }),
        link({ branch_name: "no-enrich", session_id: "sUnknown" }),
      ],
      usageTokens: [
        {
          session_id: "sZero",
          model: "claude-sonnet-4-5",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.4,
        },
        {
          session_id: "sUnknown",
          model: "claude-sonnet-4-5",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.9,
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    // Enriched set = {zero-loc}, churn 0, denominator $0.40 → 0 / 0.40 = 0.
    // The un-enriched session's $0.90 is NOT in the denominator.
    assert.equal(analytics.locPerDollar.state, "available");
    assert.equal(analytics.locPerDollar.value, 0);
    // Headline spend still sums BOTH sessions (0.4 + 0.9 = 1.3).
    assert.equal(analytics.totalSpendUsd.value, 1.3);
  });

  test("analytics sums total AI spend locally and counts active branches (FEA-2051)", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "merged-branch", session_id: "s1" }),
        link({ branch_name: "open-branch", session_id: "s2" }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "merged-branch",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "open-branch",
          pr_number: 2,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T10:00:00.000Z",
        },
      ],
      // Spend reads the deduped per-session usage rows (s1's captured cost), not
      // the per-branch aggregate.
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.42,
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    // Spend = captured cost of the one session that carries tokens, counted once.
    assert.equal(analytics.totalSpendUsd.state, "available");
    assert.equal(analytics.totalSpendUsd.value, 0.42);
    // Active branches = those not merged/closed → only `open-branch`.
    assert.equal(analytics.activeBranchCount.state, "available");
    assert.equal(analytics.activeBranchCount.value, 1);
  });

  test("AI spend counts a session linked to MULTIPLE branches only once (no double-count)", async () => {
    // The bug: one session (s1) linked to two branches had its full cost
    // attributed to BOTH, and the card summed per-branch attribution — so a
    // session on N branches was counted N times, inflating AI spend. The deduped
    // per-session read counts s1's captured cost exactly once regardless of fan-out.
    const source = makeSource({
      links: [
        link({ branch_name: "branch-a", session_id: "s1" }),
        link({ branch_name: "branch-b", session_id: "s1" }),
      ],
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.42,
        },
      ],
    });
    const analytics = await getSharedBranchAnalytics(source);
    assert.equal(analytics.totalSpendUsd.state, "available");
    // Exactly one session's captured cost despite TWO branch links — not 2×.
    assert.equal(analytics.totalSpendUsd.value, 0.42);
  });

  test("analytics marks AI spend unavailable when no priced cost, not $0 (FEA-2051)", async () => {
    const source = makeSource({ links: [link({ branch_name: "x" })] });
    const analytics = await getSharedBranchAnalytics(source);
    assert.equal(analytics.totalSpendUsd.state, "unavailable");
    assert.equal(analytics.totalSpendUsd.value, null);
    // A non-empty corpus still yields a real active-branch count (the lone
    // PR-less branch derives to Draft → in progress).
    assert.equal(analytics.activeBranchCount.state, "available");
    assert.equal(analytics.activeBranchCount.value, 1);
  });

  test("windows the KPIs + spend to branches active in [startDate, endDate] (FEA-2155)", async () => {
    // The card↔table reconciliation bug: a 7-day table shown under all-time
    // cards. With a window, the active-branch count AND AI spend must reflect
    // only the in-window branches, the same set the table windows on.
    const source = makeSource({
      links: [
        link({
          branch_name: "recent",
          session_id: "s-recent",
          activity_at: "2026-06-20T10:00:00.000Z",
        }),
        link({
          branch_name: "stale",
          session_id: "s-stale",
          activity_at: "2026-05-01T10:00:00.000Z",
        }),
      ],
      usageTokens: [
        {
          session_id: "s-recent",
          model: "claude-sonnet-4-5",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.3,
        },
        {
          session_id: "s-stale",
          model: "claude-sonnet-4-5",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.7,
        },
      ],
      // FEA-4270: windowed spend sums per-event token_events by created_at.
      usageEvents: [
        eventFromToken("s-recent", "2026-06-20T10:00:00.000Z", 100, 50, 0.3),
        eventFromToken("s-stale", "2026-05-01T10:00:00.000Z", 100, 50, 0.7),
      ],
      canonicalActivity: [
        canonicalActivity({
          branchName: "recent",
          sourceEventId: "monitored:recent",
          occurredAt: "2026-06-20T10:00:00.000Z",
        }),
        canonicalActivity({
          branchName: "stale",
          sourceEventId: "monitored:stale",
          occurredAt: "2026-05-01T10:00:00.000Z",
        }),
      ],
    });
    // All-time: both Draft branches active, spend 0.3 + 0.7 = 1.0.
    const all = await getSharedBranchAnalytics(source);
    assert.equal(all.activeBranchCount.value, 2);
    assert.equal(all.totalSpendUsd.value, 1.0);
    // 7-day-style window starting after "stale": only "recent" survives (its
    // event is in-window; "stale"'s 05-01 event is out).
    const windowed = await getSharedBranchAnalytics(source, {
      startDate: "2026-06-17T00:00:00.000Z",
    });
    assert.equal(windowed.activeBranchCount.value, 1);
    assert.equal(windowed.totalSpendUsd.value, 0.3);
  });

  test("analytics windows AI spend by each EVENT's created_at, splitting a long session (FEA-4270)", async () => {
    // ONE in-window branch with ONE long-running session `s-split` that started
    // before the window but has usage EVENTS both inside and outside it. The
    // windowed AI-spend KPI must count ONLY the in-window events ($0.30), not the
    // session's whole lifetime cost and not the pre-window turn ($0.70), matching
    // the cloud per-event producer so the shared analytics card agrees on both
    // adapters (shafty023 P1 rework of chatgpt-codex #3667842014).
    const source = makeSource({
      links: [
        link({
          branch_name: "active",
          session_id: "s-split",
          activity_at: "2026-06-20T10:00:00.000Z",
        }),
      ],
      // Aggregate lifetime cost — used ONLY by the all-time path ($1.00).
      usageTokens: [
        {
          session_id: "s-split",
          model: "claude-sonnet-4-5",
          input_tokens: 200,
          output_tokens: 100,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 1.0,
        },
      ],
      // Per-event rows — used by the windowed path. Two in-window ($0.15 each) and
      // one pre-window ($0.70) that must be excluded under the window.
      usageEvents: [
        eventFromToken("s-split", "2026-06-20T10:00:00.000Z", 60, 30, 0.15),
        eventFromToken("s-split", "2026-06-21T10:00:00.000Z", 40, 20, 0.15),
        eventFromToken("s-split", "2026-06-10T10:00:00.000Z", 100, 50, 0.7),
      ],
    });
    // All-time: the aggregate lifetime cost, 1.0.
    const all = await getSharedBranchAnalytics(source);
    assert.equal(all.totalSpendUsd.value, 1.0);
    // Windowed [06-17, 06-30]: the branch qualifies but only the two in-window
    // events are priced — $0.15 + $0.15 = $0.30 — the pre-window $0.70 turn and
    // the $1.00 lifetime aggregate are excluded.
    const windowed = await getSharedBranchAnalytics(source, {
      startDate: "2026-06-17T00:00:00.000Z",
      endDate: "2026-06-30T00:00:00.000Z",
    });
    assert.equal(windowed.activeBranchCount.value, 1);
    assert.equal(windowed.totalSpendUsd.value, 0.3);
  });

  test("window compares lastActivityAt by instant, not byte-wise (FEA-2155)", async () => {
    // A space-separated timestamp on the SAME calendar day as the window start:
    // a byte-wise compare would drop it (space 0x20 < `T` 0x54), but its instant
    // is on/after the start in every timezone, so it must be KEPT.
    const source = makeSource({
      links: [
        link({
          branch_name: "recent",
          session_id: "s1",
          activity_at: "2026-06-17 23:59:59",
        }),
      ],
      canonicalActivity: [
        canonicalActivity({
          branchName: "recent",
          sourceEventId: "monitored:recent",
          occurredAt: "2026-06-17 23:59:59",
        }),
      ],
    });
    const windowed = await getSharedBranchAnalytics(source, {
      startDate: "2026-06-17T00:00:00.000Z",
    });
    assert.equal(windowed.activeBranchCount.value, 1);
  });

  test("windows on the COMMIT-inclusive lastActivityAt, like the table (PRD-486 / FEA-2155)", async () => {
    // SESSION activity (06-10) is outside a window starting 06-18, but the latest
    // COMMIT (06-20) is inside. The table windows on the commit-inclusive
    // `lastActivityAt` (PRD-486), so the cards must too — windowing on a
    // commit-blind timestamp would drop this branch and its spend, breaking the
    // card↔table reconciliation this change exists to fix.
    const source = makeSource({
      links: [
        link({
          branch_name: "commit-recent",
          session_id: "s1",
          activity_at: "2026-06-10T10:00:00.000Z",
        }),
      ],
      commits: [
        commit({
          branch_name: "commit-recent",
          committed_at: "2026-06-20T08:00:00.000Z",
        }),
      ],
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: null,
          cost_usd_estimated: 0.25,
        },
      ],
      // FEA-4270: spend windows on the EVENT's created_at, so give the
      // contributing session an in-window event (its work landed with the 06-20
      // commit). The branch-COUNT still keys on the commit-inclusive
      // lastActivityAt (PRD-486) — the behavior this test guards — but the spend
      // it counts is now the in-window event's, matching the cloud producer.
      usageEvents: [
        eventFromToken("s1", "2026-06-20T07:00:00.000Z", 100, 50, 0.25),
      ],
    });
    const windowed = await getSharedBranchAnalytics(source, {
      startDate: "2026-06-18T00:00:00.000Z",
    });
    // Commit 06-20 places the branch in-window → counted; the in-window event's
    // spend is included.
    assert.equal(windowed.activeBranchCount.value, 1);
    assert.equal(windowed.totalSpendUsd.value, 0.25);
  });

  test("endDate excludes branches active after the window (FEA-2155)", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "in-window",
          session_id: "s1",
          activity_at: "2026-06-10T10:00:00.000Z",
        }),
        link({
          branch_name: "after-window",
          session_id: "s2",
          activity_at: "2026-06-25T10:00:00.000Z",
        }),
      ],
      canonicalActivity: [
        canonicalActivity({
          branchName: "in-window",
          sourceEventId: "monitored:in",
          occurredAt: "2026-06-10T10:00:00.000Z",
        }),
        canonicalActivity({
          branchName: "after-window",
          sourceEventId: "monitored:after",
          occurredAt: "2026-06-25T10:00:00.000Z",
        }),
      ],
    });
    const windowed = await getSharedBranchAnalytics(source, {
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-06-15T00:00:00.000Z",
    });
    assert.equal(windowed.activeBranchCount.value, 1);
  });
});

describe("getSharedBranchesPageData (FEA-3056 follow-up: combined list + analytics)", () => {
  test("returns the empty canonical pair for a missing source", async () => {
    assert.deepEqual(
      await getSharedBranchesPageData(null),
      emptySharedBranchesPageDataResponse()
    );
  });

  test("contributor cloud filter returns the empty canonical pair without touching the source", async () => {
    let queried = false;
    const source = makeSource({}, () => {
      queried = true;
    });

    assert.deepEqual(
      await getSharedBranchesPageData(source, { contributorUserId: "u1" }),
      emptySharedBranchesPageDataResponse()
    );
    assert.equal(queried, false);
  });

  test("list + analytics exactly match the standalone reads (no drift from sharing rows)", async () => {
    const rows: CannedRows = {
      links: [
        link({ branch_name: "merged-branch", session_id: "s1" }),
        link({ branch_name: "open-branch", session_id: "s2" }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "merged-branch",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "open-branch",
          pr_number: 2,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T10:00:00.000Z",
        },
      ],
    };
    const request = { endDate: "2026-07-01T00:00:00.000Z" };
    const combined = await getSharedBranchesPageData(makeSource(rows), request);
    const list = await getSharedBranches(makeSource(rows), request);
    const analytics = await getSharedBranchAnalytics(makeSource(rows), request);
    assert.deepEqual(combined.list, list);
    assert.deepEqual(combined.analytics, analytics);
  });

  test("a read failure rethrows a sanitized, code-only error (no SQL leak)", async () => {
    await assert.rejects(
      getSharedBranchesPageData(throwingSource),
      (err: Error) => {
        assert.equal(err.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
        assert.doesNotMatch(err.message, SQL_SECRET);
        return true;
      }
    );
  });

  // FEA-4177 wongk review: the analytics-only per-session usage read
  // (`readBranchAnalyticsTokenRows`, the no-billing-JOIN token read) must live in
  // the BEST-EFFORT analytics half. It previously ran in the outer fatal
  // `Promise.all`, so a failure there rejected the whole read and blanked the
  // list. Fail ONLY that read and prove the list still resolves with
  // `analyticsError: true` (and no `sessionCostUsd`, since the cost map derives
  // from the same failed read), while the shared list reads stay fatal.
  test("an analytics-token read failure degrades to analyticsError without blanking the list", async () => {
    const base = makeSource({
      links: [link({ branch_name: "a", session_id: "s1" })],
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd_estimated: 1.23,
        },
      ],
    });
    const baseClient = rawQueryClientOf(base);
    const baseQueryRaw = baseClient.$queryRawUnsafe.bind(baseClient);
    // Reject ONLY the analytics-path token read (no billing-mode JOIN); the
    // list's own token aggregate + link/PR/commit reads still succeed.
    const source = {
      ...base,
      prisma: {
        client: new Proxy(baseClient, {
          get: (target, prop) => {
            if (prop === "$queryRawUnsafe") {
              return (sql: string, ...args: unknown[]) => {
                // Both token reads now JOIN sessions (FEA-4270 added
                // `s.started_at` to the analytics path too), so the sessions JOIN
                // no longer distinguishes them. The analytics path is the one that
                // does NOT select `s.billing_mode` (the usage path's billing
                // split), so reject on that.
                if (
                  sql.includes("FROM token_usage tu") &&
                  !sql.includes("s.billing_mode")
                ) {
                  return Promise.reject(
                    new Error("analytics token read failed")
                  );
                }
                return baseQueryRaw(sql, ...args);
              };
            }
            return Reflect.get(target, prop);
          },
        }),
      },
    } as unknown as BranchSyncSource;

    const result = await getSharedBranchesPageData(source);

    assert.ok(result.list, "list should still resolve");
    assert.equal(result.list.total, 1);
    assert.equal(result.analytics, undefined);
    assert.equal(result.analyticsError, true);
    assert.equal(result.list.sessionCostUsd, undefined);
  });

  // FEA-3056 follow-up: the page-data read must never block first paint on a
  // live GitHub round trip, so both the list and analytics projections hydrate
  // via the non-blocking `peekOrWarm` rather than the blocking `hydrate`.
  test("hydrates via peekOrWarm, not hydrate, so the read never blocks on a live GitHub call", async () => {
    const calls: string[] = [];
    const source = makeSource({
      links: [link({ branch_name: "a", session_id: "s1" })],
    });
    const cloudHydration = {
      hydrate: () => {
        calls.push("hydrate");
        return Promise.resolve({ status: BranchCloudHydrationStatus.Fresh });
      },
      peekOrWarm: () => {
        calls.push("peekOrWarm");
        return Promise.resolve({ status: BranchCloudHydrationStatus.Stale });
      },
    };

    await getSharedBranchesPageData(source, {}, cloudHydration);

    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call === "peekOrWarm"));
  });
});
