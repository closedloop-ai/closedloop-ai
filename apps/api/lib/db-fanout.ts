// Imported from the leaf `pool-config` module rather than the `@repo/database`
// barrel on purpose. The barrel loads Prisma, pg, the AWS RDS signer and env
// machinery at module top level, and — because ~20 suites already
// `vi.mock("@repo/database")` — importing the number through it would make every
// one of those mocks responsible for re-exporting a constant they have no
// interest in. The leaf has no imports and no mocks intercept it.
import {
  createDbAcquisitionBudget,
  withDbAcquisitionBudget,
} from "@repo/database/acquisition-budget";
import { DB_POOL_MAX_DATABASE_URL_DEFAULT } from "@repo/database/pool-config";
import type { LimitFunction } from "p-limit";
import pLimit from "p-limit";

/**
 * Max concurrent ORM **calls** a single fan-out may have in flight (FEA-3299).
 *
 * On 2026-07-15 a 200-component sync payload met a 20-connection pool and
 * starved every other route for 30s (PRD-528).
 *
 * Derived from the pool rather than asserted next to it: the invariant is that
 * one fan-out may spend at most **half of the smallest pool**, leaving the rest
 * for the concurrent requests the pool exists to serve. The smallest pool is the
 * `DATABASE_URL` path's (pg's default of 10; the IAM path is 20), so this
 * resolves to 5 — matching the bound #2892 set by hand. Deriving it means
 * shrinking the pool moves this automatically instead of silently re-opening the
 * outage; `db-fanout.test.ts` pins the relationship.
 *
 * **This is a bound on CALLS, and calls are not connections (ISS-8431).** This
 * docstring used to reason that `withDb` hands back the client and every query
 * inside borrows one connection, so `n` mapped calls demand `n` connections.
 * That stopped being true at the Prisma 7 driver-adapter / query-compiler
 * migration: on a non-transactional read Prisma runs every included relation as
 * a parallel child query and each child takes its own connection in the same
 * tick, so a mapped function carrying a ten-relation `include` demands 11
 * connections, not one, and this bound alone admits `5 x K`. `mapWithDbConcurrency`
 * therefore also runs its fan-out under a shared acquisition budget
 * (`DB_ACQUISITION_BUDGET_MAX`), which is the bound that actually describes the
 * pool. Keep this one anyway: it bounds the non-connection cost of a fan-out
 * (in-flight work, memory, upstream calls), which the acquisition budget does not.
 *
 * A payload cap is NOT a substitute for either. The sync payload was already
 * capped at 200; 200 > 20, so the cap never bound the resource. Any cap above the
 * pool size is not a resource cap.
 *
 * NOTE: this bounds ONE fan-out, not one request. Two concurrent fan-outs each
 * build their own limiter and stack to 2x. When sibling fan-outs run
 * concurrently within one request, build a single limiter with
 * `createDbFanoutLimiter()` and pass it to both.
 *
 * **A shared limiter shares the CALL budget only.** Each `mapWithDbConcurrency`
 * opens its own acquisition budget when no outer scope exists, so N concurrent
 * siblings still stack to `N x DB_ACQUISITION_BUDGET_MAX` connections — the
 * unit correction does not survive sibling stacking on its own. Sibling groups
 * must also be wrapped in ONE `withDbAcquisitionBudget(fn, budget)`, which the
 * inner fan-outs then join instead of opening their own; see
 * `getUsageSummary` in `app/agent-sessions/service.ts`, which does both.
 */
export const DB_FANOUT_MAX_CONCURRENCY = Math.floor(
  DB_POOL_MAX_DATABASE_URL_DEFAULT / 2
);

/**
 * Build a limiter to share across sibling fan-outs that run concurrently within
 * one request, so their *combined* in-flight queries stay bounded. Bounds
 * compose by addition, not by maximum.
 */
export function createDbFanoutLimiter(): LimitFunction {
  return pLimit(DB_FANOUT_MAX_CONCURRENCY);
}

/**
 * Map `items` through `fn` with pooled-DB-safe bounded concurrency.
 *
 * Order-preserving: results line up with `items`, so callers may index into or
 * `.flat()` the result exactly as with `Promise.all`.
 *
 * Errors are fail-fast, matching `Promise.all`. This deliberately does not
 * swallow them: sites that want per-element tolerance keep their own try/catch
 * inside `fn`, where the intent is visible.
 *
 * @param limiter Pass a shared limiter (from `createDbFanoutLimiter`) to share
 *   one concurrency budget with a concurrent sibling fan-out. Omit for the
 *   common case of a lone fan-out.
 */
export async function mapWithDbConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limiter: LimitFunction = createDbFanoutLimiter()
): Promise<R[]> {
  // One budget for the whole fan-out, not one per mapped call: the mapped
  // functions' own `withDb` calls join this scope instead of each opening a
  // fresh ceiling, so the fan-out's TOTAL connection demand is bounded no matter
  // how wide any one call's include tree is (ISS-8431).
  return await withDbAcquisitionBudget(
    async () =>
      await Promise.all(
        items.map((item, index) => limiter(() => fn(item, index)))
      ),
    createDbAcquisitionBudget()
  );
}
