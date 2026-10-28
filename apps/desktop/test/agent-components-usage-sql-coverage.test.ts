/**
 * @file agent-components-usage-sql-coverage.test.ts
 * @description ISS-8730 coverage for every export of
 * `src/main/dashboard/agent-components-usage-sql.ts` — the ranked usage source
 * and the six SQL builders layered on it (aggregate, session-ids, unresolved
 * aggregate, plugin rollup, plugin session-ids, plugin per-session).
 *
 * Pins CURRENT behavior only. Where a doc comment in the source names a defect
 * class the code deliberately does NOT close (e.g. the duplicate-install
 * multiplication noted on `pluginUsageSql`), this file does not attempt to
 * close it either — it is out of scope for a coverage pass.
 */
import assert from "node:assert/strict";
import type { AgentComponentQueryFilters } from "@repo/api/src/types/agent-component";
import { afterAll, test } from "vitest";
import {
  BETWEEN_GROUP_RANKING_WINDOW_SQL,
  BOTH_INVOKED_BOUNDS,
  FIRST_INVOKED_SORT,
  hasUsageWindow,
  LAST_INVOKED_SORT,
  PLUGIN_USAGE_SESSIONS_SQL,
  pluginUsageSessionIdsSql,
  pluginUsageSql,
  toUsageWindow,
  type UsageQuery,
  unresolvedUsageAggregateSql,
  usageAggregateSql,
  usageRecencyRankedSource,
  usageSessionIdsSql,
  usageWindowClause,
} from "../src/main/dashboard/agent-components-usage-sql.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// Three fixture instants whose byte order and time order DISAGREE — the same
// trio `component-usage-invoked-at-mixed-format.test.ts` uses to pin the
// rollup writer. Reused here (not imported — that file's constants are
// private) to prove these SQL builders wire the same canonical ranking.
const OFFSET_FORM_LATEST = "2026-06-22T09:00:00-05:30"; // 14:30Z, true latest
const WHOLE_SECOND_EARLIEST = "2026-06-22T10:00:00Z"; // 10:00Z, true earliest
const SUBSECOND_MIDDLE = "2026-06-22T10:00:00.500Z"; // 10:00:00.500Z
const CANONICAL_EARLIEST = "2026-06-22T10:00:00.000Z";
const CANONICAL_LATEST = "2026-06-22T14:30:00.000Z";

// Structural fragment matchers, hoisted to module scope (useTopLevelRegex).
const GLOB_GUARD_RE = /GLOB/;
const GTE_PLACEHOLDER_RE = />= \?/;
const LTE_PLACEHOLDER_RE = /<= \?/;
const CANONICAL_LAST_INVOKED_COLUMN_RE = /canonical_last_invoked_at/;
const CANONICAL_FIRST_INVOKED_COLUMN_RE = /canonical_first_invoked_at/;
const LAST_INVOKED_SORT_COLUMN_RE = /last_invoked_at_sort/;
const FIRST_INVOKED_SORT_COLUMN_RE = /first_invoked_at_sort/;
const PARTITIONED_WINDOW_RE = /OVER \(PARTITION BY component_kind\)/;
const UNPARTITIONED_WINDOW_RE = /OVER \(\)/;
const EXTRA_PROJECTION_RE = /ac\.pack_id AS pack_id/;
const WHERE_CLAUSE_RE = /WHERE/;
const GROUP_BY_KIND_RE = /GROUP BY acsu\.component_kind/;
// Anchored to the GROUP BY clause, NOT to the whole statement. Both identifiers
// also appear in the SELECT list, so a bare /acsu\.component_version_hash/ can
// tell SELECT from GROUP BY not at all: dropping the column from the GROUP BY
// leaves it green while FEA-3982's per-version session dedup collapses.
const GROUP_BY_CLAUSE_RE = /GROUP BY (?<clause>[\s\S]+)$/;
const VERSION_HASH_COLUMN_RE = /acsu\.component_version_hash/;
const SESSION_ID_COLUMN_RE = /acsu\.session_id/;

/** The text after `GROUP BY`, so a matcher cannot be satisfied by the SELECT list. */
function groupByClauseOf(sql: string): string {
  return GROUP_BY_CLAUSE_RE.exec(sql)?.groups?.clause ?? "";
}
const HARNESS_CASE_RE = /CASE\s+WHEN COUNT\(DISTINCT harness\)/;
const FIRST_SEEN_MIN_RE = /MIN\(first_invoked_at_sort\) AS first_seen_at/;
const LAST_SEEN_MAX_RE = /MAX\(last_invoked_at_sort\) AS last_seen_at/;
const INNER_JOIN_RE = /INNER JOIN agent_components ac/;
const PACK_ID_NOT_NULL_RE = /ac\.pack_id IS NOT NULL/;
const UNINSTALLED_NULL_RE = /ac\.uninstalled_at IS NULL/;
const KIND_ALLOWLIST_RE = /ac\.component_kind IN \(/;

const openStores: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.allSettled(openStores.map((close) => close()));
});

async function openStore(): Promise<DesktopPrisma> {
  const { prisma, close } = await openTestPrisma();
  openStores.push(close);
  return prisma;
}

function runQuery(
  prisma: DesktopPrisma,
  query: UsageQuery
): Promise<Record<string, unknown>[]> {
  return prisma.read((client) =>
    client.$queryRawUnsafe<Record<string, unknown>[]>(
      query.sql,
      ...query.params
    )
  );
}

function runRaw(
  prisma: DesktopPrisma,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>[]> {
  return prisma.read((client) =>
    client.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params)
  );
}

type UsageRowSeed = {
  sessionId: string;
  kind?: string;
  key: string;
  gitBranch?: string;
  versionHash?: string | null;
  invocations?: number;
  firstInvokedAt?: string | null;
  lastInvokedAt?: string | null;
  agentComponentId?: string | null;
  harness?: string | null;
};

async function seedUsage(
  prisma: DesktopPrisma,
  row: UsageRowSeed
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_session_usage
         (session_id, component_kind, component_key, git_branch,
          component_version_hash, agent_component_id, harness,
          invocations, first_invoked_at, last_invoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      row.sessionId,
      row.kind ?? "tool",
      row.key,
      row.gitBranch ?? "",
      row.versionHash ?? null,
      row.agentComponentId ?? null,
      row.harness ?? null,
      row.invocations ?? 1,
      row.firstInvokedAt ?? null,
      row.lastInvokedAt ?? null
    )
  );
}

type ComponentSeed = {
  id: string;
  kind: string;
  key?: string | null;
  packId?: string | null;
  uninstalledAt?: string | null;
};

async function seedComponent(
  prisma: DesktopPrisma,
  row: ComponentSeed
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, pack_id, uninstalled_at)
       VALUES ($1, $2, $1, $3, $4, $5)`,
      row.id,
      row.kind,
      row.key ?? null,
      row.packId ?? null,
      row.uninstalledAt ?? null
    )
  );
}

function num(value: unknown): number {
  return Number(value);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("FIRST_INVOKED_SORT and LAST_INVOKED_SORT name the _sort-suffixed ranking keys", () => {
  assert.equal(FIRST_INVOKED_SORT, "first_invoked_at_sort");
  assert.equal(LAST_INVOKED_SORT, "last_invoked_at_sort");
});

test("BOTH_INVOKED_BOUNDS lists first_invoked_at then last_invoked_at", () => {
  assert.deepEqual(BOTH_INVOKED_BOUNDS, [
    "first_invoked_at",
    "last_invoked_at",
  ]);
});

test("BETWEEN_GROUP_RANKING_WINDOW_SQL is the empty (unpartitioned) window", () => {
  assert.equal(BETWEEN_GROUP_RANKING_WINDOW_SQL, "");
});

// ---------------------------------------------------------------------------
// toUsageWindow / hasUsageWindow
// ---------------------------------------------------------------------------

test("toUsageWindow copies startDate/endDate onto start/end", () => {
  const filters: AgentComponentQueryFilters = {
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-06-30T00:00:00.000Z",
  };
  assert.deepEqual(toUsageWindow(filters), {
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-06-30T00:00:00.000Z",
  });
});

test("toUsageWindow yields undefined bounds when the filters carry neither date", () => {
  assert.deepEqual(toUsageWindow({}), { start: undefined, end: undefined });
});

test("hasUsageWindow is true when either bound is present and false otherwise", () => {
  assert.equal(hasUsageWindow({}), false);
  assert.equal(hasUsageWindow({ start: "2026-06-01" }), true);
  assert.equal(hasUsageWindow({ end: "2026-06-30" }), true);
  assert.equal(
    hasUsageWindow({ start: "2026-06-01", end: "2026-06-30" }),
    true
  );
});

// ---------------------------------------------------------------------------
// usageWindowClause
// ---------------------------------------------------------------------------

test("usageWindowClause returns no conditions or params for an unbounded window", () => {
  assert.deepEqual(usageWindowClause({}), { conditions: [], params: [] });
});

test("usageWindowClause adds the comparable guard and a lower-bound condition, canonicalizing the start", () => {
  const { conditions, params } = usageWindowClause({ start: "2026-07-14" });
  assert.equal(conditions.length, 2);
  assert.match(conditions[0], GLOB_GUARD_RE);
  assert.match(conditions[1], GTE_PLACEHOLDER_RE);
  // A bare date is canonicalized to midnight UTC before binding.
  assert.deepEqual(params, ["2026-07-14T00:00:00.000Z"]);
});

test("usageWindowClause adds the comparable guard and an upper-bound condition, canonicalizing the end", () => {
  const { conditions, params } = usageWindowClause({ end: "2026-07-14" });
  assert.equal(conditions.length, 2);
  assert.match(conditions[0], GLOB_GUARD_RE);
  assert.match(conditions[1], LTE_PLACEHOLDER_RE);
  assert.deepEqual(params, ["2026-07-14T00:00:00.000Z"]);
});

test("usageWindowClause adds both bounds without duplicating the comparable guard", () => {
  const { conditions, params } = usageWindowClause({
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-06-30T00:00:00.000Z",
  });
  assert.equal(conditions.length, 3);
  assert.equal(params.length, 2);
  assert.deepEqual(params, [
    "2026-06-01T00:00:00.000Z",
    "2026-06-30T00:00:00.000Z",
  ]);
});

// ---------------------------------------------------------------------------
// usageRecencyRankedSource
// ---------------------------------------------------------------------------

test("usageRecencyRankedSource ranks the default last_invoked_at column against the given partition", () => {
  const sql = usageRecencyRankedSource({
    fromSql: "FROM agent_component_session_usage acsu",
    partitionSql: "PARTITION BY component_kind",
  });
  assert.match(sql, CANONICAL_LAST_INVOKED_COLUMN_RE);
  assert.match(sql, LAST_INVOKED_SORT_COLUMN_RE);
  assert.match(sql, PARTITIONED_WINDOW_RE);
});

test("usageRecencyRankedSource emits one sort projection per ranked column, unpartitioned for the between-group window", () => {
  const sql = usageRecencyRankedSource({
    fromSql: "FROM agent_component_session_usage acsu",
    partitionSql: BETWEEN_GROUP_RANKING_WINDOW_SQL,
    rankedColumns: BOTH_INVOKED_BOUNDS,
  });
  assert.match(sql, CANONICAL_FIRST_INVOKED_COLUMN_RE);
  assert.match(sql, CANONICAL_LAST_INVOKED_COLUMN_RE);
  assert.match(sql, FIRST_INVOKED_SORT_COLUMN_RE);
  assert.match(sql, LAST_INVOKED_SORT_COLUMN_RE);
  // The between-group window is the empty parenthesized OVER clause.
  assert.match(sql, UNPARTITIONED_WINDOW_RE);
});

test("usageRecencyRankedSource appends extraProjectionSql to the inner projection", () => {
  const sql = usageRecencyRankedSource({
    fromSql: "FROM agent_component_session_usage acsu",
    partitionSql: "PARTITION BY pack_id",
    extraProjectionSql: ", ac.pack_id AS pack_id",
  });
  assert.match(sql, EXTRA_PROJECTION_RE);
});

// ---------------------------------------------------------------------------
// usageAggregateSql
// ---------------------------------------------------------------------------

test("usageAggregateSql has no WHERE clause for an unbounded window", () => {
  const { sql, params } = usageAggregateSql({});
  assert.doesNotMatch(sql, WHERE_CLAUSE_RE);
  assert.deepEqual(params, []);
});

test("usageAggregateSql adds the comparable-instant GLOB guard when a window is given", () => {
  const { sql, params } = usageAggregateSql({ start: "2026-06-01" });
  assert.match(sql, WHERE_CLAUSE_RE);
  assert.match(sql, GLOB_GUARD_RE);
  assert.deepEqual(params, ["2026-06-01T00:00:00.000Z"]);
});

test("usageAggregateSql splits usage recorded against two different version hashes into two rows", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "Read",
    versionHash: "hash-v1",
    invocations: 3,
  });
  await seedUsage(prisma, {
    sessionId: "s2",
    key: "Read",
    versionHash: "hash-v2",
    invocations: 5,
  });
  const rows = await runQuery(prisma, usageAggregateSql({}));
  assert.equal(rows.length, 2);
  const byHash = new Map(
    rows.map((row) => [row.component_version_hash, num(row.invocations)])
  );
  assert.equal(byHash.get("hash-v1"), 3);
  assert.equal(byHash.get("hash-v2"), 5);
});

test("usageAggregateSql sums invocations and counts distinct sessions for one identity/version across sessions", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "Bash",
    versionHash: "hash-a",
    invocations: 3,
  });
  await seedUsage(prisma, {
    sessionId: "s2",
    key: "Bash",
    versionHash: "hash-a",
    invocations: 5,
  });
  const rows = await runQuery(prisma, usageAggregateSql({}));
  assert.equal(rows.length, 1);
  assert.equal(num(rows[0].invocations), 8);
  assert.equal(num(rows[0].session_count), 2);
});

test("usageAggregateSql normalizes component_key case/whitespace when grouping", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "Reviewer",
    invocations: 2,
  });
  await seedUsage(prisma, {
    sessionId: "s2",
    key: " reviewer ",
    invocations: 4,
  });
  const rows = await runQuery(prisma, usageAggregateSql({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].component_key, "reviewer");
  assert.equal(num(rows[0].invocations), 6);
});

test("usageAggregateSql excludes usage outside the window and usage with no comparable instant", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "before",
    key: "Grep",
    invocations: 100,
    lastInvokedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "inside",
    key: "Grep",
    invocations: 7,
    lastInvokedAt: "2026-06-15T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "after",
    key: "Grep",
    invocations: 1000,
    lastInvokedAt: "2026-12-01T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "malformed",
    key: "Grep",
    invocations: 50,
    lastInvokedAt: "not-a-date",
  });
  const rows = await runQuery(
    prisma,
    usageAggregateSql({
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-30T00:00:00.000Z",
    })
  );
  assert.equal(rows.length, 1);
  assert.equal(num(rows[0].invocations), 7);
});

test("usageAggregateSql picks the true latest last_invoked_at among mixed timestamp forms", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s-offset",
    key: "Read",
    lastInvokedAt: OFFSET_FORM_LATEST,
  });
  await seedUsage(prisma, {
    sessionId: "s-whole",
    key: "Read",
    lastInvokedAt: WHOLE_SECOND_EARLIEST,
  });
  await seedUsage(prisma, {
    sessionId: "s-sub",
    key: "Read",
    lastInvokedAt: SUBSECOND_MIDDLE,
  });
  const rows = await runQuery(prisma, usageAggregateSql({}));
  assert.equal(rows.length, 1);
  // Bare column beside the MAX aggregate: the RAW text of the winning row,
  // not the canonical form the sort key ranked on.
  assert.equal(rows[0].last_invoked_at, OFFSET_FORM_LATEST);
});

// ---------------------------------------------------------------------------
// usageSessionIdsSql
// ---------------------------------------------------------------------------

test("usageSessionIdsSql groups by kind, normalized key, version hash, and session", () => {
  const { sql } = usageSessionIdsSql({});
  assert.match(sql, GROUP_BY_KIND_RE);
  const groupBy = groupByClauseOf(sql);
  assert.notEqual(groupBy, "", "statement must have a GROUP BY clause");
  assert.match(groupBy, VERSION_HASH_COLUMN_RE);
  assert.match(groupBy, SESSION_ID_COLUMN_RE);
});

test("usageSessionIdsSql keeps one session's two version hashes as SEPARATE rows (FEA-3982 per-version dedup)", async () => {
  const prisma = await openStore();
  // One session, one component, two versions of it. The rows differ by
  // git_branch because that column is part of the table's unique key, and
  // git_branch is NOT in the GROUP BY — so this is also the case that proves
  // the version hash survives the git-branch collapse the sibling test pins.
  // Dropping `component_version_hash` from the GROUP BY collapses these to a
  // single row carrying an arbitrary hash, which is the mutation the matcher
  // above cannot see and this case does.
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "Reviewer",
    gitBranch: "main",
    versionHash: "hash-a",
  });
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "Reviewer",
    gitBranch: "feature/x",
    versionHash: "hash-b",
  });

  const rows = await runQuery(prisma, usageSessionIdsSql({}));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.component_version_hash).sort(), [
    "hash-a",
    "hash-b",
  ]);
  assert.deepEqual([...new Set(rows.map((r) => r.session_id))], ["s1"]);
});

test("usageSessionIdsSql collapses multiple git-branch buckets for one session into a single row", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "Edit",
    gitBranch: "main",
  });
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "Edit",
    gitBranch: "feature/x",
  });
  const rows = await runQuery(prisma, usageSessionIdsSql({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, "s1");
});

test("usageSessionIdsSql applies the window to exclude out-of-range sessions", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "in-window",
    key: "Edit",
    lastInvokedAt: "2026-06-15T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "out-of-window",
    key: "Edit",
    lastInvokedAt: "2026-01-01T00:00:00.000Z",
  });
  const rows = await runQuery(
    prisma,
    usageSessionIdsSql({
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-30T00:00:00.000Z",
    })
  );
  assert.deepEqual(
    rows.map((row) => row.session_id),
    ["in-window"]
  );
});

// ---------------------------------------------------------------------------
// unresolvedUsageAggregateSql
// ---------------------------------------------------------------------------

test("unresolvedUsageAggregateSql projects a harness CASE and both MIN/MAX bound columns", () => {
  const { sql } = unresolvedUsageAggregateSql({});
  assert.match(sql, HARNESS_CASE_RE);
  assert.match(sql, FIRST_SEEN_MIN_RE);
  assert.match(sql, LAST_SEEN_MAX_RE);
});

test("unresolvedUsageAggregateSql collapses two distinct harnesses on one identity to 'both'", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "unresolved-tool",
    harness: "claude",
  });
  await seedUsage(prisma, {
    sessionId: "s2",
    key: "unresolved-tool",
    harness: "codex",
  });
  const rows = await runQuery(prisma, unresolvedUsageAggregateSql({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].harness, "both");
});

test("unresolvedUsageAggregateSql keeps a single harness as-is", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s1",
    key: "single-harness-tool",
    harness: "claude",
  });
  await seedUsage(prisma, {
    sessionId: "s2",
    key: "single-harness-tool",
    harness: null,
  });
  const rows = await runQuery(prisma, unresolvedUsageAggregateSql({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].harness, "claude");
});

test("unresolvedUsageAggregateSql computes the canonical MIN(first_seen_at) and MAX(last_seen_at) across mixed timestamp forms", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "s-offset",
    key: "recency-bounds",
    firstInvokedAt: OFFSET_FORM_LATEST,
    lastInvokedAt: OFFSET_FORM_LATEST,
  });
  await seedUsage(prisma, {
    sessionId: "s-whole",
    key: "recency-bounds",
    firstInvokedAt: WHOLE_SECOND_EARLIEST,
    lastInvokedAt: WHOLE_SECOND_EARLIEST,
  });
  await seedUsage(prisma, {
    sessionId: "s-sub",
    key: "recency-bounds",
    firstInvokedAt: SUBSECOND_MIDDLE,
    lastInvokedAt: SUBSECOND_MIDDLE,
  });
  const rows = await runQuery(prisma, unresolvedUsageAggregateSql({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_seen_at, CANONICAL_EARLIEST);
  assert.equal(rows[0].last_seen_at, CANONICAL_LATEST);
});

test("unresolvedUsageAggregateSql applies the same window predicate as the resolved aggregate", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    sessionId: "in-window",
    key: "windowed-unresolved",
    invocations: 9,
    lastInvokedAt: "2026-06-15T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "out-of-window",
    key: "windowed-unresolved",
    invocations: 900,
    lastInvokedAt: "2026-01-01T00:00:00.000Z",
  });
  const rows = await runQuery(
    prisma,
    unresolvedUsageAggregateSql({
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-30T00:00:00.000Z",
    })
  );
  assert.equal(rows.length, 1);
  assert.equal(num(rows[0].invocations), 9);
});

// ---------------------------------------------------------------------------
// pluginUsageSql
// ---------------------------------------------------------------------------

test("pluginUsageSql joins live plugin-child inventory with a pack-id/kind allowlist scope", () => {
  const { sql } = pluginUsageSql({});
  assert.match(sql, INNER_JOIN_RE);
  assert.match(sql, PACK_ID_NOT_NULL_RE);
  assert.match(sql, UNINSTALLED_NULL_RE);
  assert.match(sql, KIND_ALLOWLIST_RE);
});

test("pluginUsageSql joins usage to inventory case/whitespace-insensitively via the natural key", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    id: "child-1",
    kind: "skill",
    key: "Reviewer",
    packId: "pack-A",
  });
  await seedUsage(prisma, {
    sessionId: "s1",
    kind: "skill",
    key: "reviewer",
    invocations: 4,
  });
  const rows = await runQuery(prisma, pluginUsageSql({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pack_id, "pack-A");
  assert.equal(num(rows[0].invocations), 4);
});

test("pluginUsageSql excludes a tombstoned (uninstalled) child from the plugin rollup", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    id: "child-2",
    kind: "skill",
    key: "gone",
    packId: "pack-B",
    uninstalledAt: "2026-06-01T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "s1",
    kind: "skill",
    key: "gone",
    invocations: 4,
  });
  const rows = await runQuery(prisma, pluginUsageSql({}));
  assert.deepEqual(
    rows.filter((row) => row.pack_id === "pack-B"),
    []
  );
});

test("pluginUsageSql's authoritative-FK guard excludes usage explicitly linked to a different component", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    id: "comp-target",
    kind: "skill",
    key: "cmdy",
    packId: "pack-D",
  });
  await seedComponent(prisma, {
    id: "comp-other",
    kind: "skill",
    key: "unrelated",
    packId: null,
  });
  // Correctly-linked control row: null FK, matches by natural key.
  await seedUsage(prisma, {
    sessionId: "s-control",
    kind: "skill",
    key: "cmdy",
    invocations: 2,
    agentComponentId: null,
  });
  // Mismatched-FK row: natural key matches comp-target, but the row's own
  // agent_component_id points elsewhere, so the authoritative guard excludes
  // it rather than falling back to the natural-key join.
  await seedUsage(prisma, {
    sessionId: "s-guarded",
    kind: "skill",
    key: "cmdy",
    invocations: 99,
    agentComponentId: "comp-other",
  });
  const rows = await runQuery(prisma, pluginUsageSql({}));
  const packD = rows.find((row) => row.pack_id === "pack-D");
  assert.ok(packD);
  assert.equal(num(packD?.invocations), 2);
});

test("pluginUsageSql applies the window predicate inside the join's WHERE", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    id: "child-3",
    kind: "command",
    key: "windowed",
    packId: "pack-E",
  });
  await seedUsage(prisma, {
    sessionId: "in-window",
    kind: "command",
    key: "windowed",
    invocations: 6,
    lastInvokedAt: "2026-06-15T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "out-of-window",
    kind: "command",
    key: "windowed",
    invocations: 600,
    lastInvokedAt: "2026-01-01T00:00:00.000Z",
  });
  const rows = await runQuery(
    prisma,
    pluginUsageSql({
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-30T00:00:00.000Z",
    })
  );
  const packE = rows.find((row) => row.pack_id === "pack-E");
  assert.ok(packE);
  assert.equal(num(packE?.invocations), 6);
});

// ---------------------------------------------------------------------------
// pluginUsageSessionIdsSql
// ---------------------------------------------------------------------------

test("pluginUsageSessionIdsSql dedups to one (pack, session) row across multiple child keys", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    id: "child-4",
    kind: "skill",
    key: "alpha",
    packId: "pack-F",
  });
  await seedComponent(prisma, {
    id: "child-5",
    kind: "skill",
    key: "beta",
    packId: "pack-F",
  });
  await seedUsage(prisma, {
    sessionId: "s1",
    kind: "skill",
    key: "alpha",
    invocations: 1,
  });
  await seedUsage(prisma, {
    sessionId: "s1",
    kind: "skill",
    key: "beta",
    invocations: 1,
    gitBranch: "other-branch",
  });
  const rows = await runQuery(prisma, pluginUsageSessionIdsSql({}));
  const packFRows = rows.filter((row) => row.pack_id === "pack-F");
  assert.equal(packFRows.length, 1);
  assert.equal(packFRows[0].session_id, "s1");
});

// ---------------------------------------------------------------------------
// PLUGIN_USAGE_SESSIONS_SQL
// ---------------------------------------------------------------------------

test("PLUGIN_USAGE_SESSIONS_SQL sums invocations per session and orders by recency, tie-broken by session id", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    id: "child-6",
    kind: "skill",
    key: "ordered",
    packId: "pack-Z",
  });
  await seedUsage(prisma, {
    sessionId: "s-c",
    kind: "skill",
    key: "ordered",
    invocations: 2,
    lastInvokedAt: "2026-06-20T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "s-a",
    kind: "skill",
    key: "ordered",
    invocations: 5,
    lastInvokedAt: "2026-06-10T00:00:00.000Z",
  });
  await seedUsage(prisma, {
    sessionId: "s-b",
    kind: "skill",
    key: "ordered",
    invocations: 3,
    lastInvokedAt: "2026-06-10T00:00:00.000Z",
  });
  const rows = await runRaw(prisma, PLUGIN_USAGE_SESSIONS_SQL, "pack-Z");
  assert.deepEqual(
    rows.map((row) => [row.session_id, num(row.invocation_count)]),
    [
      ["s-c", 2],
      ["s-a", 5],
      ["s-b", 3],
    ]
  );
});

test("PLUGIN_USAGE_SESSIONS_SQL scopes strictly to the requested pack id", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    id: "child-7",
    kind: "skill",
    key: "scoped",
    packId: "pack-scoped",
  });
  await seedUsage(prisma, {
    sessionId: "s1",
    kind: "skill",
    key: "scoped",
    invocations: 4,
  });
  const rows = await runRaw(prisma, PLUGIN_USAGE_SESSIONS_SQL, "pack-other");
  assert.deepEqual(rows, []);
});
