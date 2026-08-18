/**
 * ISS-5464: the component detail's `sessionsTab` is a BOUNDED payload, and the
 * bound is applied inside the query, on the canonical total ordering.
 *
 * Measured cause (see the ticket comment for the full capture): for `tool::Bash`
 * — 2309 usage rows, 1218 distinct sessions, 133_980 invocations in the seeded
 * `iss5464_perf` profiling database — the detail read shipped 1000 fully-enriched
 * `AgentSessionListItem` records, 1_656_281 of 2_185_823 response bytes (76%),
 * and the Sessions tab then rendered 50 of them. Query COUNT did not scale (59
 * for heavy AND light, so there is no N+1 here); payload did, 67x against a
 * light component.
 *
 * These are shape/row-count assertions, never wall-clock ones
 * (`scripts/lint/rules/no-timing-assertions.ts`). The heavy fixture is sized at
 * the real 1218 sessions so the pre-fix path — an unbounded read that enriches
 * every id — fails them.
 */
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import type * as DatabaseModule from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_DEFAULT_ORDER_BY } from "../../agent-sessions/service/session-sort-order";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findMany: vi.fn(),
  findSourceArtifactsById: vi.fn(),
  getReconciledCostsBySessionId: vi.fn(),
  loadListTranscriptDispositions: vi.fn(),
}));

// Partial mock: only `withDb` is doubled. `agentSessionListSelect` (reached
// through the read under test) evaluates the real `ArtifactType` Prisma enum at
// module load, so a bare factory makes the whole suite fail to LOAD — it never
// runs, and its assertions can neither pass nor fail.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  withDb: mocks.withDb,
}));

vi.mock("../../agent-sessions/service/query-builder", () => ({
  findSourceArtifactsById: mocks.findSourceArtifactsById,
}));
vi.mock("../../agent-sessions/service/cost-reconciled-reader", () => ({
  getReconciledCostsBySessionId: mocks.getReconciledCostsBySessionId,
}));
vi.mock("../../agent-sessions/service/list-transcript-dispositions", () => ({
  loadListTranscriptDispositions: mocks.loadListTranscriptDispositions,
}));
vi.mock("../../agent-sessions/service/projections", () => ({
  toSessionListItem: (record: { artifactId: string }) => ({
    id: record.artifactId,
  }),
}));

import { listSessionsByArtifactIds } from "../../agent-sessions/service/list-by-artifact-ids";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000ff";

/**
 * The `tool::Bash` session count from the profiling dataset. The pre-fix read shipped
 * `MAX_DETAIL_SESSION_IN_IDS` (1000) of these; the fix ships
 * `AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS` (50).
 */
const HEAVY_SESSION_COUNT = 1218;

/** A light component from the same dataset, well under the bound. */
const LIGHT_SESSION_COUNT = 12;

function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function sessionIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => sessionId(i + 1));
}

/**
 * A db double whose `findMany` HONOURS `take` — without that the bound would be
 * invisible to the enrichment assertions below, and a mock that returned the
 * same rows regardless of `take` would prove nothing about the filter under
 * test. Rows come back in the caller's requested order.
 */
function installDb(): void {
  mocks.findMany.mockImplementation(
    (args: { where: { artifactId: { in: string[] } }; take?: number }) => {
      const ids = args.where.artifactId.in;
      const kept = args.take === undefined ? ids : ids.slice(0, args.take);
      return Promise.resolve(
        kept.map((id) => ({
          artifactId: id,
          sourceArtifactId: null,
          externalSessionId: `ext-${id}`,
          computeTarget: { id: "ct-1" },
        }))
      );
    }
  );
  mocks.withDb.mockImplementation(
    (
      fn: (db: { sessionDetail: { findMany: typeof mocks.findMany } }) => void
    ) => fn({ sessionDetail: { findMany: mocks.findMany } })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSourceArtifactsById.mockResolvedValue(new Map());
  mocks.getReconciledCostsBySessionId.mockResolvedValue(new Map());
  mocks.loadListTranscriptDispositions.mockResolvedValue(new Map());
});

describe("ISS-5464 sessionsTab payload bound", () => {
  it("caps a heavy component's session summaries at the declared bound", async () => {
    installDb();

    const items = await listSessionsByArtifactIds(
      ORGANIZATION_ID,
      sessionIds(HEAVY_SESSION_COUNT),
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );

    expect(items).toHaveLength(AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS);
  });

  it("pushes the bound into the query, after the recency sort", async () => {
    installDb();

    await listSessionsByArtifactIds(
      ORGANIZATION_ID,
      sessionIds(HEAVY_SESSION_COUNT),
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );

    // `take` must ride the canonical TOTAL order, not a bare
    // `{ lastActivityAt: "desc" }`. `lastActivityAt` is nullable and Postgres
    // sorts DESC NULLS FIRST, so a bare column would let never-active sessions
    // consume the whole bound; and without the tiebreakers the cut point between
    // rows tied on `lastActivityAt` is arbitrary and run-to-run unstable once the
    // planner takes a top-N path. Slicing the id list in the caller instead would
    // retain an arbitrary subset entirely.
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: SESSION_DEFAULT_ORDER_BY,
        take: AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS,
      })
    );
    expect(SESSION_DEFAULT_ORDER_BY[0]).toEqual({
      lastActivityAt: { sort: "desc", nulls: "last" },
    });
  });

  it("scales the per-row enrichment with the bound, not the id list", async () => {
    installDb();

    await listSessionsByArtifactIds(
      ORGANIZATION_ID,
      sessionIds(HEAVY_SESSION_COUNT),
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );

    // The three enrichment reads each take one entry per retained row. Before
    // the bound they each took 1218. This is the assertion the pre-fix path
    // fails.
    expect(
      mocks.getReconciledCostsBySessionId.mock.calls[0][0].sessionIds
    ).toHaveLength(AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS);
    expect(mocks.loadListTranscriptDispositions.mock.calls[0][1]).toHaveLength(
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
    expect(mocks.findSourceArtifactsById.mock.calls[0][1]).toHaveLength(
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
  });

  it("leaves a light component untouched — every session still travels", async () => {
    installDb();

    const items = await listSessionsByArtifactIds(
      ORGANIZATION_ID,
      sessionIds(LIGHT_SESSION_COUNT),
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );

    // The optimisation for the heavy case must not cost the common case: a
    // component under the bound is byte-identical to the pre-fix response.
    expect(items).toHaveLength(LIGHT_SESSION_COUNT);
    expect(
      mocks.getReconciledCostsBySessionId.mock.calls[0][0].sessionIds
    ).toHaveLength(LIGHT_SESSION_COUNT);
  });

  it("stays unbounded when no limit is supplied", async () => {
    installDb();

    const items = await listSessionsByArtifactIds(
      ORGANIZATION_ID,
      sessionIds(HEAVY_SESSION_COUNT)
    );

    // The parameter is additive: an omitted limit reads exactly as before, so
    // no other caller of this shared read changes behaviour.
    expect(items).toHaveLength(HEAVY_SESSION_COUNT);
    expect(mocks.findMany.mock.calls[0][0]).not.toHaveProperty("take");
  });

  it("floors a degenerate limit at one row rather than inverting to unbounded", async () => {
    installDb();

    const items = await listSessionsByArtifactIds(
      ORGANIZATION_ID,
      sessionIds(HEAVY_SESSION_COUNT),
      0
    );

    expect(items).toHaveLength(1);
  });
});
