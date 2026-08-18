/**
 * ISS-4886: the orphan-only (used-only) detail path runs its four mutually
 * independent reads — session LOC/$, cohort performance, the invocation read
 * page, and the definition-hash resolution — as ONE concurrent batch in a
 * single `Promise.all` under the enclosing `withDb` read, rather than four
 * serial waits.
 *
 * That batch is not one round trip: each read issues its own queries (the
 * invocation page always issues two, cohort performance can issue several).
 * That is precisely why the guard below counts in-flight QUERIES rather than
 * reads — the observable property is that the four reads' queries overlap.
 *
 * The guard is a peak in-flight assertion (the shape `lib/db-fanout.test.ts`
 * uses), not a timing assertion: each mocked delegate holds its slot across a
 * microtask, so concurrency is observable deterministically.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  // ISS-5577: the orphan-only path's usage lanes and seen-bounds aggregate now
  // read under a `withDb.tx({ isolationLevel: … })` snapshot, so the mocked
  // module must expose that enum value. The batched block this file guards is
  // still a pooled `withDb` read.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

// The detail path reuses the agent-sessions read service to populate
// `sessionsTab`; mock it so this test stays isolated from that (heavy) service.
vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { agentComponentsService } from "../service";

const ORGANIZATION_ID = "org-1";
const SESSION_ID = "session-orphan";
const COMPONENT_KEY = "my-skill";
const ORPHAN_SLUG = encodeComponentSlug(
  AgentComponentKind.Skill,
  COMPONENT_KEY,
  null
);

/**
 * Peak concurrency the batched block reaches under THIS fixture:
 * `loadSessionLocCost` (1) + `computeCohortPerformance` (1 — it short-circuits
 * here because the cohort read returns no rows; against real data it issues
 * several) + `loadAgentComponentInvocationReadPage` (2, its own inner
 * `Promise.all`) + `resolveDefinitionHashes` (1).
 *
 * The floor matters: fully serial reads peak at 2 (the invocation page's inner
 * pair), and pulling ANY single read back out of the batch caps the peak at 4 —
 * so asserting 5 is what makes a partial regression fail, not just a total one.
 */
const BATCHED_PEAK_IN_FLIGHT = 5;

/**
 * A used-only usage row: no inventory FK, but it links a `DefinitionVersion`
 * so `resolveDefinitionHashes` actually issues its query instead of
 * short-circuiting on an empty id set.
 */
function orphanUsageRow() {
  return {
    agentSessionId: SESSION_ID,
    invocationCount: 3,
    errorCount: 0,
    gitBranch: "",
    harness: "claude",
    componentKind: AgentComponentKind.Skill,
    componentKey: COMPONENT_KEY,
    definitionVersionId: "dv-1",
    lastInvokedAt: new Date("2026-01-10T00:00:00.000Z"),
    session: {
      artifactId: SESSION_ID,
      artifact: { organizationId: ORGANIZATION_ID },
    },
  };
}

/** Peak concurrent in-flight delegate calls observed across one read. */
type ConcurrencyProbe = { peak: number };

/**
 * Install a minimal orphan-only `db`: no inventory rows, one orphan usage row,
 * and empty results everywhere else. Only the delegates this path actually
 * reaches are stubbed — a future read that needs another one should fail loudly
 * here rather than be silently absorbed by an unused default.
 */
function installOrphanOnlyDb(): ConcurrencyProbe {
  const probe: ConcurrencyProbe = { peak: 0 };
  let inFlight = 0;

  // Holds its slot across one microtask so callers issued in the same tick
  // overlap, and callers issued serially never do.
  const trackedDelegate = <T>(value: T) =>
    vi.fn(async (): Promise<T> => {
      inFlight += 1;
      probe.peak = Math.max(probe.peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value;
    });

  const db = {
    // No inventory row for this identity -> the orphan-only path.
    agentComponent: { findMany: trackedDelegate([]) },
    agentComponentSessionUsage: {
      findMany: trackedDelegate([orphanUsageRow()]),
    },
    // Branch attribution behind `resolveDetailSessionTabs`.
    artifactLink: { findMany: trackedDelegate([]) },
    // LOC/$ and cohort performance both read this model.
    sessionDetail: { findMany: trackedDelegate([]) },
    agentComponentInvocation: {
      findMany: trackedDelegate([]),
      groupBy: trackedDelegate([]),
    },
    definitionVersion: { findMany: trackedDelegate([]) },
  };

  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return probe;
}

describe("getDetailForOrg — orphan-only read batching (ISS-4886)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("issues the four independent orphan-only reads concurrently, not serially", async () => {
    const probe = installOrphanOnlyDb();

    const result = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      ORPHAN_SLUG
    );

    // Behavior is unchanged: the used-only identity still resolves.
    expect(result).not.toBeNull();
    expect(probe.peak).toBeGreaterThanOrEqual(BATCHED_PEAK_IN_FLIGHT);
  });
});
