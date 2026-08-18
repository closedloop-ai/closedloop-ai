/**
 * @file soak-oracle-test-support.ts
 * @description Shared fixtures and drivers for the soak-oracle assertion
 * suites (`soak-oracle-content-assertions.test.ts`,
 * `soak-oracle-page-read-assertions.test.ts`).
 *
 * Extracted when the single suite outgrew the repo's 1,000-line file ceiling.
 * The two suites cover different oracles — what the cloud RETAINED of a payload
 * versus how a page read is GRADED — but they score through the same
 * `buildCycleRecord` entry point, so their fixtures belong in one module rather
 * than being copied into each.
 *
 * Fixtures here are contract-valid by DEFAULT. `sessionFixture` carries every
 * field the ingest schema requires, so a case that wants a violation must
 * remove one explicitly; a fixture that was quietly invalid would make every
 * suite fail for a reason it is not about.
 */

import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "@repo/api/src/types/agent-session";
import type { MockCloudServer, MockCloudStats } from "./mock-cloud-server";
import type { ReadBackEntry, RelationCounts } from "./soak-cloud-content";
import { buildCycleRecord } from "./soak-cycle-record";
import { newPageReadStats } from "./soak-page-read";
import type {
  CycleContext,
  CycleRecord,
  CycleState,
  CycleWorkspace,
  Mode,
  PageReadStats,
} from "./soak-types";

export const COMPUTE_TARGET_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The relation arrays production's ingest schema declares without
 * `.optional()`/`.nullish()`. Absence is a producer regression; emptiness is
 * not — every case below is driven in both directions for each of them.
 */
export const REQUIRED_RELATIONS = [
  "agents",
  "events",
  "tokenUsageByModel",
] as const;

export type TestSession = Record<string, unknown>;

export function sessionFixture(overrides: TestSession = {}): TestSession {
  return {
    externalSessionId: "session-a",
    status: "inactive",
    startedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    dataRevision: 1,
    events: [{ id: "e1" }, { id: "e2" }],
    agents: [{ id: "a1" }],
    // Contract-valid by default: this is required upstream, so a fixture
    // omitting it would make every case here a required-relation violation.
    tokenUsageByModel: [],
    tokenEvents: [],
    metadata: { harness: "claude" },
    ...overrides,
  };
}

/**
 * POST a batch body verbatim. Used by the cases that must control the ENVELOPE
 * — most importantly one that omits `schemaVersion` entirely, which `postBatch`
 * cannot express. Returns the status so tolerance (accept-and-record) is
 * asserted rather than assumed.
 */
export async function postRawBatch(
  mock: MockCloudServer,
  body: Record<string, unknown>
): Promise<number> {
  const response = await fetch(
    `${mock.apiOrigin}/desktop/agent-sessions/sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return response.status;
}

export async function postBatch(
  mock: MockCloudServer,
  sessions: TestSession[],
  batchId = "batch-1"
): Promise<void> {
  const status = await postRawBatch(mock, {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId,
    syncMode: "backfill",
    sessionCount: sessions.length,
    sessions,
  });
  if (status !== 200) {
    throw new Error(`sync POST returned ${status}`);
  }
}

export async function fetchReadBack(mock: MockCloudServer): Promise<{
  index: {
    externalSessionId: string;
    contentDigest: string;
    relations: Record<string, number>;
    deliveries: number;
  }[];
  sample: { externalSessionId: string }[];
  sampleBytes: number;
}> {
  const response = await fetch(`${mock.apiOrigin}${mock.readBackPath}`);
  if (response.status !== 200) {
    throw new Error(`read-back GET returned ${response.status}`);
  }
  return await response.json();
}

export function statsFixture(
  overrides: Partial<MockCloudStats> = {}
): MockCloudStats {
  const syncedSessionIds = overrides.syncedSessionIds ?? [];
  return {
    helloCount: 1,
    refreshCount: 1,
    identityCount: 1,
    rawSessionReceives: syncedSessionIds.length,
    syncedSessionIds,
    receivesBySession: Object.fromEntries(
      syncedSessionIds.map((id) => [id, 1])
    ),
    deliveriesBySession: Object.fromEntries(
      syncedSessionIds.map((id) => [id, 1])
    ),
    // ISS-6101: the fixture declares no revisions, so each session is delivered
    // once at the absent-revision key — mirroring what `recordDelivery` writes
    // for a payload carrying no `dataRevision`. One delivery each is clean under
    // both the session-level and the (session, revision) duplicate oracles.
    // ISS-6101: the fixture declares no revisions of its own, so each session is
    // delivered once at a single real revision. It must be a REAL one (integer
    // >= 1): an absent revision is not scored on this axis at all, so keying the
    // baseline at "null" would leave the duplicate oracle with nothing to see.
    deliveriesBySessionRevision: Object.fromEntries(
      syncedSessionIds.map((id) => [`${id}#1`, 1])
    ),
    unrevisionedDeliveriesBySession: {},
    staleRevisionDeliveries: [],
    deliveredReceiveUnits: syncedSessionIds.length,
    incompleteChunkSessions: [],
    invocationPartReceives: 0,
    componentBatchReceives: 0,
    transcriptRequests: 0,
    unknownPaths: [],
    gzipBatches: 1,
    identityBatches: 0,
    unexpectedSchemaVersions: [],
    batchesMissingSchemaVersion: 0,
    ...overrides,
  };
}

export function readBackFixture(
  index: ReturnType<typeof readBackEntry>[],
  overrides: Partial<
    NonNullable<Parameters<typeof buildCycleRecord>[2]["readBack"]>
  > = {}
): NonNullable<Parameters<typeof buildCycleRecord>[2]["readBack"]> {
  return {
    index,
    violations: [],
    violationCount: 0,
    sample: [],
    sampleBytes: 0,
    sampleTruncated: false,
    ...overrides,
  };
}

export function readBackEntry(
  externalSessionId: string,
  relations: Partial<RelationCounts> = {}
): ReadBackEntry {
  return {
    externalSessionId,
    contentDigest: "0".repeat(64),
    relations: {
      events: 2,
      agents: 1,
      tokenEvents: 0,
      tokenUsageByModel: 0,
      activityBuckets: 0,
      activitySegmentRows: 0,
      prs: 0,
      ...relations,
    },
    metadataKeys: 1,
    payloadBytes: 512,
    deliveries: 1,
  };
}

/**
 * Score one cycle from injected state. `buildCycleRecord` reads
 * `context.mock.stats()`, so the mock is stubbed down to that one accessor
 * rather than starting a server for the pure-scoring cases.
 */
export function buildRecord(input: {
  stats: MockCloudStats;
  readBack: Parameters<typeof buildCycleRecord>[2]["readBack"];
  baseline?: string[];
  localSessionIds?: string[];
  localSessionsWithEvents?: string[];
  pageReads?: PageReadStats;
  mode?: Mode;
}): CycleRecord {
  const baseline = input.baseline ?? ["session-a"];
  const workspace: CycleWorkspace = {
    userDataDir: "/tmp/soak-test",
    dbPath: "/tmp/soak-test/agent-dashboard.sqlite",
    artifactsDir: "/tmp/soak-test/artifacts",
    stdioLogPath: "/tmp/soak-test/artifacts/stdio.log",
    baseline,
    localSessionIds: input.localSessionIds ?? baseline,
    localSessionsWithEvents: input.localSessionsWithEvents ?? [],
    startDepths: {
      pending: baseline.length,
      deadLettered: 0,
      invocationPending: 0,
    },
  };
  const context = {
    cycleIndex: 1,
    options: {
      cycles: 1,
      mode: input.mode ?? "clean",
      out: "/tmp/soak-test/out.jsonl",
      snapshot: "/tmp/soak-test/snapshot.sqlite",
      drainBudgetMs: 60_000,
      workRoot: "/tmp/soak-test",
      loadGateMax: 25,
    },
    mock: { stats: () => input.stats } as unknown as CycleContext["mock"],
    homes: {},
    workspace,
    startMs: Date.now() - 1000,
  } satisfies CycleContext;
  const state: CycleState = {
    launched: {} as CycleState["launched"],
    oomHitSets: [],
    pageReads: input.pageReads ?? {
      ...newPageReadStats(),
      ok: 10,
      expectedTotal: 2962,
    },
    monotonicViolations: [],
    notes: [],
    failReasons: [],
    dbHostKills: 0,
    dbHostRecovered: null,
    appKills: 0,
    appRelaunched: null,
    unexpectedAppExit: false,
    drainCompleted: true,
    lastDepth: 0,
  };
  return buildCycleRecord(context, state, {
    startedAt: new Date().toISOString(),
    loadAvgStart: 1,
    endDepths: { pending: 0, deadLettered: 0, invocationPending: 0 },
    readBack: input.readBack,
  });
}

/** Score a record straight off a live mock's retained content. */
export function recordFor(
  stats: MockCloudStats,
  options: { readBackFrom: MockCloudServer }
): CycleRecord {
  return buildRecord({
    stats,
    readBack: options.readBackFrom.readBack(),
    baseline: stats.syncedSessionIds,
    localSessionIds: stats.syncedSessionIds,
  });
}
