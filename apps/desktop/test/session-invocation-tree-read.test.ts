import {
  AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS,
  type AgentComponentInvocationSessionTreeRequest,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import { describe, expect, it, vi } from "vitest";
import { anyString, matches, mock } from "vitest-mock-extended";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { LocalInvocationReadDbRow } from "../src/main/dashboard/local-invocation-read.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
} from "../src/main/database/prisma-client.js";
import { readSessionInvocationTree } from "../src/main/database/session-invocation-tree-read.js";
import { getSharedAgentSessionInvocationTree } from "../src/main/session/shared-agent-session-invocation-tree-read.js";

const SESSION_ID = "session-1";

function localRow(index: number): LocalInvocationReadDbRow {
  return {
    id: `row-${index}`,
    session_id: SESSION_ID,
    external_invocation_id: `inv-${index}`,
    child_session_id: null,
    component_kind: "tool",
    component_key: `tool-${index}`,
    raw_name: null,
    normalized_name: null,
    relationship: "direct",
    invoked_at: "2026-09-20T09:00:00.000Z",
    sequence: index,
    anchor_kind: "session",
    anchor_value: "",
    provider_tool_use_id: null,
    attribution_status: "matched",
    evidence_class: "transcriptSnapshot",
    attribution_source: null,
    evidence_pointer: null,
    definition_hash: null,
    normalizer_contract_version: null,
    local_component_version_id: null,
    repository_full_name: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    footprint_tokens: null,
    usage_measurement: null,
    succeeded: null,
  };
}

function fakePrisma(options: {
  sessionRows?: { id: string }[];
  rows?: LocalInvocationReadDbRow[];
  total?: number;
}) {
  const reader = mock<DesktopPrismaReadClient>(
    {},
    { fallbackMockImplementation: failUnconfiguredPrismaMember }
  );
  const queryRawUnsafe = reader.$queryRawUnsafe;
  // `calledWith` matches the most recently registered stub first, so these are
  // listed from the fallback up to the statement checked first.
  queryRawUnsafe.calledWith(anyString()).mockResolvedValue(options.rows ?? []);
  queryRawUnsafe
    .calledWith(sqlContaining("COUNT(*)"))
    .mockResolvedValue([
      { total: options.total ?? (options.rows ?? []).length },
    ]);
  queryRawUnsafe
    .calledWith(sqlContaining("FROM sessions"))
    .mockResolvedValue(options.sessionRows ?? [{ id: SESSION_ID }]);
  const prisma = mock<DesktopPrisma>(
    {},
    { fallbackMockImplementation: failUnconfiguredPrismaMember }
  );
  prisma.read.mockImplementation((run) => run(reader));
  return { prisma, queryRawUnsafe };
}

describe("readSessionInvocationTree", () => {
  it("answers null for a session the local store does not hold", async () => {
    const { prisma, queryRawUnsafe } = fakePrisma({ sessionRows: [] });

    await expect(
      readSessionInvocationTree(prisma, { sessionId: SESSION_ID })
    ).resolves.toBeNull();
    // Fails closed before the invocation read runs at all.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("answers a real, empty read for a known session with no invocations", async () => {
    const { prisma } = fakePrisma({ rows: [], total: 0 });

    await expect(
      readSessionInvocationTree(prisma, { sessionId: SESSION_ID })
    ).resolves.toStrictEqual({ rows: [], total: 0 });
  });

  it("bounds the row read in SQL and scopes both statements to the session", async () => {
    const { prisma, queryRawUnsafe } = fakePrisma({ rows: [localRow(0)] });

    await readSessionInvocationTree(prisma, { sessionId: SESSION_ID });

    const rowCall = queryRawUnsafe.mock.calls.find((call) =>
      String(call[0]).includes(
        "FROM agent_component_invocations\n          WHERE"
      )
    );
    expect(String(rowCall?.[0])).toContain("LIMIT $2");
    // One row past the page, which is what proves there is a next page.
    expect(rowCall?.[2]).toBe(
      AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS + 1
    );
    for (const call of queryRawUnsafe.mock.calls) {
      expect(call[1]).toBe(SESSION_ID);
    }
  });
});

describe("getSharedAgentSessionInvocationTree", () => {
  function source(
    loadSessionInvocationTree?: AgentSessionSyncSource["loadSessionInvocationTree"]
  ): AgentSessionSyncSource {
    return {
      // The reads the source contract makes mandatory; none is called here.
      listAllSessionCursorRows: () => [],
      listUpdatedSessionCursorRows: () => [],
      loadSyncedSessions: () => [],
      ...(loadSessionInvocationTree ? { loadSessionInvocationTree } : {}),
    };
  }

  /**
   * The request is built through the SHARED wire type on every case below, so
   * a handler reading a key the renderer never sends fails `tsc` here rather
   * than answering `null` for every session in production.
   */
  function request(
    value: AgentComponentInvocationSessionTreeRequest
  ): AgentComponentInvocationSessionTreeRequest {
    return value;
  }

  it("answers null when the source cannot serve a tree at all", async () => {
    await expect(
      getSharedAgentSessionInvocationTree(
        source(),
        request({ sessionId: SESSION_ID })
      )
    ).resolves.toBeNull();
  });

  it("answers null for a request with no session id", async () => {
    await expect(
      getSharedAgentSessionInvocationTree(
        source(vi.fn(() => Promise.resolve({ rows: [], total: 0 }))),
        {}
      )
    ).resolves.toBeNull();
  });

  it("maps rows and reports exhaustion as an omitted cursor", async () => {
    const page = await getSharedAgentSessionInvocationTree(
      source(() =>
        Promise.resolve({ rows: [localRow(0), localRow(1)], total: 2 })
      ),
      request({ sessionId: SESSION_ID })
    );

    expect(page?.items).toHaveLength(2);
    expect(page?.items[0]?.externalInvocationId).toBe("inv-0");
    expect(page?.total).toBe(2);
    expect(page && "nextCursor" in page).toBe(false);
  });

  it("never surfaces a branch name, even when the stored row carries one", async () => {
    const rowWithBranch = { ...localRow(0), git_branch: "feature/untracked" };

    const page = await getSharedAgentSessionInvocationTree(
      source(() => Promise.resolve({ rows: [rowWithBranch], total: 1 })),
      request({ sessionId: SESSION_ID })
    );

    expect(page?.items).toHaveLength(1);
    expect(page?.items[0]).not.toHaveProperty("branchName");
  });

  it("passes the producer's continuation straight through", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => localRow(index));

    const page = await getSharedAgentSessionInvocationTree(
      source(() =>
        Promise.resolve({ rows, total: 5016, nextCursor: "next-page" })
      ),
      request({ sessionId: SESSION_ID })
    );

    expect(page?.nextCursor).toBe("next-page");
    expect(page?.total).toBe(5016);
  });

  it("reads the session id the renderer actually sends", async () => {
    const load = vi.fn(() =>
      Promise.resolve({ rows: [localRow(0)], total: 1 })
    );

    const page = await getSharedAgentSessionInvocationTree(
      source(load),
      request({ sessionId: SESSION_ID })
    );

    // The renderer sends `sessionId`; a handler reading `id` fails closed on
    // EVERY session, which the Trace tab shows as "could not be loaded".
    expect(load).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(page?.items).toHaveLength(1);
  });

  it("refuses a cursor this producer could not have minted", async () => {
    const load = vi.fn(() => Promise.resolve({ rows: [], total: 0 }));

    await expect(
      getSharedAgentSessionInvocationTree(
        source(load),
        request({ sessionId: SESSION_ID, cursor: "not-a-cursor" })
      )
    ).resolves.toBeNull();
    // Refused before the read runs, so the walk stops rather than silently
    // restarting at the head.
    expect(load).not.toHaveBeenCalled();
  });
});

function failUnconfiguredPrismaMember(): never {
  throw new Error(
    "the read reached a Prisma member this test did not configure"
  );
}

function sqlContaining(fragment: string) {
  return matches<string>((sql) => sql.includes(fragment));
}
