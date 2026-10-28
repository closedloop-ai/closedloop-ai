import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-conform";
import { SESSION_LIST_PARITY_EVIDENCE_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-evidence";
import type { SessionListParityRow } from "@repo/lib/sessions/__tests__/session-list-parity-model";
import { describe, expect, it, vi } from "vitest";
import { sharedAgentSessionsListRequestSchema } from "../../shared/shared-agent-sessions-contract-schema.js";
import {
  type AgentSessionUsageAggregateFilters,
  SessionListCursorSortKey,
} from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { SESSION_COMPACT_FILTER_VERSION } from "../agent-sync/session-compact-filter-capabilities.js";
import { syncedSessionIsSubstantive } from "../agent-sync/synced-session-substantive.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../dashboard/agent-dashboard-runtime-options.js";
import { readAgentDashboardSessionList } from "../dashboard/agent-dashboard-session-list-projection.js";
import { readNarrowedUsageRows } from "../database/session-narrowed-usage-query.js";
import { sessionQualitySqlPredicate } from "../database/session-quality-sql.js";
import { openSqliteAgentDatabase } from "../database/sqlite.js";
import { recomputeSessionLastActivityAt } from "../database/write-core.js";
import {
  compileSessionListQueryRequest,
  SessionListQueryRefusedError,
} from "./session-list-query-compiler.js";
import { sessionIsSubstantive } from "./session-usage-totals.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "./shared-agent-sessions-api.js";
import { getSharedAgentSessionsPageData } from "./shared-agent-sessions-page-data.js";

const excludedCosts = new Map<string, number>([
  ["e2", 7],
  ["e4", 8],
]);
const rows = SESSION_LIST_PARITY_EVIDENCE_SCENARIO.rows.map((row) => ({
  ...row,
  costUsd: excludedCosts.get(row.key) ?? row.costUsd,
}));
const window = {
  startDate: "2026-06-12T02:00:00.000Z",
  endDate: "2026-06-12T04:00:00.000Z",
};

function localRow(row: SessionListParityRow): SyncedAgentSession {
  return {
    externalSessionId: row.key,
    name: row.key,
    status: row.status,
    harness: row.harness,
    billingMode: "api",
    cwd: `/work/${row.key}`,
    model: row.model,
    userId: row.owner,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    endedAt: row.endedAt,
    awaitingInputSince: null,
    metadata: { userMessages: row.turns },
    attribution: {
      repositoryFullName: row.repositoryFullName,
      worktreePath: null,
      sourceArtifactId: null,
      sourceLoopId: null,
      baseBranch: null,
    },
    turns: row.turns,
    agents: [],
    events: [],
    tokenUsageByModel:
      row.costUsd === null
        ? []
        : [
            {
              model: row.model ?? "unknown",
              inputTokens: row.key === "e4" ? 43 : 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCostUsd: row.costUsd,
            },
          ],
  };
}

function sourceForCorpus(corpus: readonly SessionListParityRow[] = rows) {
  const sessions = Object.fromEntries(
    corpus.map((row) => [row.key, localRow(row)])
  );
  return {
    listAllSessionCursorRows: () =>
      corpus.map((row) => ({ id: row.key, updated_at: row.lastActivityAt })),
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: async (ids: string[]) =>
      ids.flatMap((id) => (sessions[id] ? [sessions[id]] : [])),
  } as AgentSessionSyncSource;
}

async function withCorpusDb<T>(
  read: (db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>) => Promise<T>,
  corpus: readonly SessionListParityRow[] = rows
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prd728-sessions-"));
  let db: Awaited<ReturnType<typeof openSqliteAgentDatabase>> | undefined;
  try {
    db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "unknown",
      now: () => "2026-06-07T12:00:00.000Z",
    });
    await db.whenBootMaintenanceSettled();
    for (const row of corpus) {
      await db.run(
        `INSERT INTO sessions
           (id, name, status, harness, model, cwd, repo_full_name, user_id,
            billing_mode, cost_usd_estimated, metadata, started_at, updated_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'api', $9, $10, $11, $12, $13)`,
        row.key,
        row.key,
        row.status,
        row.harness,
        row.model,
        `/work/${row.key}`,
        row.repositoryFullName,
        row.owner,
        row.costUsd,
        JSON.stringify({ userMessages: row.turns }),
        row.startedAt,
        row.updatedAt,
        row.endedAt
      );
      if (row.costUsd !== null) {
        await db.run(
          `INSERT INTO token_usage
             (session_id, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cost_usd_estimated)
           VALUES ($1, $2, $3, 0, 0, 0, $4)`,
          row.key,
          row.model ?? "unknown",
          row.key === "e4" ? 43 : 0,
          row.costUsd
        );
      }
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at)
         VALUES ($1, $2, 'tool_use', $3)`,
        `${row.key}-activity`,
        row.key,
        row.lastActivityAt
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) => recomputeSessionLastActivityAt(tx, row.key))
      );
      if (row.key === "p02" || row.key === "p04") {
        await db.run(
          `INSERT INTO agents (id, session_id, type, status, started_at, ended_at)
           VALUES ($1, $2, 'assistant', $3, $4, $5)`,
          `${row.key}-agent`,
          row.key,
          row.key === "p02" ? "completed" : "failed",
          row.startedAt,
          row.endedAt
        );
      }
    }
    return await read(db);
  } finally {
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ISS-9609/ISS-9526 Desktop list and metrics reconciliation", () => {
  it("DT-08: a changed DB-host revision retries the entire combined page", async () => {
    const baseSource = sourceForCorpus();
    const baseline = await getSharedAgentSessionsPageData(baseSource);
    const readCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        count: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        analytics: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: 10,
      })
      .mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        count: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        analytics: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: 11,
      })
      .mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        count: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        analytics: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: 11,
      });
    const source: AgentSessionSyncSource = {
      ...baseSource,
      readSessionCompactFilterCapabilities: readCapabilities,
    };
    const listReader = vi
      .fn()
      .mockResolvedValueOnce({ ...baseline.list, total: 1 })
      .mockResolvedValueOnce(baseline.list);
    const page = await getSharedAgentSessionsPageData(
      source,
      {},
      {},
      listReader
    );
    expect(listReader).toHaveBeenCalledTimes(2);
    expect(readCapabilities).toHaveBeenCalledTimes(3);
    expect(page.list.total).toBe(4);
    expect(page.usage?.totalSessions).toBe(4);
  });

  it("DT-07/08: an older partial DB-host capability retains hydrated quality reads", async () => {
    const listSessionCursorPage = vi.fn(() => {
      throw new Error("older cursor cannot apply quality");
    });
    const aggregateUsage = vi.fn(() => {
      throw new Error("older aggregate cannot apply quality");
    });
    const source: AgentSessionSyncSource = {
      ...sourceForCorpus(),
      listSessionCursorPage,
      aggregateUsage,
      readSessionCompactFilterCapabilities: () => ({
        cursor: SESSION_COMPACT_FILTER_VERSION + 1,
        count: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION + 1,
        analytics: SESSION_COMPACT_FILTER_VERSION,
      }),
    };
    const onQueryExecution = vi.fn();
    const page = await getSharedAgentSessionsPageData(
      source,
      {
        ...window,
        quality: "substantive",
        limit: 25,
        sortBy: "lastActivity",
        sortDir: "desc",
      },
      { onQueryExecution }
    );
    expect(page.list.total).toBe(2);
    expect(page.usage?.totalSessions).toBe(2);
    expect(page.usage?.totalEstimatedCost).toBe(3.5);
    expect(listSessionCursorPage).not.toHaveBeenCalled();
    expect(aggregateUsage).not.toHaveBeenCalled();
    expect(onQueryExecution).toHaveBeenCalledWith(
      ListQueryExecution.HydratedFallback
    );
  });

  it("DT-06/07/08: substantive count, cost and tokens use the windowed list population", async () => {
    const source = sourceForCorpus();
    const request = {
      ...window,
      quality: "substantive" as const,
      statuses: [SESSION_STATUS.INACTIVE],
      limit: 25,
      sortBy: "lastActivity" as const,
      sortDir: "desc" as const,
    };
    const page = await getSharedAgentSessionsPageData(source, request);

    expect(page.list.items.map((item) => item.externalSessionId)).toEqual([
      "e1",
      "e3",
    ]);
    expect(page.list.total).toBe(2);
    expect(page.usage?.totalSessions).toBe(2);
    expect(page.usage?.totalEstimatedCost).toBe(3.5);
    expect(page.usage?.totalInputTokens).toBe(0);
    expect(page.usage?.totalOutputTokens).toBe(0);
    const unfiltered = await getSharedAgentSessionUsage(source, {
      quality: "all",
    });
    expect(unfiltered.totalEstimatedCost).toBe(18.5);
    expect(unfiltered.totalInputTokens).toBe(43);
  });

  it("DT-06/07/09: real SQLite and hydrated collector fields select the same shared scenario", async () => {
    await withCorpusDb(async (db) => {
      const request = {
        ...window,
        quality: "substantive" as const,
        statuses: [SESSION_STATUS.INACTIVE],
        limit: 25,
        sortBy: "lastActivity" as const,
        sortDir: "desc" as const,
      };
      const beforeRevision =
        await db.syncSource.readSessionCompactFilterCapabilities?.();
      const page = await getSharedAgentSessionsPageData(db.syncSource, request);
      const firstRevision =
        await db.syncSource.readSessionCompactFilterCapabilities?.();
      const all = await getSharedAgentSessionsPageData(db.syncSource, {
        quality: "all",
        limit: 25,
      });
      const directUsage = await getSharedAgentSessionUsage(
        db.syncSource,
        request
      );
      expect(directUsage.totalSessions).toBe(2);
      const afterRevision =
        await db.syncSource.readSessionCompactFilterCapabilities?.();
      expect(firstRevision?.storeRevision).toBe(beforeRevision?.storeRevision);
      expect(afterRevision?.storeRevision).toBe(firstRevision?.storeRevision);

      expect(page.list.items.map((item) => item.externalSessionId)).toEqual([
        "e1",
        "e3",
      ]);
      expect(
        page.list.items.map((item) => item.startedAt.toISOString())
      ).toEqual(["2026-06-10T08:00:00.000Z", "2026-06-10T08:00:00.000Z"]);
      expect(page.list.total).toBe(2);
      expect(page.usage?.totalSessions).toBe(2);
      expect(page.usage?.totalEstimatedCost).toBe(3.5);
      expect(page.usage?.totalInputTokens).toBe(0);
      expect(all.list.total).toBe(4);
      expect(all.usage?.totalSessions).toBe(4);
      expect(all.usage?.totalEstimatedCost).toBe(18.5);
      expect(all.usage?.totalInputTokens).toBe(43);
    });
  });

  it("DT-06/07/09: four filtered facets use grouped SQLite reads, not repeated corpus hydration", async () => {
    const facetControls: SessionListParityRow[] = [
      { ...rows[0], key: "facet-owner", owner: "ownerB", costUsd: 1.25 },
      { ...rows[0], key: "facet-harness", harness: "codex", costUsd: 1.5 },
      { ...rows[0], key: "facet-model", model: "violet", costUsd: 1.75 },
      {
        ...rows[0],
        key: "facet-repository",
        repositoryFullName: "org/beta",
        costUsd: 2.25,
      },
    ];
    await withCorpusDb(
      async (db) => {
        const request = {
          ...window,
          quality: "substantive" as const,
          userIds: ["ownerA"],
          harnesses: [rows[0].harness],
          models: ["amber"],
          repositories: ["org/alpha"],
          limit: 2,
          sortBy: "lastActivity" as const,
          sortDir: "desc" as const,
        };
        const aggregateUsage = vi.fn(
          async (filters: AgentSessionUsageAggregateFilters) => {
            if (!db.syncSource.aggregateUsage) {
              throw new Error("production grouped usage reader unavailable");
            }
            return await db.syncSource.aggregateUsage(filters);
          }
        );
        const source: AgentSessionSyncSource = {
          ...db.syncSource,
          aggregateUsage,
          loadSyncedSessions: vi.fn(() =>
            Promise.reject(
              new Error("full-session hydration is not a usage read")
            )
          ),
          loadUsageSessions: vi.fn(() =>
            Promise.reject(
              new Error("corpus usage hydration is not a grouped read")
            )
          ),
        };
        const listOptions = {
          getWindow: () => null,
          isTrustedSender: () => true,
          onTerminalFailure: () => {},
          setAgentMonitorRuntimeStatus: () => {},
        } satisfies AgentDashboardDesignSystemRuntimeOptions;
        await readAgentDashboardSessionList(db, listOptions, request);
        const page = await getSharedAgentSessionsPageData(
          source,
          request,
          {},
          () => readAgentDashboardSessionList(db, listOptions, request)
        );

        expect(page.list.items.map((item) => item.externalSessionId)).toEqual([
          "e1",
          "e3",
        ]);
        expect(page.list.total).toBe(2);
        expect(page.list).not.toHaveProperty("queryScannedCount");
        expect(page.usage?.totalSessions).toBe(2);
        expect(page.usage?.totalEstimatedCost).toBe(3.5);
        expect(aggregateUsage).toHaveBeenCalledTimes(5);
        const ownerRelaxed = await aggregateUsage.mock.results[1]?.value;
        expect(ownerRelaxed?.userSessionCounts).toContainEqual({
          userId: "ownerB",
          sessionCount: 1,
        });
        expect(
          page.usage?.byHarness.find((row) => row.harness === "codex")
            ?.sessionCount
        ).toBe(1);
        expect(
          page.usage?.modelFilterOptions?.find((row) => row.model === "violet")
            ?.sessionCount
        ).toBe(1);
        expect(
          page.usage?.byRepository.find(
            (row) => row.repositoryFullName === "org/beta"
          )?.sessionCount
        ).toBe(1);
        expect(source.loadSyncedSessions).not.toHaveBeenCalled();
        expect(source.loadUsageSessions).not.toHaveBeenCalled();
      },
      [...rows, ...facetControls]
    );
  });

  it("DT-07/09: a token-only SQLite write moves an idle row into both list and metrics", async () => {
    await withCorpusDb(async (db) => {
      const request = { ...window, quality: "substantive" as const, limit: 25 };
      const before = await getSharedAgentSessionsPageData(
        db.syncSource,
        request
      );
      expect(before.list.total).toBe(2);
      expect(before.usage?.totalSessions).toBe(2);

      await db.run(
        `UPDATE token_usage SET input_tokens = 1 WHERE session_id = 'e2'`
      );
      const after = await getSharedAgentSessionsPageData(
        db.syncSource,
        request
      );
      expect(
        after.list.items.map((item) => item.externalSessionId).sort()
      ).toEqual(["e1", "e2", "e3"]);
      expect(after.list.total).toBe(3);
      expect(after.usage?.totalSessions).toBe(3);
      expect(after.usage?.totalInputTokens).toBe(1);
      expect(after.usage?.totalEstimatedCost).toBe(10.5);
    });
  });

  it("DT-06: SQLite usage bounds order mixed UTC and offset timestamps by instant", async () => {
    await withCorpusDb(async (db) => {
      await db.run(
        "UPDATE sessions SET started_at = '2026-06-10T08:00:00Z' WHERE id = 'e1'"
      );
      await db.run(
        "UPDATE sessions SET started_at = '2026-06-10T03:00:00.500-05:00' WHERE id = 'e3'"
      );
      const usage = await getSharedAgentSessionUsage(db.syncSource, {
        ...window,
        quality: "substantive",
      });
      expect(usage.earliestSessionAt).toBe("2026-06-10T08:00:00.000Z");
      expect(usage.latestSessionAt).toBe("2026-06-10T08:00:00.500Z");
    });
  });

  it("DT-07/09: invalid token operands cannot cancel work or yield a plausible narrowed total", async () => {
    await withCorpusDb(async (db) => {
      const request = { ...window, quality: "substantive" as const, limit: 25 };
      await db.run(
        "UPDATE token_usage SET input_tokens = 5, model = 'same-group' WHERE session_id = 'e1'"
      );
      await db.run(
        "UPDATE token_usage SET model = 'same-group' WHERE session_id = 'e2'"
      );
      await db.run(
        "UPDATE sessions SET harness = 'claude' WHERE id IN ('e1', 'e2')"
      );
      for (const invalidInput of [-5, 0.5]) {
        await db.run(
          "UPDATE token_usage SET input_tokens = $1, output_tokens = 3 WHERE session_id = 'e2'",
          invalidInput
        );
        if (invalidInput === -5) {
          const [cancelled] = await db.prisma.read((reader) =>
            reader.$queryRawUnsafe<{ net: number }[]>(
              "SELECT SUM(input_tokens) AS net FROM token_usage WHERE session_id IN ('e1', 'e2')"
            )
          );
          expect(Number(cancelled?.net)).toBe(0);
        }
        await expect(
          db.syncSource.listSessionCursorPage?.({
            quality: "substantive",
            startDate: new Date(window.startDate),
            endDate: new Date(window.endDate),
            limit: 25,
            offset: 0,
            sortBy: SessionListCursorSortKey.LastActivity,
            sortDir: "desc",
          })
        ).rejects.toThrow("Invalid token count");
        await expect(
          getSharedAgentSessionsPageData(db.syncSource, request)
        ).rejects.toThrow("Invalid token count");
        await expect(
          getSharedAgentSessionUsage(db.syncSource, request)
        ).rejects.toThrow("unavailable");
      }
    });
  });

  it("DT-07: a product-shaped narrowed cohort uses one grouped SQLite query and reader pass", async () => {
    const corpus: SessionListParityRow[] = Array.from(
      { length: 128 },
      (_, index) => ({
        ...rows[0],
        key: `cohort-${index}`,
        turns: 1,
        costUsd: 0.5,
      })
    );
    await withCorpusDb(async (db) => {
      const predicate = sessionQualitySqlPredicate("substantive");
      if (!predicate) {
        throw new Error("substantive SQLite predicate unavailable");
      }
      await db.prisma.read(async (reader) => {
        const query = vi.spyOn(reader, "$queryRawUnsafe");
        const grouped = await readNarrowedUsageRows(
          reader,
          `WHERE ${predicate}`,
          []
        );
        expect(grouped.harnessRows).toEqual([
          { harness: rows[0].harness, session_count: 128 },
        ]);
        expect(query).toHaveBeenCalledTimes(1);
        query.mockRestore();
      });
      const read = vi.spyOn(db.prisma, "read");
      const usage = await getSharedAgentSessionUsage(db.syncSource, {
        quality: "substantive",
      });
      expect(usage.totalSessions).toBe(128);
      expect(usage.totalEstimatedCost).toBe(64);
      expect(read).toHaveBeenCalledTimes(1);
    }, corpus);
  });

  it("DT-09: an unsafe persisted token integer cannot yield a plausible list or metric", async () => {
    await withCorpusDb(async (db) => {
      await db.run(
        "UPDATE token_usage SET input_tokens = 9007199254740992 WHERE session_id = 'e2'"
      );
      const request = { ...window, quality: "substantive" as const, limit: 25 };
      await expect(
        getSharedAgentSessionsPageData(db.syncSource, request)
      ).rejects.toThrow("Invalid token count");
      await expect(
        getSharedAgentSessionUsage(db.syncSource, request)
      ).rejects.toThrow("unavailable");
    });
  });

  it("DT-16: all-quality and narrowed compact reads reject unpriced 1h tokens and invalid turns", async () => {
    await withCorpusDb(async (db) => {
      await db.run(
        "UPDATE token_usage SET cache_write_1h_tokens = -1 WHERE session_id = 'e2'"
      );
      await expect(
        getSharedAgentSessionUsage(db.syncSource, { quality: "all" })
      ).rejects.toThrow("unavailable");
      await expect(
        getSharedAgentSessions(db.syncSource, {
          countOnly: true,
          quality: "substantive",
        })
      ).rejects.toThrow("Invalid token count");
      await expect(
        db.syncSource.listSessionCursorPage?.({
          quality: "all",
          limit: 25,
          offset: 0,
          sortBy: SessionListCursorSortKey.LastActivity,
          sortDir: "desc",
        })
      ).rejects.toThrow("Invalid token count");
      await db.run(
        "UPDATE token_usage SET cache_write_1h_tokens = 0 WHERE session_id = 'e2'"
      );
      await db.run(
        `UPDATE sessions SET metadata = '{"userMessages":-1}' WHERE id = 'e2'`
      );
      await expect(
        getSharedAgentSessionUsage(db.syncSource, { quality: "idle" })
      ).rejects.toThrow("unavailable");
      await expect(
        getSharedAgentSessions(db.syncSource, {
          countOnly: true,
          quality: "idle",
        })
      ).rejects.toThrow("Invalid persisted turn count");
      await expect(
        getSharedAgentSessionAnalytics(db.syncSource, { quality: "all" })
      ).rejects.toThrow("unavailable");
      await expect(
        db.syncSource.listSessionCursorPage?.({
          quality: "idle",
          limit: 25,
          offset: 0,
          sortBy: SessionListCursorSortKey.LastActivity,
          sortDir: "desc",
        })
      ).rejects.toThrow("Invalid persisted turn count");
    });
  });

  it("DT-07: narrowed grouped usage resolves repositories without a fill-back write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "prd728-repo-"));
    try {
      const repoDir = path.join(dir, "repo");
      await mkdir(repoDir);
      const gitOptions = {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        timeout: 10_000,
      };
      execFileSync("git", ["init", "-q"], gitOptions);
      execFileSync(
        "git",
        ["remote", "add", "origin", "git@github.com:org/alpha.git"],
        gitOptions
      );
      await withCorpusDb(async (db) => {
        await db.run(
          "UPDATE sessions SET cwd = $1, repo_full_name = NULL WHERE id = 'e1'",
          repoDir
        );
        const write = vi.spyOn(db.prisma, "write");
        const usage = await getSharedAgentSessionUsage(db.syncSource, {
          ...window,
          quality: "substantive",
        });
        expect(
          usage.byRepository.find(
            (row) => row.repositoryFullName === "org/alpha"
          )?.sessionCount
        ).toBe(2);
        expect(write).not.toHaveBeenCalled();
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("DT-06/07: repository pair, page, total and idle read one SQLite snapshot", async () => {
    await withCorpusDb(async (db) => {
      const read = vi.spyOn(db.prisma, "read");
      const cursor = db.syncSource.listSessionCursorPage;
      const capabilities = db.syncSource.readSessionCompactFilterCapabilities;
      if (!(cursor && capabilities)) {
        throw new Error("production compact cursor capability unavailable");
      }
      const page = await cursor({
        quality: "substantive",
        repositories: ["org/alpha"],
        startDate: new Date(window.startDate),
        endDate: new Date(window.endDate),
        limit: 25,
        offset: 0,
        sortBy: SessionListCursorSortKey.LastActivity,
        sortDir: "desc",
      });
      expect(page.rows.map((row) => row.id)).toEqual(["e1", "e3"]);
      expect(page.total).toBe(2);
      expect(page.idleCount).toBe(1);
      expect(read).toHaveBeenCalledTimes(2);
      read.mockRestore();
      const before = await capabilities();
      await db.run("UPDATE sessions SET name = 'changed' WHERE id = 'e1'");
      const after = await capabilities();
      expect(after.storeRevision).toBeGreaterThan(before.storeRevision ?? -1);
    });
  });

  it("DT-07/09: SQLite quality gates mirror null, turn-only, tool-only, and invocation-only collector signals", async () => {
    await withCorpusDb(async (db) => {
      if (!db.syncSource.listSessionCursorPage) {
        throw new Error("production SQLite cursor reader unavailable");
      }
      const readCounts = async () => {
        const cursor = await db.syncSource.listSessionCursorPage?.({
          quality: "substantive",
          startDate: new Date(window.startDate),
          endDate: new Date(window.endDate),
          limit: 25,
          offset: 0,
          sortBy: SessionListCursorSortKey.LastActivity,
          sortDir: "desc",
        });
        const usage = await getSharedAgentSessionUsage(db.syncSource, {
          ...window,
          quality: "substantive",
        });
        return [cursor?.total, usage.totalSessions];
      };
      expect(await readCounts()).toEqual([2, 2]);

      await db.run(
        `UPDATE sessions SET metadata = '{"userMessages":null,"assistantMessages":1}' WHERE id = 'e2'`
      );
      await expect(readCounts()).rejects.toThrow(
        "Invalid persisted turn count"
      );

      await db.run(
        `UPDATE sessions SET metadata = '{"userMessages":1}' WHERE id = 'e2'`
      );
      expect(await readCounts()).toEqual([3, 3]);

      await db.run(
        `UPDATE sessions SET metadata = '{"userMessages":0}' WHERE id = 'e2'`
      );
      await db.run(
        `UPDATE events SET tool_name = 'Bash' WHERE session_id = 'e2'`
      );
      expect(await readCounts()).toEqual([3, 3]);

      await db.run(
        `UPDATE events SET tool_name = NULL WHERE session_id = 'e2'`
      );
      await db.run(
        `INSERT INTO agent_component_invocations
          (id, session_id, external_invocation_id, component_kind, component_key,
           relationship, sequence, anchor_kind, anchor_value, attribution_status, evidence_class,
           created_at, updated_at)
         VALUES ('e2-invocation', 'e2', 'e2-invocation', 'skill', 'review',
           'invokes', 1, 'timestamp', '2026-06-12T03:00:00.000Z', 'resolved', 'direct',
           '2026-06-12T03:00:00.000Z', '2026-06-12T03:00:00.000Z')`
      );
      expect(await readCounts()).toEqual([3, 3]);
    });
  });

  it("DT-06/09: a windowed terminal SQLite row retains status, cost, and two-hour duration basis", async () => {
    await withCorpusDb(async (db) => {
      const page = await getSharedAgentSessionsPageData(db.syncSource, {
        startDate: "2026-06-12T09:00:00.000Z",
        endDate: "2026-06-12T11:00:00.000Z",
        statuses: [SESSION_STATUS.INACTIVE],
        quality: "all",
        limit: 25,
      });

      expect(page.list.items.map((item) => item.externalSessionId)).toEqual([
        "p02",
      ]);
      expect(page.list.total).toBe(1);
      const terminal = page.list.items[0];
      expect(terminal?.status).toBe(SESSION_STATUS.INACTIVE);
      if (!(terminal?.startedAt && terminal.endedAt)) {
        throw new Error("expected a terminal row with both duration endpoints");
      }
      expect(terminal.endedAt.getTime() - terminal.startedAt.getTime()).toBe(
        7_200_000
      );
      expect(page.usage?.totalSessions).toBe(1);
      expect(page.usage?.totalEstimatedCost).toBe(0.75);
    }, SESSION_LIST_PARITY_CONFORM_SCENARIO.rows);
  });

  it("DT-06/09: Desktop analytics status filter excludes a different-duration agent", async () => {
    await withCorpusDb(
      async (db) => {
        const filters = {
          startDate: "2026-06-12T00:00:00.000Z",
          endDate: "2026-06-14T00:00:00.000Z",
          statuses: [SESSION_STATUS.INACTIVE],
          quality: "substantive" as const,
        };
        const filtered = await getSharedAgentSessionAnalytics(
          db.syncSource,
          filters
        );
        const matchingList = await getSharedAgentSessions(db.syncSource, {
          ...filters,
          limit: 25,
        });
        const unfiltered = await getSharedAgentSessionAnalytics(db.syncSource, {
          ...filters,
          statuses: [],
        });

        expect(
          matchingList.items.map((item) => item.externalSessionId)
        ).toEqual(["p02"]);
        expect(matchingList.total).toBe(1);
        expect(filtered.byAgentType).toEqual([
          {
            agentType: "assistant",
            count: 1,
            successCount: 1,
            failedCount: 0,
            avgDurationMs: 7_200_000,
          },
        ]);
        expect(unfiltered.byAgentType).toEqual([
          {
            agentType: "assistant",
            count: 2,
            successCount: 1,
            failedCount: 1,
            avgDurationMs: 4_500_000,
          },
        ]);
      },
      SESSION_LIST_PARITY_CONFORM_SCENARIO.rows.map((row) => ({
        ...row,
        turns: row.key === "p02" || row.key === "p04" ? 1 : row.turns,
      }))
    );
  });

  it("DT-12: Desktop duration analytics follows activity, not start, in both directions", async () => {
    await withCorpusDb(async (db) => {
      const activityWindow = {
        startDate: "2026-06-12T10:30:00.000Z",
        endDate: "2026-06-12T11:30:00.000Z",
        statuses: [SESSION_STATUS.INACTIVE],
        quality: "all" as const,
      };
      const list = await getSharedAgentSessions(db.syncSource, {
        ...activityWindow,
        limit: 25,
      });
      const analytics = await getSharedAgentSessionAnalytics(
        db.syncSource,
        activityWindow
      );
      expect(list.items.map((item) => item.externalSessionId)).toEqual(["p02"]);
      expect(analytics.byAgentType).toEqual([
        {
          agentType: "assistant",
          count: 1,
          successCount: 1,
          failedCount: 0,
          avgDurationMs: 7_200_000,
        },
      ]);

      const startOnlyWindow = {
        ...activityWindow,
        startDate: "2026-06-12T09:00:00.000Z",
        endDate: "2026-06-12T10:00:00.000Z",
      };
      expect(
        (await getSharedAgentSessions(db.syncSource, startOnlyWindow)).total
      ).toBe(0);
      expect(
        (await getSharedAgentSessionAnalytics(db.syncSource, startOnlyWindow))
          .byAgentType
      ).toEqual([]);
    }, SESSION_LIST_PARITY_CONFORM_SCENARIO.rows);
  });

  it("DT-09: collector and list predicates agree for single work signals and mixed idle data", () => {
    const idle = {
      ...localRow(rows[1]),
      turns: 0,
      events: [],
      tokenUsageByModel: [],
    };
    const tokenOnly = {
      ...idle,
      tokenUsageByModel: [
        {
          model: "amber",
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    };
    const toolOnly = {
      ...idle,
      events: [
        {
          externalEventId: "tool",
          eventType: "tool_use",
          toolName: "Bash",
          createdAt: "2026-06-12T03:00:00.000Z",
        },
      ],
    };
    const invocationOnly = { ...idle, componentInvocationCount: 1 };
    const turnOnly = { ...idle, turns: 1 };

    for (const [candidate, expected] of [
      [idle, false],
      [tokenOnly, true],
      [toolOnly, true],
      [invocationOnly, true],
      [turnOnly, true],
    ] as const) {
      expect(sessionIsSubstantive(candidate)).toBe(expected);
      expect(syncedSessionIsSubstantive(candidate)).toBe(expected);
    }
  });

  it("DT-06/07/09: idle, absent, unknown and explicit all quality preserve the defined cohorts", async () => {
    const source = sourceForCorpus();
    const idle = await getSharedAgentSessionsPageData(source, {
      ...window,
      quality: "idle",
      limit: 25,
    });
    const all = await getSharedAgentSessionUsage(source, { quality: "all" });
    const absent = await getSharedAgentSessionUsage(sourceForCorpus(), {});
    const unknown = sharedAgentSessionsListRequestSchema.parse({
      quality: "future-quality",
    });
    const unknownPage = await getSharedAgentSessionsPageData(
      sourceForCorpus(),
      unknown
    );

    expect(idle.list.items.map((item) => item.externalSessionId)).toEqual([
      "e2",
    ]);
    expect(idle.usage?.totalSessions).toBe(1);
    expect(idle.usage?.totalEstimatedCost).toBe(7);
    expect(all.totalSessions).toBe(4);
    expect(absent.totalSessions).toBe(4);
    expect(unknown.quality).toBeUndefined();
    expect(sessionQualitySqlPredicate("future-quality")).toBeNull();
    expect(unknownPage.list.total).toBe(4);
    expect(unknownPage.usage?.totalSessions).toBe(4);
    expect(unknownPage.usage?.totalEstimatedCost).toBe(18.5);
  });

  it("DT-05/09: compiler output reaches the production SQLite list reader without dropping quality", async () => {
    const qualityCase = SESSION_LIST_PARITY_EVIDENCE_SCENARIO.cases.find(
      (entry) => entry.name === "quality substantive"
    );
    if (!qualityCase) {
      throw new Error("shared parity quality scenario missing");
    }
    const compiled = compileSessionListQueryRequest({
      listQuery: qualityCase.expression,
      limit: 25,
    });
    const request = sharedAgentSessionsListRequestSchema.parse(compiled);
    await withCorpusDb(async (db) => {
      if (!db.syncSource.projectSessionList) {
        throw new Error("production SQLite list reader unavailable");
      }
      const projection = await db.syncSource.projectSessionList({
        request,
        computeTargetId: null,
        users: [],
      });

      expect(projection.items.map((item) => item.externalSessionId)).toEqual([
        "e1",
        "e3",
        "e4",
      ]);
      expect(projection.total).toBe(3);
      expect(projection.queryMatchedCount).toBe(3);
      expect(projection.queryScannedCount).toBeUndefined();
    });
  });
  it("DT-05/09: malformed expression refuses before a broad read; legacy input remains unchanged", () => {
    expect(() => compileSessionListQueryRequest({ listQuery: "{" })).toThrow(
      SessionListQueryRefusedError
    );
    const legacy = { quality: "idle", limit: 1 };
    expect(compileSessionListQueryRequest(legacy)).toBe(legacy);
  });
});
