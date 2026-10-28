/**
 * ISS-6520: the LIST and the DETAIL must resolve one component's `firstSeenAt`
 * from the same population, on an org large enough that a capped read would see
 * only part of it.
 *
 * Both surfaces read usage ordered `lastInvokedAt desc`, and that ordering key is
 * NOT the column being minimised — so a read capped on rows drops precisely the
 * oldest `firstInvokedAt` and derives a slice minimum that is systematically too
 * recent. The list carried that shape until ISS-5516 replaced its raw-row ceiling
 * with an identity spine plus an UNCAPPED `groupBy` whose `_min(firstInvokedAt)`
 * Postgres computes over every row; the detail reaches the same answer the other
 * way, by routing a truncated lane to the uncapped aggregate (ISS-5577).
 *
 * The fixture is one usage-only identity whose oldest session is also its LEAST
 * recently invoked, so it sorts LAST and is the first row any reintroduced cap
 * would drop — and it is seeded one group PAST the removed ceiling, so a cap at
 * any value up to that ceiling still leaves the component present in the response
 * while silently moving its `firstSeenAt` forward. That is the failure this pins:
 * not a missing row, a plausible wrong date.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { buildServiceDb } from "@/__tests__/support/agent-components/service-db-double";
import {
  detailOrphanRowRead,
  detailSeenBoundsAggregate,
  isIdentitySpineRead,
  type OrphanUsageShape,
  orphanGroupByCalls,
  REMOVED_ROW_CEILING,
} from "@/__tests__/support/agent-components/usage-lane-doubles";
import { agentComponentsService } from "../service";

const ORG = "org-orphan-seen-window";
const COMPONENT_KIND = AgentComponentKind.Tool;
const COMPONENT_KEY = "bash";
const COMPONENT_SLUG = encodeComponentSlug(COMPONENT_KIND, COMPONENT_KEY, null);

/**
 * One group PAST the ceiling ISS-5516 removed, so a cap reintroduced at any value
 * up to it still leaves the component PRESENT while silently moving its
 * `firstSeenAt` forward — including at the 20,000-row cap the detail lane still
 * declares.
 */
const ORPHAN_SESSIONS = REMOVED_ROW_CEILING + 1;

const HOUR_MS = 3_600_000;

/**
 * The population's real bounds and the two instants a cap would answer with
 * instead — every one an independent literal, never re-derived from the fixture
 * builder the assertions are policing. `WINDOW_START` is on the oldest session,
 * which sorts last; `SLICE_START` is what the SECOND-oldest session carries, and
 * is exactly the too-recent answer a read capped at {@link REMOVED_ROW_CEILING}
 * would emit.
 */
const WINDOW_END = new Date("2026-08-01T00:00:00.000Z");
const WINDOW_START = new Date("2022-12-06T16:00:00.000Z");
const SLICE_START = new Date("2022-12-06T17:00:00.000Z");

describe("ISS-6520 — one component's first-seen instant, list and detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("derives the list's firstSeenAt from the whole population, not the recent slice", async () => {
    const db = installDb();

    const response = await agentComponentsService.listForOrg(ORG, {
      limit: 50,
      offset: 0,
    });
    const row = findComponent(response);

    // Positive sibling: the newest instant IS inside any slice, so it proves the
    // fixture was read at all and the `firstSeenAt` assertion is not passing on an
    // empty population.
    expect({
      firstSeenAt: row?.firstSeenAt,
      lastSeenAt: row?.lastSeenAt,
    }).toEqual({
      firstSeenAt: WINDOW_START.toISOString(),
      lastSeenAt: WINDOW_END.toISOString(),
    });
    // The slice minimum is a DIFFERENT, entirely plausible instant one hour later.
    // Naming it is what stops a cap regression from reading as a rounding wobble.
    expect(row?.firstSeenAt).not.toBe(SLICE_START.toISOString());

    // …and the contract is UNCAPPED, not "capped above this fixture" (PR #5913,
    // whitlockk). The value assertions above are sized against one population, so a
    // ceiling reintroduced ABOVE {@link REMOVED_ROW_CEILING} — a `take: 50_000` —
    // leaves them green while `firstSeenAt` goes facet-dependent again the moment
    // a real org outgrows it. Read the query the lane actually issued and pin the
    // absence of a `take`, which no fixture size can satisfy vacuously.
    const aggregatePasses = orphanGroupByCalls(
      db.agentComponentSessionUsage
    ).filter((call) => !isIdentitySpineRead(call.by));
    expect(aggregatePasses).toHaveLength(1);
    expect(aggregatePasses[0]?.take).toBeUndefined();
  }, 60_000);

  it("agrees with the detail surface, whose own lane truncates on this org", async () => {
    installDb();
    const listRow = findComponent(
      await agentComponentsService.listForOrg(ORG, { limit: 50, offset: 0 })
    );

    installDb();
    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      COMPONENT_SLUG
    );

    // The detail lane IS capped, hits its `take`, and reaches this answer through
    // the uncapped aggregate. Both sides are pinned to the literal rather than to
    // each other: two surfaces agreeing on a truncated instant would satisfy a
    // cross-comparison and still be the defect.
    expect(detail?.firstSeenAt).toBe(WINDOW_START.toISOString());
    expect(listRow?.firstSeenAt).toBe(WINDOW_START.toISOString());
  }, 60_000);
});

/**
 * One usage-only identity across {@link ORPHAN_SESSIONS} sessions, each an hour
 * older than the last. Session 0 carries {@link WINDOW_END}; the final session
 * carries {@link WINDOW_START} and is therefore both the oldest and the least
 * recently invoked — last under `lastInvokedAt desc`, and the first thing a cap
 * discards.
 */
function usageFixture(): OrphanUsageShape[] {
  const rows: OrphanUsageShape[] = [];
  for (let session = 0; session < ORPHAN_SESSIONS; session++) {
    const invokedAt = new Date(WINDOW_END.getTime() - session * HOUR_MS);
    rows.push({
      agentSessionId: `s-${session}`,
      componentKind: COMPONENT_KIND,
      componentKey: COMPONENT_KEY,
      harness: "claude",
      invocationCount: 1,
      firstInvokedAt: invokedAt,
      lastInvokedAt: invokedAt,
    });
  }
  return rows;
}

/**
 * Install the service double over one usage population, backing BOTH the list's
 * identity-scoped `groupBy` pair and the detail's per-identity row read, so the
 * parity asserted above is over one population rather than two fixtures that
 * happen to agree. The org has no inventory rows, which is what routes everything
 * through the usage-only lane.
 *
 * Returns the built client so a test body can read the reads back off it —
 * `buildServiceDb` installs the usage `groupBy` at runtime, and asserting a query
 * shape from inside a mock implementation would be an assertion that may never
 * run.
 */
function installDb() {
  const rows = usageFixture();
  const db = buildServiceDb(
    {
      agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponentSessionUsage: {
        findMany: vi
          .fn()
          .mockImplementation(
            (args?: { where?: Record<string, unknown>; take?: number }) =>
              Promise.resolve(detailOrphanRowRead(rows, args))
          ),
        aggregate: vi
          .fn()
          .mockImplementation(
            (args?: { where?: { OR?: Record<string, unknown>[] } }) =>
              Promise.resolve(detailSeenBoundsAggregate(rows, args))
          ),
      },
    },
    rows
  );
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return db;
}

/** The component's row in a list response, if the read surfaced it at all. */
function findComponent(response: { items: { name: string; kind: string }[] }) {
  return response.items.find(
    (item) => item.kind === COMPONENT_KIND && item.name === COMPONENT_KEY
  ) as
    | { name: string; kind: string; firstSeenAt: string; lastSeenAt: string }
    | undefined;
}
