import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDbAcquisitionBudget,
  gateDbAcquisitions,
  withDbAcquisitionBudget,
} from "../../acquisition-budget";
import {
  DB_ACQUISITION_BUDGET_MAX,
  DB_POOL_MAX_DATABASE_URL_DEFAULT,
} from "../../pool-config";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";
import { settleAll } from "../test-helpers/settle-all";

/**
 * ISS-8431: the acquisition budget against a REAL Prisma client and a REAL pool.
 *
 * The unit suites fake the pool, because the contract they pin — how many
 * clients one scope may hold at once — is independent of what the connections
 * carry. What they cannot see is the premise underneath the whole fix: that
 * Prisma 7 really does run each included relation as a parallel child query,
 * that each child really does take its own pooled connection, and that the
 * AsyncLocalStorage scope really does survive the client extension layer and
 * `PrismaPgAdapter.queryRaw` to reach `pool.connect`. All three are properties
 * of `@prisma/client` and `@prisma/adapter-pg`, not of this repo, so a driver
 * bump can take any of them away while every faked-pool assertion stays green.
 *
 * This suite measures them. It counts REAL checkouts through pg's own
 * `acquire`/`release` events rather than by wrapping `connect`, so it observes
 * what the pool actually handed out rather than what entered the gate.
 *
 * Three assertions, and the first two are what give the third its power:
 *
 * 1. UNGATED, the fan-out exceeds the budget. If a driver change stops fanning
 *    out, this goes red and says so — rather than letting the gated assertion
 *    pass for the wrong reason forever.
 * 2. GATED, the work still reaches this pool. If a change routes acquisitions
 *    somewhere the gate does not sit, this goes red instead of the peak
 *    collapsing to zero and reading as a perfect bound.
 * 3. GATED, the peak stays within the budget. The actual contract.
 *
 * A fourth case sits ahead of those and measures nothing — it reads back the
 * pool ceiling the fixture was asked for. All three above are bounded by
 * `RELATION_EDGES`, so every pool at or above the fan-out width measures
 * identically; without reading the ceiling directly, a fixture that silently
 * fell back to its own default would be indistinguishable from one that honored
 * the request.
 */

/**
 * Ten to-many relations off `Organization`, which is the one row the fixture
 * guarantees. Ten because that is the width the ticket measured at 11
 * concurrent acquisitions against a pool of 10.
 */
const TEN_RELATIONS = {
  users: true,
  teams: true,
  projects: true,
  artifacts: true,
  loops: true,
  prompts: true,
  computeTargets: true,
  sessionTranscripts: true,
  judgeHumanScores: true,
  customFields: true,
} as const;

const RELATION_EDGES = Object.keys(TEN_RELATIONS).length;

/**
 * The pool ceiling this suite asks the fixture for.
 *
 * One parent query plus one child per relation — the 11 concurrent acquisitions
 * `pool-config.ts` measured against a pool of 10 — so a pool "wide enough to
 * hold the whole fan-out at once" is `RELATION_EDGES + 1`, and stating it that
 * way keeps it tracking `RELATION_EDGES` when an eleventh relation is added.
 *
 * It also has to be a number the fixture would not have picked on its own.
 * `DB_POOL_MAX_DATABASE_URL_DEFAULT` is 10, and so is pg's own default
 * underneath it, so a request of 10 produces a pool indistinguishable from one
 * that never received the request — which is what made the earlier
 * `poolMax: RELATION_EDGES` deletable with every assertion still green.
 */
const FIXTURE_POOL_MAX = RELATION_EDGES + 1;

describe.skipIf(!process.env.DATABASE_URL)(
  "acquisition budget against a real Prisma fan-out (integration)",
  () => {
    let ctx: EphemeralDbContext;
    const counts = { inFlight: 0, peak: 0, acquired: 0 };

    beforeAll(async () => {
      // A pool wide enough to hold the whole fan-out at once, rather than the
      // default this suite used to inherit — which happened to equal the
      // fan-out width, an undeclared coincidence in the one suite whose
      // assertions are stated against exactly that number. See
      // `FIXTURE_POOL_MAX`, and the case below that reads the ceiling back.
      ctx = await setupEphemeralDb({ poolMax: FIXTURE_POOL_MAX });

      // The same call production makes in `getPool()`.
      gateDbAcquisitions(ctx._pool);

      // pg's own events, so the measurement does not depend on where the gate
      // sits relative to this listener.
      ctx._pool.on("acquire", () => {
        counts.inFlight += 1;
        counts.acquired += 1;
        counts.peak = Math.max(counts.peak, counts.inFlight);
      });
      ctx._pool.on("release", () => {
        counts.inFlight -= 1;
      });

      // Pre-open the pool, so every child of the fan-out below is handed an
      // IDLE client (ISS-9126).
      //
      // pg emits `acquire` for a NEW connection only once its TCP/startup
      // handshake has completed. On a cold pool that makes the peak a race
      // between how bunched ten concurrent handshakes happen to be and how fast
      // the first child's query returns — so it measures handshake spread, not
      // the fan-out width the case below asserts on. Measured over 35 runs
      // without this warm-up, the ungated peak ranged 3 to 9 against an
      // assertion of `> 5` and was red on 12 of them; with it, all ten children
      // pop an idle client in the same tick and the peak is 10, every run.
      //
      // So this is load-bearing, not setup noise: delete it and the case below
      // goes back to failing about a third of the time for a reason that has
      // nothing to do with the budget it exists to measure.
      // Capped at the pool's OWN ceiling rather than assuming it equals the
      // fan-out width (packages/database/AGENTS.md: read `pool.options.max`).
      // The request above should make the cap a no-op, but it is read back
      // rather than assumed — and the fixture passes no
      // `connectionTimeoutMillis`, so an uncapped warm-up against a pool that
      // cannot satisfy it becomes hold-and-wait: the surplus connect queues
      // untimed and this hook hangs to the vitest timeout instead of failing
      // with something readable.
      const warmed = await Promise.allSettled(
        Array.from({ length: observablePeakCeiling() }, () =>
          ctx._pool.connect()
        )
      );

      // Release every client that DID connect even when a sibling rejected, and
      // still surface the rejection. A client left checked out makes
      // `pool.end()` in `teardownEphemeralDb` wait forever, so the connection
      // error would disappear behind that hang rather than being reported.
      await settleAll(
        warmed.map((outcome) => () => {
          if (outcome.status === "rejected") {
            return Promise.reject(outcome.reason);
          }
          outcome.value.release();
          return Promise.resolve();
        }),
        "pool warm-up failed"
      );
    });

    afterAll(async () => {
      await teardownEphemeralDb(ctx);
    });

    beforeEach(() => {
      counts.peak = 0;
      counts.acquired = 0;
    });

    /**
     * The largest peak this suite can physically observe: the warm-up hands out
     * one idle client per relation, and the pool cannot hand out more clients
     * than it holds. Read from `pool.options.max` rather than assumed, per
     * `packages/database/AGENTS.md`.
     */
    const observablePeakCeiling = () =>
      Math.min(RELATION_EDGES, ctx._pool.options.max);

    const readWithTenRelations = () =>
      ctx.prisma.organization.findMany({
        where: { id: ctx.organizationId },
        include: TEN_RELATIONS,
      });

    it("holds the pool ceiling the fixture was asked for", () => {
      // The only thing in this suite that can tell a pool sized on request
      // apart from one sized by default. Every other assertion reads the pool
      // through `observablePeakCeiling()`, which saturates at `RELATION_EDGES`,
      // so no ceiling at or above the fan-out width is observable through them.
      expect(ctx._pool.options.max).toBe(FIXTURE_POOL_MAX);

      // Keeps the line above able to fail. If the fixture's own default is ever
      // raised to this number the request stops being observable again, and
      // this reports that rather than letting the check go quietly vacuous.
      expect(FIXTURE_POOL_MAX).not.toBe(DB_POOL_MAX_DATABASE_URL_DEFAULT);
    });

    it("fans out past the budget when no scope is open", async () => {
      // Stated before the measurement, because the peak below is bounded by
      // this number: on a pool that cannot hold more than the budget, the
      // assertion after it is unsatisfiable no matter what Prisma does, and it
      // would report that as `expected 5 to be greater than 5` — a fan-out
      // failure it never observed. Fail here instead, naming the pool.
      expect(
        observablePeakCeiling(),
        `pool max ${ctx._pool.options.max} across ${RELATION_EDGES} relations cannot exceed a budget of ${DB_ACQUISITION_BUDGET_MAX}, so the fan-out below is not observable`
      ).toBeGreaterThan(DB_ACQUISITION_BUDGET_MAX);

      await readWithTenRelations();

      // The defect, measured rather than argued: one ORM call, many
      // simultaneous connections. Also the guard on the case below — if this
      // stops being true, the bound is no longer being tested by it.
      expect(counts.acquired).toBeGreaterThan(RELATION_EDGES);
      expect(counts.peak).toBeGreaterThan(DB_ACQUISITION_BUDGET_MAX);
    });

    it("bounds the same read to the budget inside a scope", async () => {
      await withDbAcquisitionBudget(
        async () => await readWithTenRelations(),
        createDbAcquisitionBudget()
      );

      // Not vacuous: the work still went through THIS pool. Without this, a
      // change that routed acquisitions past the gate would read as a peak of
      // zero and pass.
      expect(counts.acquired).toBeGreaterThan(RELATION_EDGES);
      expect(counts.peak).toBeLessThanOrEqual(DB_ACQUISITION_BUDGET_MAX);
    });

    it("returns identical rows gated and ungated", async () => {
      // Bounding concurrency must not change the answer.
      const ungated = await readWithTenRelations();
      const gated = await withDbAcquisitionBudget(
        async () => await readWithTenRelations(),
        createDbAcquisitionBudget()
      );

      expect(JSON.stringify(gated)).toBe(JSON.stringify(ungated));
    });
  }
);
