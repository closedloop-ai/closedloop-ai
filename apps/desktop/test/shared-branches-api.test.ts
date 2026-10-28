import assert from "node:assert/strict";
import { BranchStatus, encodeBranchId } from "@repo/api/src/types/branch.js";
import { BranchMetricAvailability as MetricAvailability } from "@repo/api/src/types/branch-metrics.js";
import { describe, test, vi } from "vitest";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import {
  getSharedBranches,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import {
  ensureOrgDirectory,
  resetOrgDirectoryCacheForTest,
} from "../src/main/session/org-directory-cache.js";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
import {
  canonicalActivity,
  commit,
  eventFromToken,
  KIND_BRANCH_RE,
  link,
  makeSource,
  SQL_SECRET,
  throwingSource,
} from "./shared-branches-test-helpers.js";

vi.mock(
  "../src/main/branch/shared-branches-default-eligibility.js",
  async (importOriginal) =>
    (
      await import("./helpers/complete-eligibility-snapshot.js")
    ).withCompleteEligibility(await importOriginal())
);

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

  test("a linked PR row with no persisted state reads as unobserved, multiPrWarning false", async () => {
    const source = makeSource({
      links: [link({})],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: "https://gh/acme/web/pull/42",
          title: "Add X",
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
    assert.equal(row.prState, null);
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
    // ISS-11915 preserves commit precedence over the Session fallback.
    const source = makeSource({
      links: [link({ activity_at: "2026-06-10T10:00:00.000Z" })],
      commits: [commit({ committed_at: "2026-06-08T08:00:00.000Z" })],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "2026-06-08T08:00:00.000Z");
  });

  test("lastActivityAt takes the latest of commit + PR closed_at (PRD-486)", async () => {
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
          closed_at: null,
          observed_at: "2026-06-10T12:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 43,
          pr_url: null,
          title: null,
          closed_at: null,
          observed_at: "2026-06-10T11:00:00.000Z",
        },
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.multiPrWarning, true);
    assert.equal(row.prNumber, null);
  });

  test("no PR + no enrichment → Open (ISS-9664), enrichment fields null (never 0)", async () => {
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
    assert.equal(row.status, BranchStatus.Open);
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
    // adapters (davetho P1 rework of chatgpt-codex #3667842014). All-time uses
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

  test("hour buckets use captured event cost instead of repricing cache-write TTL fields", async () => {
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
        cost_usd_estimated: 0.31,
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
        cost_usd_estimated: 0.47,
      },
    ];
    const source = makeSource({
      links: [link({ branch_name: "a", session_id: "s1" })],
      usageTokens: [],
      usageEvents: events,
    });

    const summary = await getSharedBranchUsage(source);
    assert.equal(summary.hourBuckets[0]?.byActor[0]?.estimatedCostUsd, 0.78);
  });
});

describe("getSharedBranchAnalytics (B6)", () => {
  test("analytics returns the empty canonical response for a missing source", async () => {
    assert.deepEqual(
      await getSharedBranchAnalytics(null),
      emptySharedBranchesAnalytics()
    );
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

  test("analytics does not re-query session_artifact_links for the usage read", async () => {
    // The usage-token read reuses the session ids already collected by the link
    // read instead of re-querying session_artifact_links for them. The link read
    // itself may be served by a bounded raw branch scan, but the usage read must
    // not trigger another link-table lookup.
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
    await getSharedBranchAnalytics(source);
    assert.ok(
      sqls.filter((sql) => sql === "links").length <= 1,
      "expected no redundant session_artifact_links re-read"
    );
    // The token rows are still fetched through the session-scoped read.
    assert.ok(sqls.includes("usageTokens"));
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

  test("windows the KPIs to branches active in [startDate, endDate] (FEA-2155)", async () => {
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
    // All-time: both Draft branches active.
    const all = await getSharedBranchAnalytics(source);
    assert.equal(all.activeBranchCount.value, 2);
    // 7-day-style window starting after "stale": only "recent" survives (its
    // event is in-window; "stale"'s 05-01 event is out).
    const windowed = await getSharedBranchAnalytics(source, {
      startDate: "2026-06-17T00:00:00.000Z",
    });
    assert.equal(windowed.activeBranchCount.value, 1);
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
    // Commit 06-20 places the branch in-window → counted.
    assert.equal(windowed.activeBranchCount.value, 1);
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
