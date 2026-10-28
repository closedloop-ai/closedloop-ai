/**
 * ISS-7821: `SessionDetail.estimatedCost` is the cloud's OWN derivation of a
 * session's total cost, and it summed only `tokenUsageByModel`. Web search is
 * billed per REQUEST, never per token, so it is not in those rows and no sum of
 * them can contain it — which made this figure systematically LOWER than both
 * desktop derivations by exactly the line item, for every session that used web
 * search. The ISS-7776 reproduction measured that gap at $0.03 on a $0.04753625
 * session, roughly 63% of the total.
 *
 * These cases drive the REAL `agentSessionsService.upsertSessions` and read the
 * `sessionDetail.upsert` argument, because the value under test is produced by
 * the production caller passing the session's metadata into
 * `resolveTokenRollupColumns`. A unit test on that helper alone would stay green
 * with the call site's argument deleted, which is the whole wiring this ticket is.
 *
 * `sessionAnalytics` is deliberately ABSENT from the fixture. When it is present
 * the ISS-7813 write in `persistSessionChildren` overwrites this column with the
 * desktop's own whole-session figure and would mask the derivation under test.
 *
 * ISS-8515 narrowed where this derivation survives, so the sentence that used to
 * stand here — naming "a stale batch that fails the freshness gate" as one of
 * those paths — is no longer true of that half: a stale batch now writes NONE of
 * the rollup columns, so this derivation never reaches the row. What remains is
 * the fresh path with no `sessionAnalytics`, i.e. a desktop build predating the
 * ISS-7813 cost writer. Every case below drives the CREATE arm (`findUnique` →
 * null), where freshness is true by construction, so none is affected by the gate.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "@repo/cost/harness-cost-parity";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedSessionDetail } from "@/__tests__/support/agent-sessions/service.test-harness";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
  generateSlug: vi.fn().mockResolvedValue("SES-0001"),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    SESSION: "SESSION",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: { DbNull: mocks.dbNull },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: mocks.generateSlug,
}));

import { agentSessionsService } from "../service";

const SESSION_STARTED_AT = new Date("2026-08-22T12:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-08-22T12:05:00.000Z");
const COMPUTE_TARGET_ID = "target-web-search-1";
const ORG_ID = "org-web-search-1";
const USER_ID = "user-web-search-1";

/**
 * The ISS-7776 reproduction's numbers, hand-derived from the published
 * claude-opus-4-5 rates rather than read back from any derivation here: 1000
 * input × $5/MTok + 500 output × $25/MTok + 10 cache-read × $0.50/MTok +
 * 5 cache-write × $6.25/MTok. The desktop suite
 * (`apps/desktop/test/session-cost-rollup-divergence.test.ts`) pins the same
 * literal independently, which is what makes "the two surfaces agree" checkable
 * from either side without one asking the other.
 */
const TOKEN_COST_USD = 0.017_536_25;
const WEB_SEARCH_REQUESTS = 3;
/** `roundCost` is `toFixed(6)`, so the stored figures are the 6-dp forms. */
const STORED_TOKEN_ONLY_COST = 0.017_536;
const STORED_TOTAL_COST = 0.047_536;

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-sess-web-search-1",
    name: "Web Search Cost Session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-opus-4-5",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [
      {
        model: "claude-opus-4-5",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        estimatedCostUsd: TOKEN_COST_USD,
      },
    ],
    ...overrides,
  };
}

/** The session metadata blob the collector persists a web-search count into. */
function metadataWithWebSearchRequests(count: number) {
  return { usageExtras: { web_search_requests: count } };
}

function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-web-search-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function buildContext() {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
  };
}

function installDb() {
  const sessionDetailUpsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail("artifact-web-search-1"));

  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    artifact: { findFirst: vi.fn().mockResolvedValue(null) },
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: sessionDetailUpsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    },
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentSessionTokenEvent: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentSessionActivitySegment: {
      findFirst: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentSessionUsageRollup: {
      upsert: vi
        .fn()
        .mockResolvedValue({ artifactId: "artifact-web-search-1" }),
    },
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
  };

  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );

  return { sessionDetailUpsert };
}

/** The `estimatedCost` the create arm actually wrote. */
function upsertedEstimatedCost(upsert: ReturnType<typeof vi.fn>): unknown {
  const args = upsert.mock.calls[0]?.[0] as
    | { create?: Record<string, unknown> }
    | undefined;
  return args?.create?.estimatedCost;
}

/** The `metadata` blob the create arm actually persisted beside that cost. */
function upsertedMetadata(upsert: ReturnType<typeof vi.fn>): unknown {
  const args = upsert.mock.calls[0]?.[0] as
    | { create?: Record<string, unknown> }
    | undefined;
  return args?.create?.metadata;
}

describe("ISS-7821: the cloud cost derivation includes the web-search line item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prices a web-search session to the same total the desktop derives", async () => {
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          metadata: metadataWithWebSearchRequests(WEB_SEARCH_REQUESTS),
        }),
      ])
    );

    // The literal, not a re-derivation: this is the figure the desktop's two
    // derivations already store for these inputs.
    expect(upsertedEstimatedCost(sessionDetailUpsert)).toBe(STORED_TOTAL_COST);
    // And explicitly NOT the token-only figure, which is what it used to be.
    // Without this line the assertion above would still pass on a build that
    // happened to round the old value to the new one.
    expect(upsertedEstimatedCost(sessionDetailUpsert)).not.toBe(
      STORED_TOKEN_ONLY_COST
    );
    // The gap that closed, stated as the quantity it actually is, so a change to
    // the per-request price cannot leave this suite asserting a stale delta.
    expect(STORED_TOTAL_COST - STORED_TOKEN_ONLY_COST).toBeCloseTo(
      WEB_SEARCH_REQUESTS * WEB_SEARCH_COST_PER_REQUEST_USD,
      9
    );
  });

  it("leaves a session that never used web search on its token total", async () => {
    // The negative sibling. Without it the case above is satisfied by anything
    // that adds a constant, including a line item charged to every session.
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession()])
    );

    expect(upsertedEstimatedCost(sessionDetailUpsert)).toBe(
      STORED_TOKEN_ONLY_COST
    );
  });

  it("charges nothing for a metadata blob whose count is absent or nonsense", async () => {
    // A count the collector never wrote, and one no collector could mean, must
    // both price as zero rather than as `NaN` — an arithmetic poison that would
    // reach the column as a confident non-number.
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          metadata: { usageExtras: { web_search_requests: "not-a-number" } },
        }),
      ])
    );

    expect(upsertedEstimatedCost(sessionDetailUpsert)).toBe(
      STORED_TOKEN_ONLY_COST
    );
  });

  it("prices a session whose ONLY cost is web search, with no token rows", async () => {
    // ISS-7821 review (whitlockk, codex): the rollup fold returns early when the
    // payload carries no token usage, so this session used to be created on the
    // column's `@default(0)` — $0 for a session both desktop derivations price
    // at the line item. A Desktop build predating the ISS-7813 cost writer sends
    // exactly this shape, so the line item is the only cost obtainable for it.
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          tokenUsageByModel: [],
          metadata: metadataWithWebSearchRequests(WEB_SEARCH_REQUESTS),
        }),
      ])
    );

    expect(upsertedEstimatedCost(sessionDetailUpsert)).toBe(
      Number((WEB_SEARCH_REQUESTS * WEB_SEARCH_COST_PER_REQUEST_USD).toFixed(6))
    );
    // Not the zero it used to be, stated separately so the assertion above
    // cannot be satisfied by a build that happens to write the default.
    expect(upsertedEstimatedCost(sessionDetailUpsert)).not.toBe(0);
    // And the token columns stay OMITTED: writing zeros to them would desync the
    // rollup from a per-model table `persistSessionChildren` deliberately left
    // alone on an empty payload.
    const createArgs = sessionDetailUpsert.mock.calls[0]?.[0] as {
      create?: Record<string, unknown>;
    };
    expect(createArgs.create).not.toHaveProperty("inputTokens");
  });

  it("prices the metadata it PERSISTS, not the raw payload", async () => {
    // ISS-7821 review (davetho). `sanitizeMetadataForPersist` compacts through
    // `compactMetadataForPreview`, which keeps only the first `MAX_METADATA_KEYS`
    // own keys — so a count sitting past that cut is dropped from the stored
    // blob. Pricing the RAW payload would then write a non-zero cost beside
    // metadata that contains no count at all, leaving the cloud's dollar figure
    // unreproducible from its own persisted source.
    const { sessionDetailUpsert } = installDb();
    const prunedMetadata = {
      ...Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [`filler${index}`, index])
      ),
      ...metadataWithWebSearchRequests(WEB_SEARCH_REQUESTS),
    };

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ metadata: prunedMetadata })])
    );

    // The count did not survive compaction...
    expect(upsertedMetadata(sessionDetailUpsert)).not.toHaveProperty(
      "usageExtras"
    );
    // ...so no line item is charged, and the stored cost reconciles with the
    // stored metadata.
    expect(upsertedEstimatedCost(sessionDetailUpsert)).toBe(
      STORED_TOKEN_ONLY_COST
    );
    // The counterfactual that keeps this from passing vacuously: the SAME count,
    // in a blob compaction does not prune, is still charged. Without it this
    // case would also pass on a build that had simply stopped reading metadata.
    const survives = installDb();
    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          metadata: metadataWithWebSearchRequests(WEB_SEARCH_REQUESTS),
        }),
      ])
    );
    expect(upsertedMetadata(survives.sessionDetailUpsert)).toHaveProperty(
      "usageExtras"
    );
    expect(upsertedEstimatedCost(survives.sessionDetailUpsert)).toBe(
      STORED_TOTAL_COST
    );
  });
});
