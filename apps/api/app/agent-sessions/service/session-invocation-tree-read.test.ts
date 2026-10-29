import {
  AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS,
  decodeAgentComponentInvocationSessionTreeCursor,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import { withDb } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { loadAgentSessionInvocationTree } from "./session-invocation-tree-read";

const dbState = vi.hoisted((): { db: unknown } => ({ db: undefined }));

// The fake is handed to the code under test through the mocked `withDb`, whose
// real signature is what types it as a transaction client.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: (fn: (db: unknown) => unknown) => fn(dbState.db),
}));

const ORGANIZATION_ID = "org_1";
const CURSOR_REJECTION_RE = /cursor/i;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function dbRow(index: number) {
  return {
    id: `row-${index}`,
    durationMs: null as bigint | null,
    externalInvocationId: `inv-${index}`,
    generationId: "gen-1",
    sourceSessionId: "src-1",
    childSessionId: null,
    parentExternalInvocationId: null,
    externalAgentId: null,
    componentKind: "tool",
    componentKey: `tool-${index}`,
    rawName: null,
    normalizedName: null,
    relationship: "direct",
    invokedAt: new Date("2026-09-20T09:00:00.000Z"),
    sequence: index,
    anchor: { kind: "session" },
    providerInvocationId: null,
    attributionStatus: "matched",
    evidenceClass: "transcriptSnapshot",
    definitionHash: null,
    normalizerContractVersion: null,
    definitionVersionId: null,
    sourceOccurrenceId: null,
    sourcePath: null,
    sourceModifiedAt: null,
    capturedAt: null,
    repositoryFullName: null,
    repositoryCommit: null,
    packId: null,
    branchName: null,
    succeeded: null as boolean | null,
    generation: {
      agentSessionId: SESSION_ID,
      session: { externalSessionId: "ext-1" },
    },
  };
}

/** Only the parts of the Prisma args these assertions read. */
type InvocationFindManyArgs = {
  where: {
    generation: {
      agentSessionId: string;
      session: { artifact: { organizationId: string } };
    };
  };
  orderBy: Record<string, string>[];
  take: number;
  select: Record<string, unknown>;
};

function fakeDb(options: {
  session?: { artifactId: string } | null;
  rows?: ReturnType<typeof dbRow>[];
  total?: number;
}) {
  const rows = options.rows ?? [];
  const findMany = vi.fn(async (_args: InvocationFindManyArgs) => rows);
  const count = vi.fn(
    async (_args: Pick<InvocationFindManyArgs, "where">) =>
      options.total ?? rows.length
  );
  const findFirst = vi.fn(async () =>
    options.session === undefined ? { artifactId: SESSION_ID } : options.session
  );
  return {
    db: {
      sessionDetail: { findFirst },
      agentComponentInvocation: { findMany, count },
      sourceOccurrence: { findMany: vi.fn(async () => []) },
    },
    findMany,
    count,
    findFirst,
  };
}

function loadTree(
  db: unknown,
  input: Parameters<typeof loadAgentSessionInvocationTree>[1]
) {
  dbState.db = db;
  return withDb((tx) => loadAgentSessionInvocationTree(tx, input));
}

describe("loadAgentSessionInvocationTree", () => {
  it("selects and exposes measured timing, including zero, while older rows omit it", async () => {
    const rows = [dbRow(0), dbRow(1), dbRow(2)];
    rows[0]!.durationMs = 10000n;
    rows[1]!.durationMs = 0n;
    const { db, findMany } = fakeDb({ rows });
    const page = await loadTree(db, {
      sessionId: SESSION_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(findMany.mock.calls[0]?.[0]?.select.durationMs).toBe(true);
    expect(page?.items[0]?.durationMs).toBe(10_000);
    expect(page?.items[1]?.durationMs).toBe(0);
    expect(page?.items[2]).not.toHaveProperty("durationMs");
  });

  it("exposes a tool result's verdict while a row without one omits it", async () => {
    const rows = [dbRow(0), dbRow(1), dbRow(2)];
    rows[0]!.succeeded = false;
    rows[1]!.succeeded = true;
    const { db, findMany } = fakeDb({ rows });
    const page = await loadTree(db, {
      sessionId: SESSION_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(findMany.mock.calls[0]?.[0]?.select.succeeded).toBe(true);
    expect(page?.items[0]?.succeeded).toBe(false);
    expect(page?.items[1]?.succeeded).toBe(true);
    expect(page?.items[2]).not.toHaveProperty("succeeded");
  });

  it("refuses a session outside the caller's organization", async () => {
    const { db, findMany } = fakeDb({ session: null });

    await expect(
      loadTree(db, {
        sessionId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toBeUndefined();
    // `undefined` is not an empty tree: an empty tree is a claim about the
    // session, and a cross-org read has not established that it may make one.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("answers a real, empty page for a session that ran no components", async () => {
    const { db } = fakeDb({ rows: [], total: 0 });

    const page = await loadTree(db, {
      sessionId: SESSION_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(page?.items).toStrictEqual([]);
    expect(page?.total).toBe(0);
    // No continuation is EXHAUSTION, and it is an omission rather than a null.
    expect(page && "nextCursor" in page).toBe(false);
  });

  it("scopes the read to the session AND the organization, on one predicate", async () => {
    const { db, findMany, count } = fakeDb({ rows: [dbRow(0)] });

    await loadTree(db, {
      sessionId: SESSION_ID,
      organizationId: ORGANIZATION_ID,
    });

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.generation.agentSessionId).toBe(SESSION_ID);
    expect(where.generation.session.artifact.organizationId).toBe(
      ORGANIZATION_ID
    );
    // The count runs on the SAME predicate, which is what makes `droppedCount`
    // a measurement rather than a guess.
    expect(count.mock.calls[0]?.[0]?.where).toStrictEqual(where);
  });

  it("orders by canonical session sequence, so a clip takes the tail", async () => {
    const { db, findMany } = fakeDb({ rows: [dbRow(0)] });

    await loadTree(db, {
      sessionId: SESSION_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(findMany.mock.calls[0]?.[0]?.orderBy?.[0]).toStrictEqual({
      sequence: "asc",
    });
    // One row past the page, so exhaustion is decided by this page's own result
    // rather than against a separately-read count.
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(
      AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS + 1
    );
  });

  it("mints a followable cursor when the page bound was reached", async () => {
    // One row past the page proves there is more; the served page is trimmed
    // back to the bound and the cursor names the last row it actually served.
    const rows = Array.from(
      { length: AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS + 1 },
      (_, index) => dbRow(index)
    );
    const { db } = fakeDb({ rows, total: rows.length });

    const page = await loadTree(db, {
      sessionId: SESSION_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(page?.items).toHaveLength(
      AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS
    );
    expect(
      decodeAgentComponentInvocationSessionTreeCursor(page?.nextCursor)
    ).toStrictEqual({
      sequence: AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS - 1,
      externalInvocationId: `inv-${AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS - 1}`,
      id: `row-${AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS - 1}`,
    });
  });

  it("refuses a cursor it could not have minted, rather than restarting at the head", async () => {
    const { db, findMany } = fakeDb({ rows: [dbRow(0)] });

    await expect(
      loadTree(db, {
        sessionId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
        cursor: "not-a-cursor",
      })
    ).rejects.toThrow(CURSOR_REJECTION_RE);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("serves the 516-row reference session whole, on one page, with no continuation", async () => {
    // The row count that made the component-scoped 500-row read unusable here.
    const rows = Array.from({ length: 516 }, (_, index) => dbRow(index));
    const { db } = fakeDb({ rows, total: 516 });

    const page = await loadTree(db, {
      sessionId: SESSION_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(page?.items).toHaveLength(516);
    expect(page?.total).toBe(516);
    expect(page && "nextCursor" in page).toBe(false);
  });
});
