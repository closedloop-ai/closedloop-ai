/**
 * @file branch-lifecycle-reads-coverage.test.ts
 * @description ISS-8730 coverage for `database/branch-lifecycle-reads.ts`.
 *
 * `readBranchLifecycleEventRowsForBranch` / `readBranchSessionTokenRowsForBranch`
 * already have thorough end-to-end coverage against a real libSQL DB via the
 * `branch-reads.ts` facade (`branch-reads-contract.test.ts`,
 * `branch-reads-baseline-fold.test.ts`, `iss-6542-dual-evidence-eligibility.test.ts`).
 * This file does NOT re-derive that coverage. It targets what those suites don't:
 * the two exported pure mappers' own branching (target-kind dispatch, sort/tie-break,
 * token clamping) with a simple recording Prisma mock for the two raw-SQL readers'
 * parameter wiring.
 *
 * Pins CURRENT behavior; does not fix source.
 */
import assert from "node:assert/strict";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import {
  mapBranchLifecycleEventRows,
  readBranchLifecycleEventRowsForBranch,
  readBranchSessionTokenRowsForBranch,
} from "../src/main/database/branch-lifecycle-reads.js";
import type {
  BranchKeyRow,
  BranchLifecycleEventRawRow,
} from "../src/main/database/branch-reads.js";
import type { DbHostPrisma } from "../src/main/database/prisma-client.js";

const DENOMINATOR_CTE_PATTERN = /denominator_branches/;
const ACTIVE_WRITE_SQL_PATTERN = /sal\.method IN \('git_push'\)/;

function makeRawRow(
  overrides: Partial<BranchLifecycleEventRawRow>
): BranchLifecycleEventRawRow {
  return {
    link_id: "link-1",
    session_id: "s1",
    relation: ArtifactRefRelation.Created,
    method: "git_push",
    target_kind: ArtifactRefTargetKind.Branch,
    repo_full_name: "acme/web",
    branch_name: "feature/x",
    observed_at: "2026-06-01T00:00:00.000Z",
    session_started_at: "2026-05-31T23:00:00.000Z",
    session_ended_at: "2026-06-01T01:00:00.000Z",
    ...overrides,
  };
}

describe("mapBranchLifecycleEventRows", () => {
  test("drops rows with a null branch_name before producing any event", () => {
    const rows = mapBranchLifecycleEventRows([
      makeRawRow({ branch_name: null }),
    ]);
    assert.deepEqual(rows, []);
  });

  test("a commit target_kind is dispatched through the branch-link mapper", () => {
    const rows = mapBranchLifecycleEventRows([
      makeRawRow({
        target_kind: ArtifactRefTargetKind.Commit,
        relation: ArtifactRefRelation.Created,
      }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, BranchLifecycleBoundaryKind.BranchWrite);
  });

  test("a pull_request target_kind is dispatched through the PR-link mapper, a different kind for the same relation", () => {
    const rows = mapBranchLifecycleEventRows([
      makeRawRow({
        target_kind: ArtifactRefTargetKind.PullRequest,
        relation: ArtifactRefRelation.Created,
      }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, BranchLifecycleBoundaryKind.PrRaised);
  });

  test("a relation with no lifecycle mapping produces zero events for that row", () => {
    const rows = mapBranchLifecycleEventRows([makeRawRow({ relation: null })]);
    assert.deepEqual(rows, []);
  });

  test("orders events by session id ahead of timestamp", () => {
    const rows = mapBranchLifecycleEventRows([
      makeRawRow({
        session_id: "s2",
        link_id: "l2",
        observed_at: "2026-06-01T00:00:00.000Z",
      }),
      makeRawRow({
        session_id: "s1",
        link_id: "l1",
        observed_at: "2026-06-05T00:00:00.000Z",
      }),
    ]);
    assert.deepEqual(
      rows.map((r) => r.sessionId),
      ["s1", "s2"]
    );
  });

  test("within a session, null and unparseable observed_at sort after every valid timestamp", () => {
    const rows = mapBranchLifecycleEventRows([
      makeRawRow({ link_id: "l-null", session_id: "s1", observed_at: null }),
      makeRawRow({
        link_id: "l-bad",
        session_id: "s1",
        observed_at: "not-a-date",
      }),
      makeRawRow({
        link_id: "l-early",
        session_id: "s1",
        observed_at: "2026-06-01T00:00:00.000Z",
      }),
    ]);
    assert.deepEqual(
      rows.map((r) => r.evidenceId),
      [
        "desktop-artifact-link:l-early",
        "desktop-artifact-link:l-bad",
        "desktop-artifact-link:l-null",
      ]
    );
  });

  test("ties on session and timestamp break lexicographically on kind|observedAt|evidenceId", () => {
    const rows = mapBranchLifecycleEventRows([
      makeRawRow({
        link_id: "zzz",
        session_id: "s1",
        observed_at: "2026-06-01T00:00:00.000Z",
        relation: ArtifactRefRelation.Output,
      }),
      makeRawRow({
        link_id: "aaa",
        session_id: "s1",
        observed_at: "2026-06-01T00:00:00.000Z",
        relation: ArtifactRefRelation.Output,
      }),
    ]);
    // Same kind (BranchWrite) and observedAt for both, so the tie breaks on
    // evidenceId: "aaa" < "zzz".
    assert.deepEqual(
      rows.map((r) => r.evidenceId),
      ["desktop-artifact-link:aaa", "desktop-artifact-link:zzz"]
    );
  });

  test("method and repo/session metadata are carried onto every produced event row", () => {
    const rows = mapBranchLifecycleEventRows([
      makeRawRow({
        method: "gh_pr_review",
        repo_full_name: "acme/web",
        session_started_at: "2026-05-01T00:00:00.000Z",
        session_ended_at: "2026-05-01T02:00:00.000Z",
      }),
    ]);
    assert.equal(rows[0].method, "gh_pr_review");
    assert.equal(rows[0].repoFullName, "acme/web");
    assert.equal(rows[0].sessionStartedAt, "2026-05-01T00:00:00.000Z");
    assert.equal(rows[0].sessionEndedAt, "2026-05-01T02:00:00.000Z");
  });
});

describe("mapBranchSessionTokenRows (via readBranchSessionTokenRowsForBranch)", () => {
  function makePrisma(query: (sql: string, ...params: unknown[]) => unknown[]) {
    return {
      client: {
        $queryRawUnsafe: (sql: string, ...params: unknown[]) =>
          Promise.resolve(query(sql, ...params)),
      },
    } as unknown as DbHostPrisma;
  }

  const KEY: BranchKeyRow = { repoFullName: "acme/web", branchName: "main" };
  const activeWriteLinkSql = (linkAlias: string) =>
    `${linkAlias}.method IN ('git_push')`;

  for (const [label, branchCount, expected] of [
    ["zero", 0, 1],
    ["null", null, 1],
    ["a normal positive count", 3, 3],
  ] as const) {
    test(`clamps a branch_count of ${label} to at least one`, async () => {
      const prisma = makePrisma(() => [
        {
          session_id: "s1",
          branch_count: branchCount,
          input_tokens: "0",
          output_tokens: "0",
          cache_read_tokens: "0",
          cache_write_tokens: "0",
          cost_usd_estimated: null,
          even_split_cost_usd: null,
        },
      ]);
      const rows = await readBranchSessionTokenRowsForBranch(
        prisma,
        KEY,
        activeWriteLinkSql
      );
      assert.equal(rows[0].branchCount, expected);
    });
  }

  test("converts a bigint branch_count to a number", async () => {
    const prisma = makePrisma(() => [
      {
        session_id: "s1",
        branch_count: 4n,
        input_tokens: "0",
        output_tokens: "0",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cost_usd_estimated: null,
        even_split_cost_usd: null,
      },
    ]);
    const rows = await readBranchSessionTokenRowsForBranch(
      prisma,
      KEY,
      activeWriteLinkSql
    );
    assert.equal(rows[0].branchCount, 4);
  });

  test("a negative stored token count degrades to zero instead of throwing (FEA-4280)", async () => {
    const prisma = makePrisma(() => [
      {
        session_id: "s1",
        branch_count: 1,
        input_tokens: "-5",
        output_tokens: "0",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cost_usd_estimated: null,
        even_split_cost_usd: null,
      },
    ]);
    const rows = await readBranchSessionTokenRowsForBranch(
      prisma,
      KEY,
      activeWriteLinkSql
    );
    assert.equal(rows[0].inputTokens, 0);
  });

  test("cost fields stay null when unset but convert to numbers when present", async () => {
    const prisma = makePrisma(() => [
      {
        session_id: "s1",
        branch_count: 1,
        input_tokens: "0",
        output_tokens: "0",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cost_usd_estimated: null,
        even_split_cost_usd: null,
      },
      {
        session_id: "s2",
        branch_count: 1,
        input_tokens: "0",
        output_tokens: "0",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cost_usd_estimated: 12.5,
        even_split_cost_usd: 6.25,
      },
    ]);
    const rows = await readBranchSessionTokenRowsForBranch(
      prisma,
      KEY,
      activeWriteLinkSql
    );
    assert.equal(rows[0].costUsdEstimated, null);
    assert.equal(rows[0].evenSplitCostUsd, null);
    assert.equal(rows[1].costUsdEstimated, 12.5);
    assert.equal(rows[1].evenSplitCostUsd, 6.25);
  });

  test("without denominatorKeys, no JSON param is bound and no denominator CTE is emitted", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const prisma = makePrisma((sql, ...params) => {
      capturedSql = sql;
      capturedParams = params;
      return [];
    });

    await readBranchSessionTokenRowsForBranch(prisma, KEY, activeWriteLinkSql);

    assert.deepEqual(capturedParams, [KEY.branchName, KEY.repoFullName]);
    assert.doesNotMatch(capturedSql, DENOMINATOR_CTE_PATTERN);
  });

  test("with denominatorKeys, the JSON-encoded key list is bound first and the denominator CTE is emitted", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const prisma = makePrisma((sql, ...params) => {
      capturedSql = sql;
      capturedParams = params;
      return [];
    });
    const denominatorKeys: BranchKeyRow[] = [
      { repoFullName: "acme/web", branchName: "main" },
      { repoFullName: "acme/web", branchName: "feature/x" },
    ];

    await readBranchSessionTokenRowsForBranch(
      prisma,
      KEY,
      activeWriteLinkSql,
      denominatorKeys
    );

    assert.deepEqual(capturedParams, [
      JSON.stringify(denominatorKeys),
      KEY.branchName,
      KEY.repoFullName,
    ]);
    assert.match(capturedSql, DENOMINATOR_CTE_PATTERN);
  });
});

describe("readBranchLifecycleEventRowsForBranch", () => {
  function makePrisma(query: (sql: string, ...params: unknown[]) => unknown[]) {
    return {
      client: {
        $queryRawUnsafe: (sql: string, ...params: unknown[]) =>
          Promise.resolve(query(sql, ...params)),
      },
    } as unknown as DbHostPrisma;
  }

  const KEY: BranchKeyRow = { repoFullName: "acme/web", branchName: "main" };

  test("binds the branch key four times and threads the active-write predicate through the aliases it names", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const prisma = makePrisma((sql, ...params) => {
      capturedSql = sql;
      capturedParams = params;
      return [];
    });
    const seenAliases: [string, string][] = [];
    const activeWriteLinkSql = (linkAlias: string, artifactAlias: string) => {
      seenAliases.push([linkAlias, artifactAlias]);
      return `${linkAlias}.method IN ('git_push')`;
    };

    await readBranchLifecycleEventRowsForBranch(
      prisma,
      KEY,
      activeWriteLinkSql
    );

    assert.deepEqual(capturedParams, [
      KEY.branchName,
      KEY.repoFullName,
      KEY.branchName,
      KEY.repoFullName,
      KEY.branchName,
      KEY.repoFullName,
      KEY.branchName,
      KEY.repoFullName,
    ]);
    assert.deepEqual(seenAliases, [["sal", "a"]]);
    assert.match(capturedSql, ACTIVE_WRITE_SQL_PATTERN);
  });

  test("maps the raw rows the query returns through the real mapper (rows flow end to end)", async () => {
    const prisma = makePrisma(() => [
      {
        link_id: "l1",
        session_id: "s1",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        target_kind: ArtifactRefTargetKind.Branch,
        repo_full_name: "acme/web",
        branch_name: "main",
        observed_at: "2026-06-01T00:00:00.000Z",
        session_started_at: "2026-05-31T00:00:00.000Z",
        session_ended_at: null,
      },
    ]);

    const rows = await readBranchLifecycleEventRowsForBranch(
      prisma,
      KEY,
      () => "1=1"
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, BranchLifecycleBoundaryKind.BranchWrite);
    assert.equal(rows[0].sessionId, "s1");
    assert.equal(rows[0].evidenceId, "desktop-artifact-link:l1");
  });
});
