/**
 * @file agent-dashboard-local-read-ipc-coercion.test.ts
 * @description ISS-7979: diagnostics IPC compatibility coverage, including a
 * real diagnostics-store proof that activity coverage is read only on explicit
 * true.
 *
 * ISS-7037 adds the connection-seam proof: every diagnostics raw read dispatches
 * through `prisma.read` onto the reader pool, and NOTHING in the payload touches
 * the PRIMARY/writer client. The fake's writer raw hatch therefore throws rather
 * than returning `[]`, so a read that regresses back onto `prisma.client` fails
 * here instead of silently re-contending with the backfill's write queue.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { registerLocalDashboardReadIpcHandlers } from "../src/main/dashboard/agent-dashboard-local-read-ipc.js";
import { getDiagnosticsData } from "../src/main/database/diagnostics-store.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

const EVENT = { sender: {} };

afterEach(() => {
  resetElectronModuleStub();
});

describe("diagnostics local-read IPC coercion", () => {
  test("the real registrar strips additive and malformed request fields", async () => {
    const getData = vi.fn(async (request: unknown) => request);
    registerLocalDashboardReadIpcHandlers({
      withDb: passthroughWithDb({
        diagnostics: { getData },
      } as unknown as DbHostAgentDatabase),
      invokeStoreOp: noStoreOp,
    });
    const invoke = registeredInvokeHandler("desktop:db:get-diagnostics");

    assert.deepEqual(
      await invoke(EVENT, {
        includeActivityCoverage: true,
        newerRendererField: "ignored",
      }),
      { includeActivityCoverage: true }
    );
    assert.deepEqual(await invoke(EVENT, { includeActivityCoverage: false }), {
      includeActivityCoverage: false,
    });
    for (const malformed of [
      { includeActivityCoverage: "true" },
      [],
      "request",
      null,
      undefined,
    ]) {
      assert.deepEqual(await invoke(EVENT, malformed), {});
    }

    assert.deepEqual(
      getData.mock.calls.map(([request]) => request),
      [
        { includeActivityCoverage: true },
        { includeActivityCoverage: false },
        {},
        {},
        {},
        {},
        {},
      ]
    );
  });

  test("the real store reads activity coverage only for an explicit true", async () => {
    const { prisma, activityReads } = recordingDiagnosticsPrisma();

    const included = (await getDiagnosticsData(prisma, {
      includeActivityCoverage: true,
    })) as Record<string, unknown>;
    assert.equal(Object.hasOwn(included, "activityCoverage"), true);
    assert.equal(
      (
        included.activityCoverage as {
          overall: { sessionCount: number };
        }
      ).overall.sessionCount,
      1
    );
    assert.equal(activityReads(), 1);

    const excluded = (await getDiagnosticsData(prisma, {
      includeActivityCoverage: false,
    })) as Record<string, unknown>;
    const omitted = (await getDiagnosticsData(prisma)) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(excluded, "activityCoverage"), false);
    assert.equal(Object.hasOwn(omitted, "activityCoverage"), false);
    assert.equal(activityReads(), 1);
  });

  test("ISS-7037: every diagnostics raw read runs on the reader pool, none on the writer", async () => {
    const { prisma, dispatches, pooledSql, writerReads } =
      recordingDiagnosticsPrisma();

    const data = await getDiagnosticsData(prisma, {
      includeActivityCoverage: true,
    });

    // Both directions of the seam. Zero writer reads is the half that regresses
    // silently — a `prisma.client.$queryRawUnsafe` still returns rows, just from
    // the connection that owns sync durability.
    assert.equal(writerReads(), 0);
    assert.deepEqual(pooledSql().map(sqlTarget).sort(), [
      "artifact_link_backfill_seen",
      "repos",
      "session_activity_metrics",
      "session_artifact_links",
      "session_artifact_links",
    ]);
    // Every routed read still maps into its own field — the routing change is
    // not paid for with a dropped, crossed, or zeroed one.
    assert.deepEqual(data.repos, [
      {
        id: "repo-1",
        gitDir: "/tmp/repo/.git",
        remoteUrl: "https://github.com/acme/repo.git",
        repoFullName: "acme/repo",
        defaultBranch: "main",
        lastSeenAt: "2026-01-02T03:04:05.000Z",
        worktreeCount: 3,
      },
    ]);
    assert.deepEqual(data.backfill, {
      artifactLinks: {
        totalScanned: 7,
        lastScannedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.deepEqual(data.linkStats, [
      { relation: "implements", method: "branch", count: 5 },
    ]);
    assert.deepEqual(data.linkTotals, {
      totalLinks: 9,
      linkedSessions: 4,
      linkedArtifacts: 2,
    });
    // Per-aggregate dispatch, not one reader held for the batch: the five raw
    // statements above plus the two typed withheld reads that were already
    // pooled, each on its own `prisma.read`. Collapsing them onto one dispatch
    // would pin a pool slot for the whole poll — see `queryLinkStats`.
    assert.equal(dispatches(), 7);
  });
});

const SQL_FROM_TABLE = /FROM\s+([a-z_]+)/;

/**
 * The first table a diagnostics statement reads, as its routing fingerprint.
 * A statement with no recognizable `FROM` falls back to the whole SQL so the
 * caller's assertion reports it rather than this helper swallowing it.
 */
function sqlTarget(sql: string): string {
  return SQL_FROM_TABLE.exec(sql)?.[1] ?? sql;
}

function passthroughWithDb(agentDatabase: DbHostAgentDatabase): WithDb {
  return (handler) =>
    (_event, ...args) =>
      Promise.resolve(handler(agentDatabase, ...args));
}

const ACTIVITY_COVERAGE_ROW = {
  harness: "codex",
  autonomy_band: "agentic",
  closedloop_user: 1,
  formula_offset: 0,
  length_band: "short",
  covered_spend_usd: 2,
  total_spend_usd: 4,
  spend_low_conf_usd: 1,
  spend_medium_conf_usd: 1,
  spend_high_conf_usd: 2,
  session_count: 1,
};

/**
 * One row per pooled diagnostics statement, keyed by {@link sqlTarget}. The two
 * `session_artifact_links` statements share a key, so their rows are told apart
 * by column shape — which is also what proves each one's mapping.
 */
const DIAGNOSTICS_ROWS: Record<string, unknown[]> = {
  repos: [
    {
      id: "repo-1",
      git_dir: "/tmp/repo/.git",
      // The credentials must not survive into the payload — `sanitizeRemoteUrl`.
      remote_url: "https://user:secret@github.com/acme/repo.git?token=t#frag",
      repo_full_name: "acme/repo",
      default_branch: "main",
      last_seen_at: "2026-01-02T03:04:05.000Z",
      worktree_count: 3,
    },
  ],
  artifact_link_backfill_seen: [
    { total_scanned: 7, last_scanned_at: "2026-01-01T00:00:00.000Z" },
  ],
  session_artifact_links: [
    { relation: "implements", method: "branch", count: 5 },
    { total_links: 9, linked_sessions: 4, linked_artifacts: 2 },
  ],
};

function recordingDiagnosticsPrisma(): {
  prisma: DesktopPrisma;
  activityReads: () => number;
  dispatches: () => number;
  pooledSql: () => string[];
  writerReads: () => number;
} {
  let activityReadCount = 0;
  let writerReadCount = 0;
  let dispatchCount = 0;
  const pooled: string[] = [];
  const reader = {
    opencodeWithheldSubagentRoot: {
      findMany: () => Promise.resolve([]),
    },
    opencodeWithheldScan: {
      findMany: () => Promise.resolve([]),
    },
    $queryRawUnsafe: (sql: string) => {
      pooled.push(sql);
      if (sql.includes("FROM session_activity_metrics")) {
        activityReadCount += 1;
        return Promise.resolve([ACTIVITY_COVERAGE_ROW]);
      }
      // A non-empty row per statement, so an assertion on the mapped payload
      // pins the mapping rather than agreeing with an empty result by default.
      const isStats = sql.includes("GROUP BY relation, method");
      const rows = DIAGNOSTICS_ROWS[sqlTarget(sql)] ?? [];
      return Promise.resolve(
        rows.filter((row) => Object.hasOwn(row as object, "count") === isStats)
      );
    },
  };
  const prisma = {
    client: {
      $queryRawUnsafe: (sql: string) => {
        writerReadCount += 1;
        throw new Error(`diagnostics read on the writer connection: ${sql}`);
      },
    },
    read: <T>(run: (client: typeof reader) => Promise<T>) => {
      dispatchCount += 1;
      return run(reader);
    },
  } as unknown as DesktopPrisma;
  return {
    prisma,
    activityReads: () => activityReadCount,
    dispatches: () => dispatchCount,
    pooledSql: () => [...pooled],
    writerReads: () => writerReadCount,
  };
}

/** The diagnostics channel driven here never reaches a store op. */
function noStoreOp(): Promise<unknown> {
  return Promise.reject(new Error("no store op on this channel"));
}
