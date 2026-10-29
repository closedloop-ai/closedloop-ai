import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import { perAssigneeAggregateOwner } from "@/__tests__/support/agent-sessions/usage-owner-groups.test-mocks";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";
import { agentSessionsService } from "../service";

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

const START = "2026-07-08T00:00:00.000Z";
const END = "2026-07-14T23:59:59.999Z";
const LINKED_SESSION_ID = "session-1";
const LINK_TARGET_ID = "branch-1";
const LINK_PROJECT_ID = "project-1";
const LINK_PROJECT_NAME = "Acme";

/**
 * The Project facet's population read (ISS-11895). It shares the
 * `artifact.findMany` delegate with attribution's target read, so the gate keys
 * it apart by its `where.session` — one key for both would let either read
 * stand in for the other in the checks below.
 */
const FACET_POPULATION_READ = "artifact.findMany(where.session)";
/**
 * The read each sibling path opens with: attribution's link read (and its
 * existence probe), and the Project facet's population read.
 */
const SIBLING_FIRST_READS = ["artifactLink.findMany", FACET_POPULATION_READ];
/**
 * The reads a sibling path issues only once its first read came back with
 * ROWS: attribution's session and target reads, and the Project facet's
 * aggregate. Each is submitted through the caller's limiter, and each of those
 * three wrappers is what the seeded case below exists to pin.
 */
const SECOND_STAGE_READS = [
  "sessionDetail.findMany",
  "artifact.findMany",
  "$queryRaw",
];
const SIBLING_PATH_READS = new Set([
  ...SIBLING_FIRST_READS,
  ...SECOND_STAGE_READS,
]);

type GatedRead = { key: string; release: () => void };

/**
 * Every read the request dispatched but that has not resolved yet. `withDb`
 * holds no connection — each query inside it borrows its own pooled pg
 * connection (see `lib/db-fanout.ts`) — so one entry here is one connection the
 * pool has checked out, and `pending.length` IS the request's in-flight
 * acquire count. Nothing is timed: a read stays pending until the driver below
 * releases it, so the count is read from the queue rather than raced for.
 */
const pending: GatedRead[] = [];

/** The assignee of every per-Owner aggregate that actually ran, in run order. */
const ownerAggregateReads: string[] = [];

function gateReads(
  db: Record<string, unknown>,
  path = ""
): Record<string, unknown> {
  const gated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(db)) {
    const readKey = path ? `${path}.${key}` : key;
    if (typeof value === "function") {
      const original = value as (...args: unknown[]) => unknown;
      gated[key] = (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          pending.push({
            key: gatedReadKey(readKey, args[0]),
            release: () => {
              Promise.resolve(original(...args)).then(resolve, reject);
            },
          });
        });
      continue;
    }
    if (value && typeof value === "object") {
      gated[key] = gateReads(value as Record<string, unknown>, readKey);
      continue;
    }
    gated[key] = value;
  }
  return gated;
}

/**
 * Drive one usage read to completion, releasing every gated query in waves and
 * recording how wide each wave was. A wave is sampled only after `setImmediate`
 * has let the whole microtask queue drain, so it counts everything the request
 * had dispatched at that instant — not whatever happened to have been queued
 * first.
 */
async function collectFanoutWaves(): Promise<{
  waves: number[];
  totalReads: number;
  summary: Awaited<ReturnType<typeof agentSessionsService.getUsageSummary>>;
}> {
  let settled = false;
  const read = startUsageRead(() => {
    settled = true;
  });

  const waves: number[] = [];
  let totalReads = 0;
  let turns = 0;
  while (!settled) {
    turns += 1;
    assertProgress(turns);
    await nextTurn();
    if (pending.length === 0) {
      continue;
    }
    waves.push(pending.length);
    totalReads += pending.length;
    for (const gated of pending.splice(0, pending.length)) {
      gated.release();
    }
  }
  return { waves, totalReads, summary: await read };
}

function installGatedDb({
  linked,
  assigneeIds = [],
}: {
  linked: boolean;
  assigneeIds?: readonly string[];
}) {
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      aggregate: vi.fn((args: unknown) => {
        const owner = perAssigneeAggregateOwner(args);
        if (owner !== undefined) {
          ownerAggregateReads.push(owner);
        }
        return Promise.resolve({
          _count: { _all: 10 },
          _sum: {
            inputTokens: 100,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCost: 0,
          },
          _min: { sessionStartedAt: new Date(START) },
          _max: { sessionStartedAt: new Date(END) },
        });
      }),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi
        .fn()
        .mockResolvedValue(linked ? [attributionSessionRow()] : []),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    loop: { findMany: vi.fn().mockResolvedValue([]) },
    // Empty here is what makes BOTH sibling paths stop at their first read —
    // see the seeded case for why that leaves three limiter wrappers unpinned.
    artifactLink: {
      findMany: vi.fn().mockResolvedValue(linked ? linkRows() : []),
    },
    artifact: {
      findMany: vi.fn((args: ArtifactFindManyArgs) =>
        Promise.resolve(linked ? linkedArtifactRows(args) : [])
      ),
      groupBy: vi
        .fn()
        .mockResolvedValue(assigneeIds.map((assigneeId) => ({ assigneeId }))),
    },
    $queryRaw: vi.fn().mockResolvedValue(linked ? [projectCountRow()] : []),
  });
  // `installDb` composes the model mocks and binds them to `withDb`; re-bind to
  // a gated view of that SAME object so the defaults it filled in are gated too.
  const composed = mocks.withDb((db: unknown) => db) as Record<string, unknown>;
  const gated = gateReads(composed);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(gated)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(gated)
  );
}

describe("agentSessionsService.getUsageSummary — pooled-read fan-out bound (ISS-7598)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
    ownerAggregateReads.length = 0;
  });

  it("never has more than DB_FANOUT_MAX_CONCURRENCY reads in flight at once", async () => {
    installGatedDb({ linked: false });

    const { waves, totalReads, summary } = await collectFanoutWaves();

    const peak = Math.max(...waves);
    // The bound itself. Before ISS-7598 this stage peaked at 10 against a
    // 10-connection pool, so one request could take the whole pool.
    expect(peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
    // …and it is the limiter that holds it there, not an accidentally narrow
    // read. Asserting equality is what makes this fail BOTH ways: removing the
    // limiter widens the peak past the bound, and serializing the stage (the
    // shape ISS-7343 removed) collapses it below.
    expect(peak).toBe(DB_FANOUT_MAX_CONCURRENCY);
    // The bound must come from queueing, never from issuing fewer reads: the
    // count and idle reveal the summary publishes are read by these very
    // queries. More waves than the peak is the queueing itself, observed.
    expect(totalReads).toBeGreaterThan(DB_FANOUT_MAX_CONCURRENCY);
    // Positive sibling: a read that threw or short-circuited would satisfy every
    // count above while publishing nothing.
    expect(summary.totalSessions).toBe(10);
  }, 10_000);

  it("holds the bound while the sibling paths' second reads start", async () => {
    installGatedDb({ linked: true });

    const { widths, keysByTurn, summary } = await collectSaturatedTurns();

    // The case above releases every pending read at once, so by the time a
    // sibling path's SECOND read is dispatched the limiter is empty and would
    // admit it either way. This driver instead releases ONE read per turn and
    // takes the sibling paths first, so four stage-1 leaves stay parked in
    // slots while attribution and the Project facet walk their remaining reads.
    // Every sibling read, first reads included: the facet's population read has
    // to arrive under its own key, or it is the read that stands in for
    // attribution's target read here.
    const neverRan = [...SIBLING_PATH_READS].filter(
      (key) => !keysByTurn.some((keys) => keys.includes(key))
    );
    expect(neverRan).toEqual([]);

    // The saturation witness, and what makes the bound above non-vacuous here:
    // every turn up to and including the last second-stage dispatch sat at the
    // bound, so the limiter was FULL each time one of those reads started.
    // Drop any one of the three wrappers and that read fires beside the four
    // parked leaves instead of queueing behind them, making the turn 6 wide.
    const lastSecondStageTurn = Math.max(
      ...SECOND_STAGE_READS.map((key) =>
        keysByTurn.findIndex((keys) => keys.includes(key))
      )
    );
    expect(widths.slice(0, lastSecondStageTurn + 1)).toEqual(
      Array.from(
        { length: lastSecondStageTurn + 1 },
        () => DB_FANOUT_MAX_CONCURRENCY
      )
    );
    expect(Math.max(...widths)).toBe(DB_FANOUT_MAX_CONCURRENCY);

    // Positive siblings: both paths had to run to completion, not just start.
    // Attribution publishes the branch only if its target read resolved, the
    // Project facet publishes only if its aggregate resolved, and the summary
    // itself only if stage 1 ever drained behind the parked leaves.
    expect(summary.byBranch?.map((branch) => branch.branchArtifactId)).toEqual([
      LINK_TARGET_ID,
    ]);
    expect(summary.byProject).toEqual([
      {
        projectId: LINK_PROJECT_ID,
        projectName: LINK_PROJECT_NAME,
        sessionCount: 1,
      },
    ]);
    expect(summary.totalSessions).toBe(10);
  }, 10_000);

  it("holds the bound across the per-Owner aggregates when the population has more assignees than slots", async () => {
    // ISS-12251: the Owner breakdown reads one aggregate per distinct assignee
    // (`usage-owner-groups.ts`), so its width is the org's owner count, not a
    // constant. More assignees than the bound is what makes this observable:
    // with the limiter gone, every one of them is dispatched in the same wave.
    const assigneeIds = Array.from(
      { length: DB_FANOUT_MAX_CONCURRENCY * 2 + 1 },
      (_, index) => `owner-${index}`
    );
    installGatedDb({ linked: false, assigneeIds });

    const { waves } = await collectFanoutWaves();

    expect(Math.max(...waves)).toBe(DB_FANOUT_MAX_CONCURRENCY);
    // Positive sibling: the bound came from queueing, not from skipping owners.
    expect([...ownerAggregateReads].sort()).toEqual([...assigneeIds].sort());
  }, 10_000);
});

/**
 * Drive one usage read to completion releasing exactly ONE gated query per
 * turn, sibling-path reads first. Taking them first is the whole mechanism:
 * releasing a sibling read frees one limiter slot, the next queued stage-1 leaf
 * takes it, and the sibling's follow-up read is submitted into a limiter that is
 * already back at its bound — so a follow-up that skipped the limiter is visible
 * as a turn one wider than the bound.
 */
async function collectSaturatedTurns(): Promise<{
  widths: number[];
  keysByTurn: string[][];
  summary: Awaited<ReturnType<typeof agentSessionsService.getUsageSummary>>;
}> {
  let settled = false;
  const read = startUsageRead(() => {
    settled = true;
  });

  const keysByTurn: string[][] = [];
  let turns = 0;
  while (!settled) {
    turns += 1;
    assertProgress(turns);
    await nextTurn();
    if (pending.length === 0) {
      continue;
    }
    keysByTurn.push(pending.map((gated) => gated.key));
    const siblingIndex = pending.findIndex((gated) =>
      SIBLING_PATH_READS.has(gated.key)
    );
    const [released] = pending.splice(
      siblingIndex === -1 ? 0 : siblingIndex,
      1
    );
    released?.release();
  }
  return {
    widths: keysByTurn.map((keys) => keys.length),
    keysByTurn,
    summary: await read,
  };
}

function startUsageRead(onSettled: () => void) {
  return agentSessionsService
    .getUsageSummary({
      organizationId: "org-1",
      filters: { startDate: START, endDate: END },
    })
    .finally(onSettled);
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function assertProgress(turns: number) {
  if (turns > 500) {
    throw new Error(
      "usage read never settled — a gated query was never dispatched or never released"
    );
  }
}

/** One session→link row, the edge attribution reads. */
function linkRows() {
  return [
    {
      sourceId: LINKED_SESSION_ID,
      targetId: LINK_TARGET_ID,
      metadata: null,
    },
  ];
}

type ArtifactFindManyArgs = { where?: { session?: unknown } };

/**
 * `artifact.findMany` serves both sibling paths: the Project facet reads the
 * session population (`where.session`), attribution reads its link targets.
 */
function linkedArtifactRows(args: ArtifactFindManyArgs) {
  if (isFacetPopulationRead(args)) {
    return [{ id: LINKED_SESSION_ID }];
  }
  return [targetRow()];
}

function attributionSessionRow() {
  return {
    artifactId: LINKED_SESSION_ID,
    inputTokens: 1n,
    outputTokens: 1n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    estimatedCost: 1,
    artifact: { organizationId: "org-1" },
  };
}

function targetRow() {
  return {
    id: LINK_TARGET_ID,
    organizationId: "org-1",
    branch: {
      branchName: `feat/${LINK_TARGET_ID}`,
      repository: { fullName: "acme/web" },
      currentPullRequestDetail: null,
    },
    pullRequestDetails: [],
  };
}

function projectCountRow() {
  return {
    projectId: LINK_PROJECT_ID,
    projectName: LINK_PROJECT_NAME,
    sessionCount: 1,
  };
}

function isFacetPopulationRead(args: ArtifactFindManyArgs | undefined) {
  return Boolean(args?.where?.session);
}

function gatedReadKey(readKey: string, args: unknown): string {
  return readKey === "artifact.findMany" &&
    isFacetPopulationRead(args as ArtifactFindManyArgs | undefined)
    ? FACET_POPULATION_READ
    : readKey;
}
