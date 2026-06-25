import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BranchStatus, encodeBranchId } from "@repo/api/src/types/branch.js";
import type { SyncedAgentSession } from "../src/main/agent-session-sync-contract.js";
import {
  type BranchSyncSource,
  getSharedBranchAnalytics,
  getSharedBranchDetail,
  getSharedBranches,
  getSharedBranchUsage,
} from "../src/main/shared-branches-api.js";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";

type CannedRows = {
  links?: Record<string, unknown>[];
  prs?: Record<string, unknown>[];
  /** PRD-486: rows for the branch commit read (kind='commit' join). */
  commits?: Record<string, unknown>[];
  tokenAgg?: Record<string, unknown>[];
  usageTokens?: Record<string, unknown>[];
  usageEvents?: Record<string, unknown>[];
  /** D1: when present, wires a fake `syncSource.loadSyncedSessions`. */
  sessions?: SyncedAgentSession[];
};

const SQL_SECRET = /SELECT|secret/;
const KIND_BRANCH_RE = /kind = 'branch'/;

/** snake_case canned token → the `bigint` the typed Prisma delegate surfaces. */
const big = (value: unknown): bigint => {
  if (typeof value === "string") {
    return BigInt(value);
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "bigint") {
    return value;
  }
  return 0n;
};

/**
 * A `BranchSyncSource` whose `prisma.client` serves canned rows. FEA-1791: the
 * B1 branch reads run on the single Prisma client (not the raw `storeDb`
 * handle). Three are now TYPED delegates (`sessionArtifactLink.findMany`,
 * `artifact.findMany`, `tokenUsage.findMany`); the rest stay raw on
 * `$queryRawUnsafe` (row array, no `{ rows }` envelope). The canned rows are
 * authored once in snake_case (the DB-column shape) and translated here into the
 * Prisma RESULT shape each typed read maps, so the real read mapping — incl. the
 * `activityAt` COALESCE and the bigint→number token coercion — is exercised.
 * `onQuery` fires for EVERY read (typed + raw) so the count / guard tests still
 * see one signal per read.
 */
function makeSource(
  rows: CannedRows,
  onQuery?: (sql: string) => void
): BranchSyncSource {
  // Typed link read: session_artifact_links → branch artifact + session. Serves
  // both the link read and the usage read's first query (`distinct: ['sessionId']`
  // selecting `session.billingMode`). The canned `activity_at` is surfaced as
  // `ended_at` so the read's `endedAt ?? startedAt ?? observedAt` COALESCE
  // reproduces it; `billing_mode` (a per-session column) is authored on the link
  // row and feeds the usage read's session→billing scope.
  const sessionArtifactLink = {
    findMany: (args?: { distinct?: string[] }) => {
      onQuery?.("links");
      const mapped = (rows.links ?? []).map((r) => ({
        sessionId: r.session_id,
        isPrimary: r.is_primary,
        observedAt: r.observed_at,
        artifact: {
          repoFullName: r.repo_full_name,
          branchName: r.branch_name,
          linesAdded: r.lines_added ?? null,
          linesRemoved: r.lines_removed ?? null,
          filesChanged: r.files_changed ?? null,
        },
        session: {
          endedAt: r.activity_at ?? null,
          startedAt: null,
          billingMode: r.billing_mode ?? null,
        },
      }));
      if (args?.distinct?.includes("sessionId")) {
        const seen = new Set<unknown>();
        return Promise.resolve(
          mapped.filter((m) => {
            if (seen.has(m.sessionId)) {
              return false;
            }
            seen.add(m.sessionId);
            return true;
          })
        );
      }
      return Promise.resolve(mapped);
    },
  };
  // Typed distinct-key read: branch artifacts deduped by (repo, branch) — the
  // mock collapses the canned link rows the way the engine's `distinct` would.
  const artifact = {
    findMany: () => {
      onQuery?.("distinctKeys");
      const seen = new Set<string>();
      const keys: { repoFullName: unknown; branchName: unknown }[] = [];
      for (const r of rows.links ?? []) {
        const dedupeKey = JSON.stringify([r.repo_full_name, r.branch_name]);
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        keys.push({
          repoFullName: r.repo_full_name,
          branchName: r.branch_name,
        });
      }
      return Promise.resolve(keys);
    },
  };
  // Typed usage-token read (step 2): token_usage keyed by `sessionId IN (…)`.
  // The mock honors the `in` filter so it reproduces the read's scope; billing
  // mode is NOT here — the read joins it from step 1 (the link relation).
  const tokenUsage = {
    findMany: (args?: { where?: { sessionId?: { in?: unknown[] } } }) => {
      onQuery?.("usageTokens");
      const ids = args?.where?.sessionId?.in;
      const idSet = Array.isArray(ids) ? new Set(ids) : null;
      return Promise.resolve(
        (rows.usageTokens ?? [])
          .filter((r) => (idSet ? idSet.has(r.session_id) : true))
          .map((r) => ({
            sessionId: r.session_id,
            model: r.model,
            inputTokens: big(r.input_tokens),
            outputTokens: big(r.output_tokens),
            cacheReadTokens: big(r.cache_read_tokens),
            cacheWriteTokens: big(r.cache_write_tokens),
            createdAt: r.created_at ?? null,
            costUsdEstimated: r.cost_usd_estimated ?? null,
          }))
      );
    },
  };
  const queryRaw = (sql: string) => {
    onQuery?.(sql);
    // PRD-486 commit read — most specific first: it also reads
    // `session_artifact_links` but joins a `kind = 'commit'` artifact.
    if (sql.includes("kind = 'commit'")) {
      return Promise.resolve(rows.commits ?? []);
    }
    if (sql.includes("FROM pull_requests")) {
      return Promise.resolve(rows.prs ?? []);
    }
    if (sql.includes("GROUP BY l.repo_full_name")) {
      return Promise.resolve(rows.tokenAgg ?? []);
    }
    if (sql.includes("FROM token_events")) {
      return Promise.resolve(rows.usageEvents ?? []);
    }
    throw new Error(`unexpected SQL in test: ${sql.slice(0, 60)}`);
  };
  const sessions = rows.sessions;
  const syncSource = sessions
    ? {
        loadSyncedSessions: (ids: string[]) =>
          sessions.filter((session) => ids.includes(session.externalSessionId)),
      }
    : undefined;
  return {
    prisma: {
      client: {
        sessionArtifactLink,
        artifact,
        tokenUsage,
        $queryRawUnsafe: queryRaw,
      },
    },
    syncSource,
  } as unknown as BranchSyncSource;
}

/** Minimal `SyncedAgentSession` for the D1 detail-enrichment tests. */
const syncedSession = (
  over: Partial<SyncedAgentSession> & { externalSessionId: string }
): SyncedAgentSession =>
  ({
    externalSessionId: over.externalSessionId,
    name: null,
    status: "completed",
    harness: "claude",
    model: "claude-sonnet-4-5",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T10:00:00.000Z",
    endedAt: null,
    metadata: null,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...over,
  }) as SyncedAgentSession;

// Every read — typed delegate OR raw — throws an SQL-shaped secret, so whichever
// read a serving op issues first proves the boundary sanitizes it to a code-only
// error (no SQL leak), independent of which read now runs first.
const throwSecret = () => {
  throw new Error("SELECT secret_column FROM secret_table");
};
const throwingSource = {
  prisma: {
    client: new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "$queryRawUnsafe" ? throwSecret : { findMany: throwSecret },
      }
    ),
  },
} as unknown as BranchSyncSource;

const link = (over: Record<string, unknown>) => ({
  repo_full_name: "acme/web",
  branch_name: "feature/x",
  session_id: "s1",
  is_primary: true,
  observed_at: "2026-06-10T10:00:00.000Z",
  // Real session last-activity time (COALESCE(ended_at, started_at, observed_at)
  // in the read). Defaults to the observed time; FEA-2022 cases override it.
  activity_at: "2026-06-10T10:00:00.000Z",
  ...over,
});

// PRD-486: one row of the branch commit read (kind='commit' joined via session).
const commit = (over: Record<string, unknown>) => ({
  repo_full_name: "acme/web",
  branch_name: "feature/x",
  sha: "abc1234def5678",
  committed_at: "2026-06-12T08:00:00.000Z",
  message: "Do the thing",
  ...over,
});

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

  test("lastActivityAt reflects the session's activity time, not the link scan time (FEA-2022)", async () => {
    // The importer stamps `observed_at` with wall-clock scan time, so it reads
    // ~now on every re-import. The branch's last activity must instead reflect
    // the linked session's real activity (`activity_at`) — here, ~5 weeks earlier.
    // INTERIM (PLN-1034): the cloud excludes session activity, but the desktop
    // has no local commit/PR signal until PRD-486, so it still ages by sessions.
    const source = makeSource({
      links: [
        link({
          observed_at: "2026-06-19T09:00:00.000Z",
          activity_at: "2026-05-15T12:00:00.000Z",
        }),
      ],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "2026-05-15T12:00:00.000Z");
  });

  test("lastActivityAt takes the latest activity across sessions by instant (FEA-2022)", async () => {
    // Two sessions on one branch; the newer activity wins even when its
    // `observed_at` is older and the timestamps differ in zone/precision (so a
    // raw string max would mis-rank them).
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
    assert.equal(row.lastActivityAt, "2026-06-02T05:30:00-04:00");
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

  test("lastActivityAt falls back to session activity with no commit/PR signal (PRD-486)", async () => {
    const source = makeSource({
      links: [link({ activity_at: "2026-05-15T12:00:00.000Z" })],
      commits: [],
    });
    const [row] = (await getSharedBranches(source)).items;
    assert.equal(row.lastActivityAt, "2026-05-15T12:00:00.000Z");
  });

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
    assert.equal(row.prState, "MERGED");
    assert.equal(row.status, BranchStatus.Merged);
  });

  test("literal 'merged' state without merged_at still maps to MERGED", async () => {
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
    assert.equal(row.prState, "MERGED");
    assert.equal(row.status, BranchStatus.Merged);
  });

  test("null PR state (lifecycle not captured) → OPEN", async () => {
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
    assert.equal(row.prState, "OPEN");
    assert.equal(row.status, BranchStatus.Open);
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
    // The PR number is still shown; only the lifecycle is left indeterminate.
    assert.equal(row.prNumber, 12);
    assert.equal(row.status, BranchStatus.Draft);
  });

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

  test(">1 distinct linked PR → multiPrWarning true, newest PR displayed", async () => {
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
    assert.equal(row.prNumber, 42);
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
          // Captured cost_usd_estimated — the per-branch cost mirrors this stored
          // value (dashboard basis), it is NOT re-derived from the token counts.
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

  test("O(grouped): issues exactly 4 reads regardless of branch count", async () => {
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
    // links + PRs + token aggregate + commits (PRD-486) — no per-branch fan-out.
    assert.equal(count, 4);
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
    // Sorted newest-first (a, b, c by observed_at desc) → offset 1 is "b".
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

  test("unsafe persisted token counts fail through the sanitized source boundary", async () => {
    const source = makeSource({
      links: [link({ branch_name: "a", session_id: "unsafe-s1" })],
      usageTokens: [
        {
          session_id: "unsafe-s1",
          model: "unknown-model",
          input_tokens: "9007199254740992",
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-10T10:00:00.000Z",
        },
      ],
    });

    await assert.rejects(
      () => getSharedBranchUsage(source),
      (error) =>
        error instanceof Error &&
        error.message === SHARED_BRANCHES_SOURCE_ERROR_CODE
    );
  });

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
});

describe("getSharedBranchDetail (Epic C detail projection)", () => {
  test("null for a missing source, a non-string id, or an empty id", async () => {
    assert.equal(await getSharedBranchDetail(null, "x"), null);
    assert.equal(await getSharedBranchDetail(makeSource({}), "x"), null);
    assert.equal(
      await getSharedBranchDetail(makeSource({}), 123 as unknown as string),
      null
    );
    assert.equal(await getSharedBranchDetail(makeSource({}), ""), null);
  });

  test("null when the id matches no local branch", async () => {
    const source = makeSource({ links: [link({ branch_name: "feature/x" })] });
    const missingId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "does-not-exist",
    });
    assert.equal(await getSharedBranchDetail(source, missingId), null);
  });

  test("no session loader → graceful spine fallback (null/0 usage, empty trace)", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "feature/x", session_id: "s1", is_primary: true }),
        link({
          branch_name: "feature/x",
          session_id: "s2",
          is_primary: false,
          observed_at: "2026-06-10T09:00:00.000Z",
        }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: "https://gh/acme/web/pull/42",
          title: "Add X",
          state: "closed",
          merged_at: "2026-06-12T10:00:00.000Z",
          closed_at: "2026-06-12T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const id = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/x",
    });
    const detail = await getSharedBranchDetail(source, id);
    assert.ok(detail, "expected a non-null detail");
    assert.equal(detail.id, id);
    assert.equal(detail.branchName, "feature/x");
    assert.equal(detail.prNumber, 42);
    assert.equal(detail.status, BranchStatus.Merged);
    // Real PR-derived detail fields.
    assert.deepEqual(detail.linkedPrNumbers, [42]);
    assert.equal(detail.mergedAt, "2026-06-12T10:00:00.000Z");
    assert.equal(detail.closedAt, "2026-06-12T10:00:00.000Z");
    // Sessions spine: every linked session, primary flag preserved.
    assert.deepEqual(
      detail.sessions.map((session) => session.sessionId).sort(),
      ["s1", "s2"]
    );
    assert.equal(
      detail.sessions.find((session) => session.sessionId === "s1")?.isPrimary,
      true
    );
    // Deferred enrichment degrades to null/[]/0 — never fabricated.
    assert.equal(detail.prBody, null);
    assert.equal(detail.headSha, null);
    assert.equal(detail.mergeCommitSha, null);
    assert.deepEqual(detail.mergedTrace, []);
    assert.equal(detail.sessions[0]?.inputTokens, 0);
    assert.equal(detail.sessions[0]?.estimatedCostUsd, null);
  });

  test("detail exposes commits[] (oldest-first) + openedAt (PRD-486)", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      // Returned newest-first by the fake; the projection must re-sort ascending.
      commits: [
        commit({
          sha: "newsha9999999",
          committed_at: "2026-06-12T08:00:00.000Z",
          message: "Second",
        }),
        commit({
          sha: "oldsha1111111",
          committed_at: "2026-06-09T08:00:00.000Z",
          message: "First",
        }),
      ],
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
          opened_at: "2026-06-10T07:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const id = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/x",
    });
    const detail = await getSharedBranchDetail(source, id);
    assert.ok(detail, "expected a non-null detail");
    assert.equal(detail.openedAt, "2026-06-10T07:00:00.000Z");
    assert.deepEqual(detail.commits, [
      {
        sha: "oldsha1111111",
        committedAt: "2026-06-09T08:00:00.000Z",
        message: "First",
      },
      {
        sha: "newsha9999999",
        committedAt: "2026-06-12T08:00:00.000Z",
        message: "Second",
      },
    ]);
  });

  test("a read failure rethrows a sanitized, code-only error (no SQL leak)", async () => {
    await assert.rejects(
      getSharedBranchDetail(throwingSource, "x"),
      (err: Error) => {
        assert.equal(err.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
        assert.doesNotMatch(err.message, SQL_SECRET);
        return true;
      }
    );
  });
});

describe("getSharedBranchDetail (D1 enrichment)", () => {
  const idFeatureX = encodeBranchId({
    repoFullName: "acme/web",
    branchName: "feature/x",
  });

  test("hydrates per-session token splits + priced cost + name/harness", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "feature/x", session_id: "s1", is_primary: true }),
        link({
          branch_name: "feature/x",
          session_id: "s2",
          is_primary: false,
          observed_at: "2026-06-10T09:00:00.000Z",
        }),
      ],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          name: "Build the thing",
          harness: "claude",
          tokenUsageByModel: [
            {
              model: "claude-sonnet-4-5",
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
        syncedSession({
          externalSessionId: "s2",
          harness: "codex",
          tokenUsageByModel: [
            {
              model: "claude-sonnet-4-5",
              inputTokens: 200,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail, "expected a non-null detail");
    const s1 = detail.sessions.find((session) => session.sessionId === "s1");
    const s2 = detail.sessions.find((session) => session.sessionId === "s2");
    assert.equal(s1?.name, "Build the thing");
    assert.equal(s1?.harness, "claude");
    assert.equal(s1?.inputTokens, 1000);
    assert.equal(s1?.outputTokens, 500);
    assert.ok(
      (s1?.estimatedCostUsd ?? 0) > 0,
      "priced model → real per-session cost"
    );
    assert.equal(s2?.harness, "codex");
    assert.equal(s2?.inputTokens, 200);
    // Single PR across both sessions → one linked PR number, no warning.
    assert.equal(detail.multiPrWarning, false);
  });

  test("linkedArtifacts derive from the BRANCH NAME slug, ignoring noisy session prose refs", async () => {
    const branchName = "fea-1952-branches-epic-f";
    const id = encodeBranchId({ repoFullName: "acme/web", branchName });
    const source = makeSource({
      links: [link({ branch_name: branchName, session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          // A prose/MCP mention of an UNRELATED artifact — must NOT become a link.
          artifactRefs: [
            { slug: "PLN-988", isPrimary: false, method: "slug_in_message" },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, id);
    assert.ok(detail, "expected a non-null detail");
    // Only the branch's own slug (uppercased), not the prose-mentioned PLN-988.
    assert.deepEqual(detail.linkedArtifacts, [{ slug: "FEA-1952" }]);
  });

  test("branch name with no Closedloop slug → empty linkedArtifacts", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          artifactRefs: [
            { slug: "FEA-1952", isPrimary: false, method: "slug_in_message" },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.deepEqual(detail?.linkedArtifacts, []);
  });

  test("unpriced model → estimatedCostUsd null but tokens still summed", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          tokenUsageByModel: [
            {
              model: "totally-unknown-model",
              inputTokens: 42,
              outputTokens: 7,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    const s1 = detail?.sessions.find((session) => session.sessionId === "s1");
    assert.equal(s1?.estimatedCostUsd, null);
    assert.equal(s1?.inputTokens, 42);
    assert.equal(s1?.outputTokens, 7);
  });

  test(">1 distinct linked PR → multiPrWarning true, linkedPrNumbers length 2", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
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
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.equal(detail?.multiPrWarning, true);
    assert.equal(detail?.linkedPrNumbers.length, 2);
    assert.deepEqual([...(detail?.linkedPrNumbers ?? [])].sort(), [42, 43]);
  });

  test("null enrichment degrades to null, never 0 (LOC + base + GitHub fields)", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail);
    for (const field of [
      detail.additions,
      detail.deletions,
      detail.filesChanged,
      detail.baseBranch,
      detail.headSha,
      detail.mergeCommitSha,
      detail.prBody,
      detail.ahead,
      detail.behind,
      detail.checksStatus,
    ]) {
      assert.equal(field, null);
    }
  });

  test("mergedTrace: one sessionstart per session + a synthesized idle on a >=120s gap, each tagged", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "feature/x", session_id: "s1" }),
        link({ branch_name: "feature/x", session_id: "s2" }),
      ],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
        }),
        // 2h after s1 → a >= 120s gap between the two session-start markers.
        syncedSession({
          externalSessionId: "s2",
          startedAt: "2026-06-10T12:00:00.000Z",
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail);
    const trace = detail.mergedTrace;
    // Every item carries its sessionId.
    for (const item of trace) {
      assert.equal(typeof item.sessionId, "string");
    }
    // Exactly one sessionstart per session.
    const starts = trace.filter((item) => item.type === "sessionstart");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map((item) => item.sessionId).sort(), ["s1", "s2"]);
    // A synthesized idle marker on the >= 120s gap.
    const idles = trace.filter((item) => item.type === "idle");
    assert.ok(idles.length >= 1, "expected a synthesized idle marker");
    const idle = idles[0];
    assert.ok(idle && idle.type === "idle" && idle.gapMs >= 120_000);
    // Chronological: s1's start precedes s2's start.
    const startIndexes = trace
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.type === "sessionstart");
    const s1Index = startIndexes.find((e) => e.item.sessionId === "s1")?.index;
    const s2Index = startIndexes.find((e) => e.item.sessionId === "s2")?.index;
    assert.ok(s1Index != null && s2Index != null && s1Index < s2Index);
  });

  test("a session that does not hydrate keeps the honest link-row spine", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "feature/x", session_id: "s1" }),
        link({ branch_name: "feature/x", session_id: "s-missing" }),
      ],
      // Only s1 hydrates; s-missing is absent from the loader result.
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          tokenUsageByModel: [
            {
              model: "claude-sonnet-4-5",
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    const missing = detail?.sessions.find(
      (session) => session.sessionId === "s-missing"
    );
    assert.ok(missing, "the unhydrated session is still listed");
    assert.equal(missing.harness, "");
    assert.equal(missing.inputTokens, 0);
    assert.equal(missing.estimatedCostUsd, null);
  });

  test("enriched branch LOC flows through to the detail (FEA-1899)", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "feature/x",
          session_id: "s1",
          lines_added: 321,
          lines_removed: 12,
          files_changed: 7,
        }),
      ],
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail, "expected a non-null detail");
    assert.equal(detail.additions, 321);
    assert.equal(detail.deletions, 12);
    assert.equal(detail.filesChanged, 7);
  });
});

describe("getSharedBranchAnalytics (B6)", () => {
  test("analytics returns the empty canonical response for a missing source", async () => {
    assert.deepEqual(
      await getSharedBranchAnalytics(null),
      emptySharedBranchesAnalytics()
    );
  });

  test("analytics computes merge rate locally and gates GitHub-only KPIs", async () => {
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
    });
    const analytics = await getSharedBranchAnalytics(source);
    // 1 of 2 PR'd branches merged → 50%.
    assert.equal(analytics.mergeRate.state, "available");
    assert.equal(analytics.mergeRate.value, 50);
    // The merged branch has no LOC enrichment, so it folds in as a 0-line PR
    // (matching the dashboard's `?? 0` inclusion, FEA-2159) → median 0, available
    // rather than unavailable. GitHub-only PR counts stay gated.
    assert.equal(analytics.medianPrSize.state, "available");
    assert.equal(analytics.medianPrSize.value, 0);
    assert.equal(analytics.activePrCount.state, "gated");
    assert.equal(analytics.mergedCount.state, "gated");
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
    // Net LOC (200 − 50 = 150) over captured cost ($0.50) → 300 → available, > 0.
    assert.equal(analytics.locPerDollar.state, "available");
    assert.equal(analytics.locPerDollar.value, 300);
  });

  test("LOC-per-$ excludes the un-enriched-branch share of a mixed session (even-split)", async () => {
    // One session worked an ENRICHED branch (net LOC 100) AND an UN-enriched one
    // (unknown LOC). Its $1.00 is even-split across the 2 branches it touched, so
    // only the enriched half ($0.50) — the spend backed by known LOC — counts in
    // the denominator. Counting the full $1.00 would drag the un-enriched half
    // (no LOC to offset it) in and HALVE the ratio (100/$1 = 100 vs 100/$0.50 = 200).
    const source = makeSource({
      links: [
        link({
          branch_name: "enriched",
          session_id: "s1",
          lines_added: 150,
          lines_removed: 50,
          files_changed: 5,
        }),
        // Same session, a second branch with NO LOC enrichment (lines null).
        link({ branch_name: "unenriched", session_id: "s1" }),
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
    // Numerator = net LOC of the lone enriched branch (150 − 50 = 100); the
    // un-enriched branch contributes nothing. Denominator = $1.00 × 1/2 = $0.50.
    assert.equal(analytics.locPerDollar.state, "available");
    assert.equal(analytics.locPerDollar.value, 200);
    // Headline AI spend still counts the session's full cost ONCE (it isn't the
    // LOC-per-$ denominator — the apportionment only scopes the ratio).
    assert.equal(analytics.totalSpendUsd.state, "available");
    assert.equal(analytics.totalSpendUsd.value, 1.0);
  });

  test("LOC-per-$ counts a 0-LOC enriched branch but not an un-enriched one", async () => {
    // KNOWN-zero LOC (both line counts present, net 0) is included; UNKNOWN LOC
    // (un-enriched) is excluded. Session sZero works a 0-LOC enriched branch;
    // session sUnknown works only an un-enriched branch. Only sZero's spend may
    // enter the denominator — and with net LOC 0 across the enriched set the
    // ratio is 0, NOT a fabricated value from the un-enriched session's $.
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
    // Enriched set = {zero-loc}, net LOC 0, denominator $0.40 → 0 / 0.40 = 0.
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
});
