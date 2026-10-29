import { describe, expect, it, vi } from "vitest";
import type { SessionListCursorPageRequest } from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { SESSION_COMPACT_FILTER_VERSION } from "../agent-sync/session-compact-filter-capabilities.js";
import { matchesLocalSessionSearch } from "./session-local-facet-filters.js";
import { getSharedAgentSessions } from "./shared-agent-sessions-api.js";
import { getSharedAgentSessionsPageData } from "./shared-agent-sessions-page-data.js";

const baseRow: SyncedAgentSession = {
  externalSessionId: "branch-row",
  name: "Ordinary session",
  status: "active",
  harness: "claude",
  billingMode: "api",
  cwd: "/work/ordinary",
  model: null,
  userId: null,
  startedAt: "2026-06-12T02:00:00.000Z",
  updatedAt: "2026-06-12T03:00:00.000Z",
  lastActivityAt: "2026-06-12T03:00:00.000Z",
  endedAt: null,
  awaitingInputSince: null,
  metadata: null,
  attribution: {
    repositoryFullName: "org/ordinary",
    worktreePath: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    baseBranch: "needle-branch",
  },
  turns: 1,
  agents: [],
  events: [],
  tokenUsageByModel: [],
};
const repositoryRow: SyncedAgentSession = {
  ...baseRow,
  externalSessionId: "repository-row",
  attribution: {
    ...baseRow.attribution,
    repositoryFullName: "org/needle-repository",
    baseBranch: null,
  },
};

function sourceForSearch(): AgentSessionSyncSource {
  const rows = [baseRow, repositoryRow];
  return {
    listAllSessionCursorRows: () =>
      rows.map((row) => ({
        id: row.externalSessionId,
        updated_at: row.updatedAt,
      })),
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: async (ids: string[]) =>
      rows.filter((row) => ids.includes(row.externalSessionId)),
    listSessionCursorPage: vi.fn((request: SessionListCursorPageRequest) => {
      const search = request.search;
      const matchingRows = search
        ? rows.filter((row) => matchesLocalSessionSearch(row, search))
        : rows;
      return {
        rows: matchingRows.map((row) => ({
          id: row.externalSessionId,
          updated_at: row.updatedAt,
        })),
        total: matchingRows.length,
        idleCount: 0,
      };
    }),
    readSessionCompactFilterCapabilities: () => ({
      cursor: SESSION_COMPACT_FILTER_VERSION,
      count: SESSION_COMPACT_FILTER_VERSION,
      usage: SESSION_COMPACT_FILTER_VERSION,
      analytics: SESSION_COMPACT_FILTER_VERSION,
      storeRevision: 1,
    }),
  } as AgentSessionSyncSource;
}

describe("review-3 Sessions production read boundaries", () => {
  it("DT-13: cursor search preserves base-branch-only and repository-only matches", async () => {
    const source = sourceForSearch();
    const branch = await getSharedAgentSessions(source, {
      search: "needle-branch",
      limit: 25,
    });
    const repository = await getSharedAgentSessions(source, {
      search: "needle-repository",
      limit: 25,
    });
    expect(branch.items.map((item) => item.externalSessionId)).toEqual([
      "branch-row",
    ]);
    expect(repository.items.map((item) => item.externalSessionId)).toEqual([
      "repository-row",
    ]);
    expect(source.listSessionCursorPage).toHaveBeenCalledTimes(2);
  });

  it("DT-15: exhausted writer revisions retain the last completed page", async () => {
    const source = sourceForSearch();
    const capabilities = vi
      .fn()
      .mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: 1,
      })
      .mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: 2,
      })
      .mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: 3,
      })
      .mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: 4,
      });
    source.readSessionCompactFilterCapabilities = capabilities;
    const list = await getSharedAgentSessions(source, {
      search: "needle-branch",
      limit: 25,
    });
    const listReader = vi.fn().mockResolvedValue(list);
    const page = await getSharedAgentSessionsPageData(
      source,
      {},
      {},
      listReader
    );
    expect(page.list.items.map((item) => item.externalSessionId)).toEqual([
      "branch-row",
    ]);
    expect(page.usage?.totalSessions).toBe(2);
    expect(listReader).toHaveBeenCalledTimes(3);
    expect(capabilities).toHaveBeenCalledTimes(4);
  });

  it("DT-47: continuous unrelated writer revisions do not discard computed list and usage", async () => {
    const source = sourceForSearch();
    const list = await getSharedAgentSessions(source, {
      search: "needle-branch",
      limit: 25,
    });
    const capabilities = vi.fn();
    for (let revision = 1; revision <= 4; revision += 1) {
      capabilities.mockResolvedValueOnce({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        usage: SESSION_COMPACT_FILTER_VERSION,
        storeRevision: revision,
      });
    }
    source.readSessionCompactFilterCapabilities = capabilities;
    const listReader = vi.fn().mockResolvedValue(list);
    const page = await getSharedAgentSessionsPageData(
      source,
      {},
      {},
      listReader
    );
    expect(page.list.items.map((item) => item.externalSessionId)).toEqual([
      "branch-row",
    ]);
    expect(page.usage?.totalSessions).toBe(2);
    expect(listReader).toHaveBeenCalledTimes(3);
    expect(capabilities).toHaveBeenCalledTimes(4);
  });
});
