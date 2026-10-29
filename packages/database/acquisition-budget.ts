import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import {
  DB_ACQUISITION_BUDGET_MAX,
  DB_POOL_ACQUIRE_TIMEOUT_MESSAGE,
  DB_POOL_ACQUIRE_TIMEOUT_MS,
} from "./pool-config";
import { createServerGlobalSlot } from "./server-global-slot";

/**
 * A per-scope ceiling on concurrent pg **connection acquisitions** (ISS-8431).
 *
 * ## Why a second bound exists when `db-fanout` already bounds concurrency
 *
 * `apps/api/lib/db-fanout.ts` bounds concurrent ORM **calls**. Since the Prisma 7
 * driver-adapter/query-compiler migration those are no longer the same unit: on a
 * NON-transactional read, Prisma runs every included relation as a parallel child
 * query, and outside a transaction each child takes its own pooled connection in
 * the same tick. One `findMany` with ten `include`s measures 11 concurrent
 * acquisitions against a pool of 10 — so a bound expressed in calls admits
 * `calls x relationEdges` connections and cannot describe the resource at all.
 *
 * This module bounds the resource directly. The gate sits on `pool.connect`, so
 * it counts what the pool actually hands out regardless of how wide the include
 * tree that asked for it was.
 *
 * ## Why AsyncLocalStorage
 *
 * The budget has to be scoped to one logical unit of work, not to the process —
 * a process-wide semaphore is just a smaller pool and buys nothing. Nothing in
 * Prisma's adapter surface carries a per-request token, but the async context
 * does survive the whole path: measured on `@prisma/client@7.8.0`, a store
 * entered around an awaited query is visible in the client extension layer, in
 * `PrismaPgAdapter.queryRaw`, and in every one of the fan-out children's
 * `pool.connect` calls.
 *
 * **The await must happen inside the scope.** A Prisma query is a lazy
 * `PrismaPromise` that starts no work until it is awaited, so
 * `storage.run(budget, () => db.x.findMany())` returns the promise and leaves the
 * scope before the query begins — the store is then invisible and the gate
 * silently does nothing. Every entry point here awaits inside the scope for that
 * reason.
 *
 * ## The one shape that can starve a budget
 *
 * A budget starves only on hold-and-wait: a caller that acquires more
 * connections than its limit at once and releases none until all of them have
 * arrived. Nothing here does that. `pool.query` — which is every Prisma child
 * query on a non-transactional read — acquires, runs and releases one connection
 * on its own, so gating merely serializes the children. The only
 * holder-across-await is an interactive transaction, and it pins exactly ONE
 * connection for its whole life and runs every query inside it on that pinned
 * client; reads nested inside it reach it through `withDb`, which joins the
 * ambient transaction rather than touching the pool.
 *
 * **That join holds per module copy, not process-wide.** `index.ts`'s `als` is
 * still a module-local `new AsyncLocalStorage()` — the exact shape
 * `budgetStorage` below had to move off, and
 * `__tests__/cross-bundle-registration.test.ts` measures that split in real
 * Turbopack output. A `withDb.tx` opened through one copy and a nested `withDb`
 * resolving through another would miss the transaction, go to the pool, and take
 * a SECOND permit while the transaction still holds one: hold-and-wait, with no
 * slack at `installation-repositories-handler.ts:85`, which runs up to
 * `DB_ACQUISITION_BUDGET_MAX` concurrent transactions against a budget of
 * exactly that. Pre-existing rather than introduced here and not observed
 * firing, but the guarantee above is copy-scoped, not absolute, and the timeout
 * below is what bounds it.
 *
 * Budgets are per-scope and never shared between concurrent requests, so two
 * request scopes cannot wait on each other — but **detached work inherits its
 * creator's budget**. `waitUntil` carries the async context across both the
 * timer and the `.then`, so the `scheduleDueDirtyScopeDispatch` that
 * `githubDirtyScopeService.publish` schedules unconditionally
 * (`dirty-scope-service.ts:361`, 45s later) still holds the budget object of the
 * request that created it, and N siblings under one `mapWithDbConcurrency`
 * capture the same one. Nothing hangs today, because each of those queries
 * releases per query — but a budget's lifetime is its creator's async context,
 * not its creator's request.
 *
 * That is a property of today's callers, not a guarantee, so a permit wait is
 * bounded by `DB_POOL_ACQUIRE_TIMEOUT_MS` and fails with the exact message
 * `pool-telemetry` classifies as `db_pool_acquire_timeout`. A future hold-and-wait
 * caller gets a monitored failure in bounded time instead of a hang — the
 * timeout is load-bearing, not belt-and-braces, and `acquisition-budget.test.ts`
 * pins it.
 */

export type DbAcquisitionBudget = {
  readonly limit: number;
  inUse: number;
  readonly waiters: BudgetWaiter[];
};

/**
 * Build a budget. Callers that need two sibling fan-outs to share ONE ceiling
 * pass the same budget to both — bounds compose by addition, not by maximum.
 */
export function createDbAcquisitionBudget(
  limit: number = DB_ACQUISITION_BUDGET_MAX
): DbAcquisitionBudget {
  return {
    limit: clampBudgetLimit(limit),
    inUse: 0,
    waiters: [],
  };
}

/**
 * Run `fn` under an acquisition budget, awaiting inside the scope.
 *
 * Joins an ambient budget when one is already active rather than opening a
 * second one: nesting must not let an inner scope spend a fresh ceiling on top
 * of the one its caller is already spending.
 */
export async function withDbAcquisitionBudget<T>(
  fn: () => Promise<T>,
  budget?: DbAcquisitionBudget
): Promise<T> {
  const ambient = budgetStorage.getStore();
  if (ambient) {
    return await fn();
  }
  return await budgetStorage.run(
    budget ?? createDbAcquisitionBudget(),
    async () => await fn()
  );
}

/**
 * Gate a pool's acquisitions on the ambient budget.
 *
 * Apply this BEFORE `instrumentPool`, so the telemetry timer spans the permit
 * wait: a caller that queued for a permit really did wait for a connection, and
 * `db_pool_acquire_wait` would under-report it otherwise. Note what that does
 * NOT preserve — `instrumentPool` reads the pool counters at entry, before the
 * permit is granted, so `saturated` on a permit wait describes the pool the
 * caller arrived at. The wait is labelled `permitQueued` instead (see
 * `willQueueForPermit`) and, unless the pool was also saturated at arrival, is
 * throttled like a cold handshake until it crosses `SLOW_ACQUIRE_MS`. That is
 * the intended consequence of the pressure moving off the pool, not an
 * oversight.
 *
 * Idempotent, and a no-op for any acquisition made outside a budget scope — so
 * scripts, seeds and migrations keep the pool's own semantics exactly.
 */
export function gateDbAcquisitions(pool: Pool): Pool {
  const target = pool as GatedPool;
  if (target[ACQUISITION_GATED]) {
    return pool;
  }
  target[ACQUISITION_GATED] = true;

  const connect = pool.connect.bind(pool) as (
    cb?: PoolConnectCallback
  ) => unknown;
  const outstanding = new WeakMap<PoolClient, PermitRelease>();

  // A client destroyed rather than released (pg removes it on a connection
  // error) never runs the wrapped `release`, so its permit would leak.
  pool.on("remove", (client) => {
    outstanding.get(client as PoolClient)?.();
  });

  const gated = (cb?: PoolConnectCallback): unknown => {
    const budget = budgetStorage.getStore();
    if (!budget) {
      return connect(cb);
    }
    if (typeof cb === "function") {
      gateCallbackConnect(budget, connect, outstanding, cb);
      return;
    }
    return gatePromiseConnect(budget, connect, outstanding);
  };

  (target as { connect: unknown }).connect = gated;
  return pool;
}

type PermitRelease = () => void;

type BudgetWaiter = {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
};

type PoolConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void
) => void;

const ACQUISITION_GATED = Symbol.for("closedloop.database.acquisitionGated");

type GatedPool = Pool & { [ACQUISITION_GATED]?: true };

type BudgetStorage = AsyncLocalStorage<DbAcquisitionBudget>;

/**
 * The storage instance itself is process-wide, not module-wide (ISS-6942).
 *
 * `globalForPrisma.pool` lives on `globalThis`, so ONE pool object is shared by
 * every copy of this package a bundler emits — but a module-local
 * `new AsyncLocalStorage()` is not. Turbopack emits `@repo/database` into
 * several chunk groups for `apps/api` (measured in built output:
 * `__tests__/cross-bundle-registration.test.ts`), and `ACQUISITION_GATED` is a
 * REGISTERED symbol, so the second copy to reach that shared pool finds it
 * already stamped and returns without installing its own gate. Its `withDb`
 * would then enter ITS storage while the installed gate reads the FIRST copy's,
 * see no store, and pass every acquisition straight through — the budget
 * silently absent on exactly the routes that landed in the later chunk.
 *
 * That failure is invisible: it fails OPEN, and it is the same shape as the
 * telemetry sink and the schema bootstrap hook, which this package already
 * routes through `createServerGlobalSlot` for this reason.
 *
 * The slot stores only callables, so the storage travels as an accessor rather
 * than as the instance. A planted non-callable reads back as absent and a
 * planted callable returning a non-storage fails `isBudgetStorage`; both fall
 * through to a locally-created instance, which is the pre-fix behavior rather
 * than a crash.
 */
type BudgetStorageAccessor = () => BudgetStorage;

const budgetStorageSlot = createServerGlobalSlot<BudgetStorageAccessor>(
  "closedloop.database.acquisitionBudgetStorage"
);

const budgetStorage = resolveBudgetStorage();

function clampBudgetLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DB_ACQUISITION_BUDGET_MAX;
  }
  return Math.max(1, Math.floor(limit));
}

function acquirePermit(budget: DbAcquisitionBudget): Promise<PermitRelease> {
  if (hasFreePermit(budget)) {
    budget.inUse += 1;
    return Promise.resolve(makePermitRelease(budget));
  }
  return new Promise<PermitRelease>((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = budget.waiters.findIndex(
        (waiter) => waiter.timer === timer
      );
      if (index >= 0) {
        budget.waiters.splice(index, 1);
      }
      reject(new Error(DB_POOL_ACQUIRE_TIMEOUT_MESSAGE));
    }, DB_POOL_ACQUIRE_TIMEOUT_MS);
    unrefTimer(timer);
    budget.waiters.push({
      timer,
      grant: () => {
        budget.inUse += 1;
        resolve(makePermitRelease(budget));
      },
    });
  });
}

function makePermitRelease(budget: DbAcquisitionBudget): PermitRelease {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    budget.inUse -= 1;
    const next = budget.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    }
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

/**
 * Hold the permit for as long as the client is checked out. pg assigns a fresh
 * `release` per checkout, so wrapping here cannot stack across checkouts.
 *
 * Returns the idempotent releaser so the callback path can hand the SAME one to
 * its consumer as `done`; see `gateCallbackConnect`.
 */
function bindPermitToClient(
  outstanding: WeakMap<PoolClient, PermitRelease>,
  client: PoolClient,
  release: PermitRelease
): PermitRelease {
  const finish = () => {
    outstanding.delete(client);
    release();
  };
  outstanding.set(client, finish);
  const clientRelease = client.release.bind(client) as (
    ...args: unknown[]
  ) => unknown;
  (client as { release: unknown }).release = (...args: unknown[]) => {
    finish();
    return clientRelease(...args);
  };
  return finish;
}

function gateCallbackConnect(
  budget: DbAcquisitionBudget,
  connect: (cb?: PoolConnectCallback) => unknown,
  outstanding: WeakMap<PoolClient, PermitRelease>,
  cb: PoolConnectCallback
): void {
  acquirePermit(budget).then(
    (release) => {
      connect((err, client, done) => {
        if (!client) {
          release();
          cb(err, client, done);
          return;
        }
        const finish = bindPermitToClient(outstanding, client, release);
        // pg hands the consumer the `done` it captured BEFORE we replaced
        // `client.release`, so the two are no longer the same function. Releasing
        // through `done` is the documented callback API, and unwrapped it returns
        // the client to the pool while the permit stays held forever — a
        // limit-one scope would then time out on its next acquisition. `finish`
        // is idempotent, so a caller using both paths still spends one permit.
        cb(err, client, (releaseArg?: unknown) => {
          finish();
          done(releaseArg);
        });
      });
    },
    (err: unknown) => {
      cb(err as Error, undefined, noopDone);
    }
  );
}

async function gatePromiseConnect(
  budget: DbAcquisitionBudget,
  connect: (cb?: PoolConnectCallback) => unknown,
  outstanding: WeakMap<PoolClient, PermitRelease>
): Promise<PoolClient> {
  const release = await acquirePermit(budget);
  try {
    const client = (await connect()) as PoolClient;
    bindPermitToClient(outstanding, client, release);
    return client;
  } catch (err) {
    release();
    throw err;
  }
}

function noopDone(): void {
  // pg's `done` is never meaningful when the acquisition itself failed.
}

function isBudgetStorage(value: unknown): value is BudgetStorage {
  const candidate = value as BudgetStorage | undefined;
  return (
    typeof candidate?.run === "function" &&
    typeof candidate?.getStore === "function"
  );
}

/**
 * The first copy of this module to load creates the storage and registers it;
 * every later copy reads that same instance, so a scope opened in one chunk is
 * visible to a gate installed from another.
 */
function resolveBudgetStorage(): BudgetStorage {
  const registered = budgetStorageSlot.read()?.();
  if (isBudgetStorage(registered)) {
    return registered;
  }
  const created: BudgetStorage = new AsyncLocalStorage<DbAcquisitionBudget>();
  budgetStorageSlot.set(() => created);
  return created;
}

/**
 * Whether an acquisition on `pool` starting NOW waits for a permit before it
 * can reach the pool (ISS-10293).
 *
 * `pool-telemetry` asks at acquire entry to label the wait. `instrumentPool`
 * wraps this gate and calls it synchronously, so this is the same instant, and
 * the same predicate, on which `acquirePermit` decides. `false` outside a
 * budget scope and on a pool this gate was never installed on: neither has a
 * permit to wait for.
 */
export function willQueueForPermit(pool: Pool): boolean {
  if (!(pool as GatedPool)[ACQUISITION_GATED]) {
    return false;
  }
  const budget = budgetStorage.getStore();
  return budget !== undefined && !hasFreePermit(budget);
}

function hasFreePermit(budget: DbAcquisitionBudget): boolean {
  return budget.inUse < budget.limit;
}
