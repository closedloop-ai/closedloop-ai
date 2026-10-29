/**
 * ISS-8515: the token rollup is FRESHNESS-GATED, and `estimated_cost` is written
 * explicitly or not at all.
 *
 * Before this, `resolveTokenRollupColumns` stamped a token-derived cost plus the
 * four count columns through BOTH arms of `sessionDetail.upsert` gated only on
 * "this payload has token rows". The freshness-gated authoritative writer in
 * `persistSessionChildren` runs later in the same transaction and wins on a fresh
 * batch — but it is SKIPPED on a stale one, so a late-arriving older batch
 * clobbered a newer cost. The per-model `agent_session_token_usage` rows were
 * ungated the same way.
 *
 * These cases drive the REAL `agentSessionsService.upsertSessions` through the
 * shared harness and read the observable writes: the `sessionDetail.upsert`
 * argument and the `agentSessionTokenUsage` delete/create spies. A unit test on
 * the resolver alone would stay green with the gate deleted at the call site,
 * which is the wiring this ticket is.
 *
 * `sessionAnalytics` is deliberately ABSENT from every fixture. When it is present
 * the ISS-7813 authoritative write overwrites this column later in the same
 * transaction and would mask the derivation under test; the paths where it does
 * NOT — a stale batch, and a Desktop build predating that writer — are exactly the
 * ones where this derivation is what survives.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  persistedSessionDetail,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const statusActivity = vi.hoisted(() => ({
  writeSessionArtifactMetadata: vi.fn(),
  captureCommittedSessionMetadata: vi.fn(),
}));
vi.mock("./session-ingest-metadata-activity", () => statusActivity);

import { agentSessionsService } from "../service";

beforeEach(() => {
  statusActivity.writeSessionArtifactMetadata.mockResolvedValue(null);
});

const PERSISTED_ARTIFACT_ID = "persisted-session-1";
const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
};

/** Older than the stored watermark — the stale-batch shape. */
const OLDER_UPDATED_AT = new Date(SESSION_UPDATED_AT.getTime() - 60_000);
const WEB_SEARCH_METADATA = { usageExtras: { web_search_requests: 3 } };

function pricedTokenRows(): SyncedAgentSession["tokenUsageByModel"] {
  return [
    {
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      estimatedCostUsd: 1.5,
    },
  ];
}

/** Token rows whose cost key is OMITTED — the wire field is optional. */
function unpricedTokenRows(): SyncedAgentSession["tokenUsageByModel"] {
  return [
    {
      model: "some-unpriced-model",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ];
}

function buildPayload(session: SyncedAgentSession) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-8515",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  };
}

/** The stored row a stale batch must not disturb. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: PERSISTED_ARTIFACT_ID,
    agents: [],
    dataRevision: null,
    pendingChunkRevision: null,
    pendingChunkTotal: null,
    pendingChunkReceived: null,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: null,
    activitySegmentRowsStripped: null,
    awaitingInputSince: null,
    estimatedCost: null,
    inputTokens: 0n,
    outputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    artifact: { status: null },
    ...overrides,
  };
}

/**
 * Drive one apply and return the observable writes.
 *
 * `existingRow: null` means no stored row, so Postgres takes the CREATE arm.
 * `agentSessionTokenUsage` is supplied through `installDb`'s override seam — the
 * shared harness does not provide it, and these two spies are the ONLY evidence
 * of the per-model gate.
 */
async function applyBatch(params: {
  session: SyncedAgentSession;
  existingRow: Record<string, unknown> | null;
}) {
  const upsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail(PERSISTED_ARTIFACT_ID));
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const createMany = vi.fn().mockResolvedValue({ count: 0 });

  installDb({
    slugCounter: buildSlugCounterMock(),
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(params.existingRow),
      upsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: { deleteMany, createMany },
  });

  await agentSessionsService.upsertSessions(
    CONTEXT,
    buildPayload(params.session)
  );

  if (upsert.mock.calls.length !== 1) {
    throw new Error(
      `expected exactly one sessionDetail.upsert, saw ${upsert.mock.calls.length}`
    );
  }
  const arg = upsert.mock.calls[0][0];
  return {
    create: arg.create as Record<string, unknown>,
    update: arg.update as Record<string, unknown>,
    perModelReplaced: deleteMany.mock.calls.length > 0,
    createManyCalls: createMany.mock.calls.length,
  };
}

describe("ISS-8515: a STALE batch changes no cost, no counts, no per-model rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves cost, the four counts, AND the per-model rows untouched", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession({
        updatedAt: OLDER_UPDATED_AT.toISOString(),
        tokenUsageByModel: pricedTokenRows(),
      }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    // All three move as ONE unit (ruling 1). Asserting only the cost would pass
    // with the counts still leaking, which flips the DISPLAYED cost basis.
    expect(writes.update).not.toHaveProperty("estimatedCost");
    expect(writes.update).not.toHaveProperty("inputTokens");
    expect(writes.update).not.toHaveProperty("outputTokens");
    expect(writes.update).not.toHaveProperty("cacheReadTokens");
    expect(writes.update).not.toHaveProperty("cacheWriteTokens");
    expect(writes.perModelReplaced).toBe(false);
    expect(writes.createManyCalls).toBe(0);
  });

  it("passes the existing Session status through the ingest receipt boundary", async () => {
    const prior = {
      artifactId: PERSISTED_ARTIFACT_ID,
      status: SESSION_STATUS.ACTIVE,
      projectId: null,
      afterStatus: SESSION_STATUS.ACTIVE,
      afterProjectId: null,
    };
    statusActivity.writeSessionArtifactMetadata.mockResolvedValueOnce(prior);
    await applyBatch({
      session: buildSyncedSession({ status: SESSION_STATUS.INACTIVE }),
      existingRow: storedRow({ artifact: { status: SESSION_STATUS.ACTIVE } }),
    });

    expect(statusActivity.writeSessionArtifactMetadata).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        organizationId: CONTEXT.organizationId,
        artifactId: PERSISTED_ARTIFACT_ID,
      })
    );
    expect(statusActivity.captureCommittedSessionMetadata).toHaveBeenCalledWith(
      expect.any(Object),
      CONTEXT.organizationId,
      prior,
      PERSISTED_ARTIFACT_ID
    );
  });

  it("leaves a web-search-only stale batch untouched", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession({
        updatedAt: OLDER_UPDATED_AT.toISOString(),
        metadata: WEB_SEARCH_METADATA,
      }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    expect(writes.update).not.toHaveProperty("estimatedCost");
  });

  it("withholds the counts from the CREATE arm it may still reach under the READ COMMITTED race", async () => {
    // The arm Postgres takes is decided by the row's existence AT WRITE TIME,
    // not by what the finder saw. ISS-5648: the finder can return a row, this
    // batch can resolve STALE against it, and the row can then be concurrently
    // deleted — so the CREATE branch of this very upsert executes carrying a
    // stale payload. Both branches of the argument are therefore live, and the
    // three sibling cases above only ever read `update`.
    //
    // This is the case that fails when the create arm's gate is removed.
    // Measured: replacing the gated spread with a bare `...tokenRollupColumns`
    // leaves every other test in app/agent-sessions green.
    const writes = await applyBatch({
      session: buildSyncedSession({
        updatedAt: OLDER_UPDATED_AT.toISOString(),
        tokenUsageByModel: pricedTokenRows(),
      }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    // Counts withheld: writing them here while the per-model gate suppresses the
    // rows leaves rollupTokenTotal > 0 against zero token events — a
    // half-written state Ruling 1 forbids. (Pre-ISS-7176 this also flipped a
    // now-deleted `isTokenComplete`/`SessionCostBasis` completeness read; the
    // half-written state itself is still the thing under test.)
    expect(writes.create).not.toHaveProperty("inputTokens");
    expect(writes.create).not.toHaveProperty("outputTokens");
    expect(writes.create).not.toHaveProperty("cacheReadTokens");
    expect(writes.create).not.toHaveProperty("cacheWriteTokens");
    // The key is still NAMED — never omitted, or the dropped DEFAULT would leave
    // it to the schema. Null, because a stale batch may not price the row.
    expect(writes.create.estimatedCost).toBeNull();
    expect(writes.perModelReplaced).toBe(false);
    expect(writes.createManyCalls).toBe(0);
  });

  it("is a no-op when the SAME stale batch is applied twice", async () => {
    const session = buildSyncedSession({
      updatedAt: OLDER_UPDATED_AT.toISOString(),
      tokenUsageByModel: pricedTokenRows(),
    });
    const existingRow = storedRow({ estimatedCost: 5 });

    const first = await applyBatch({ session, existingRow });
    const second = await applyBatch({ session, existingRow });

    for (const writes of [first, second]) {
      expect(writes.update).not.toHaveProperty("estimatedCost");
      expect(writes.perModelReplaced).toBe(false);
    }
  });
});

describe("ISS-8515: a FRESH batch writes all three", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes cost, the four counts, and replaces the per-model rows", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession({ tokenUsageByModel: pricedTokenRows() }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    expect(writes.update.estimatedCost).toBe(1.5);
    expect(writes.update.inputTokens).toBe(1000);
    expect(writes.perModelReplaced).toBe(true);
    expect(writes.createManyCalls).toBe(1);
  });
});

describe("ISS-8515: the CREATE arm always NAMES the cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes an explicit null when nothing priced the session and there is no web search", async () => {
    // The branch the ticket exists for: `resolveTokenRollupColumns` returns `{}`,
    // the create arm used to OMIT the column, and the schema `@default(0)` then
    // reported a confident $0 for a session nothing ever priced.
    const writes = await applyBatch({
      session: buildSyncedSession(),
      existingRow: null,
    });

    expect(writes.create).toHaveProperty("estimatedCost");
    expect(writes.create.estimatedCost).toBeNull();
  });

  it("writes null rather than 0 when token rows carry no cost at all", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession({ tokenUsageByModel: unpricedTokenRows() }),
      existingRow: null,
    });

    expect(writes.create.estimatedCost).toBeNull();
    // The counts still land — the rows exist, only their pricing is unknown.
    expect(writes.create.inputTokens).toBe(1000);
  });

  it("writes a real $0 when a row reports exactly zero, never null", async () => {
    // Distinguishes a correct `!== undefined` predicate from a truthiness or
    // `> 0` reading. A genuinely free session is measured, not unknown.
    const writes = await applyBatch({
      session: buildSyncedSession({
        tokenUsageByModel: [{ ...unpricedTokenRows()[0], estimatedCostUsd: 0 }],
      }),
      existingRow: null,
    });

    expect(writes.create.estimatedCost).toBe(0);
  });

  it("prices a web-search-only create at the line item", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession({ metadata: WEB_SEARCH_METADATA }),
      existingRow: null,
    });

    expect(writes.create.estimatedCost).toBeGreaterThan(0);
  });
});

describe("ISS-12251: the CREATE arm assigns the session to its uploader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects the new artifact's assignee to the authenticated user", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession(),
      existingRow: null,
    });

    const artifact = writes.create.artifact as {
      create: Record<string, unknown>;
    };
    expect(artifact.create.assignee).toEqual({
      connect: { id: CONTEXT.userId },
    });
  });

  it("never names the assignee on the UPDATE arm", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession(),
      existingRow: storedRow(),
    });

    // The arm does write the artifact (name, status), so this is not vacuous.
    expect(writes.update).toHaveProperty("artifact.update.name");
    expect(JSON.stringify(writes.update)).not.toContain("assignee");
  });
});

describe("ISS-8515: the erase guard never replaces a stored numeric cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves a stored $5 when a fresh payload cannot price its token rows", async () => {
    const writes = await applyBatch({
      session: buildSyncedSession({ tokenUsageByModel: unpricedTokenRows() }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    // The key is OMITTED, not written as null: writing null would erase a real
    // authoritative figure this payload had no evidence to overturn.
    expect(writes.update).not.toHaveProperty("estimatedCost");
    // The counts still refresh — only the cost is protected.
    expect(writes.update.inputTokens).toBe(1000);
  });

  it("preserves a stored cost even when the payload carries a web-search line item", async () => {
    // The hole an earlier design left open: the guard fired only when
    // webSearchCost === 0, so unpriced token rows PLUS web-search metadata fell
    // through and replaced a stored authoritative total with the line item alone.
    const writes = await applyBatch({
      session: buildSyncedSession({
        tokenUsageByModel: unpricedTokenRows(),
        metadata: WEB_SEARCH_METADATA,
      }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    expect(writes.update).not.toHaveProperty("estimatedCost");
  });

  it("leaves a legacy stored 0 alone rather than converging it to null", async () => {
    // Deliberate and stated: `0` is numeric, so the guard holds it. Repairing
    // already-written zeros is the backfill (ISS-8517), not this ticket. Pinned
    // so it is not later "fixed" into a branch that erases stored data.
    const writes = await applyBatch({
      session: buildSyncedSession({ tokenUsageByModel: unpricedTokenRows() }),
      existingRow: storedRow({ estimatedCost: 0 }),
    });

    expect(writes.update).not.toHaveProperty("estimatedCost");
  });

  it("still overwrites when the fresh payload CAN price the session", async () => {
    // The negative sibling: without it, "preserves a stored cost" would be
    // satisfied by a build that never writes the column at all.
    const writes = await applyBatch({
      session: buildSyncedSession({ tokenUsageByModel: pricedTokenRows() }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    expect(writes.update.estimatedCost).toBe(1.5);
  });

  it("LOCK TEST — a PARTIALLY priced payload still overwrites with the partial sum", async () => {
    // Pinning behaviour this ticket deliberately did NOT change, so the accepted
    // risk is visible instead of merely argued in a plan.
    //
    // `anyRowPriced` is ANY, not ALL. One priced row among unpriced ones makes it
    // true, the erase guard stands down, and the stored figure is replaced by a
    // sum over only the rows that carried a price — $1.50 here, though two of the
    // three models were used. That under-reports, and it is exactly as true on
    // `main`: this ticket's gate changes WHEN the rollup may write, never what it
    // computes when it does.
    //
    // Not fixed here because the fix is a product question — whether a partial
    // sum, the stored value, or null is the honest answer for a partly-priced
    // session — and this change already carries a migration.
    const writes = await applyBatch({
      session: buildSyncedSession({
        tokenUsageByModel: [
          ...pricedTokenRows(),
          ...unpricedTokenRows(),
          { ...unpricedTokenRows()[0], model: "another-unpriced-model" },
        ],
      }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    expect(writes.update.estimatedCost).toBe(1.5);
  });
});

describe("ISS-8515: chunked delivery of one snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits a later chunk carrying the SAME updatedAt as the stored watermark", async () => {
    // Chunks 1..N of one snapshot share `session.updatedAt`, so they survive only
    // because the comparison is `>=`. Nothing pinned that, and tightening it to
    // `>` would now silently drop every later chunk's token rows as well as its
    // counts — the per-model write depends on the same flag.
    const writes = await applyBatch({
      session: buildSyncedSession({
        updatedAt: SESSION_UPDATED_AT.toISOString(),
        tokenUsageByModel: pricedTokenRows(),
      }),
      existingRow: storedRow({ estimatedCost: 5 }),
    });

    expect(writes.update.estimatedCost).toBe(1.5);
    expect(writes.perModelReplaced).toBe(true);
  });
});
