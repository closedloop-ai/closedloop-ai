/**
 * @file idle-shrink-memory.test.ts
 * @description ISS-12023 (PRD-785) — the desktop store's connections release
 * their page caches.
 *
 * `connection-pragmas.ts` gives the writer and every reader a 16 MiB page cache
 * and nothing ever handed it back: an idle READER loses its cache only as a side
 * effect of the FEA-3132 recycle, and the writer is never recycled, so it held
 * whatever the last backfill or aggregation touched for the life of the db-host.
 *
 * The risk in the fix is not the arithmetic, it is whether the engine accepts the
 * statement on every connection: readers are `query_only=ON`, and a pragma it
 * rejected there would leave two thirds of the cache resident with nothing
 * saying so (the pass swallows a per-connection failure on purpose — it is
 * reclaim, never correctness). So these tests count the connections whose
 * statement SUCCEEDED, which is what `onShrinkMemory` reports, and they drive the
 * idle cadence against an injected clock rather than wall time.
 *
 * WHAT THE COUNT DOES NOT PIN: that the statement is `shrink_memory` rather than
 * some other harmless one. SQLite ignores an unrecognised pragma silently — both
 * of these were measured against the suite (2026-10-06), and a bogus pragma name
 * keeps every case green while a reader-refused one (`PRAGMA user_version=7`)
 * fails two. So the count is load-bearing for "the engine took it on every
 * connection" and blind to the statement's identity; the identity is held by
 * `SQLITE_SHRINK_MEMORY_SQL` being the single source of it, and by the
 * libSQL-level verification recorded on that constant.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const READER_POOL_SIZE = 2;
/** Writer + every reader: what a pass over a fully idle store must report. */
const EVERY_CONNECTION = READER_POOL_SIZE + 1;
const READ_ONE = "SELECT 1 AS n";

/**
 * The timer interval the idle tests run at. Short so a tick is cheap, and
 * decoupled from the IDLENESS threshold because these tests inject `now` — the
 * clock is advanced deliberately, so no test waits out a real 15 s.
 */
const TICK_MS = 5;
/** Bound on waiting for an EXPECTED pass. Generous: a slow CI worker is not a bug. */
const PASS_TIMEOUT_MS = 5000;
/**
 * Bound on waiting for a pass that must NOT come. Many ticks' worth, so a
 * cadence that fired every interval regardless of idleness would be caught.
 */
const NO_PASS_WINDOW_MS = 250;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

test("a shrink pass runs its statement on the writer and every reader", async () => {
  const passes: number[] = [];
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    readerPoolSize: READER_POOL_SIZE,
    // Far out of the way: this test drives the pass directly, the way the
    // db-host's post-heavy-gate hook does.
    idleShrinkIntervalMs: 60_000,
    onShrinkMemory: (shrunk) => passes.push(shrunk),
  });
  closers.push(close);

  await prisma.shrinkMemory();

  assert.deepEqual(passes, [EVERY_CONNECTION]);

  // The connections are still usable afterwards — releasing cached pages does
  // not close or invalidate anything.
  const rows = await prisma.read((r) =>
    r.$queryRawUnsafe<{ n: number }[]>(READ_ONE)
  );
  assert.equal(Number(rows[0]?.n), 1);
  const written = await prisma.write((client) =>
    client.$queryRawUnsafe<{ n: number }[]>(READ_ONE)
  );
  assert.equal(Number(written[0]?.n), 1);
});

test("a pass skips a reader with a read in flight and takes it on the next one", async () => {
  const passes: number[] = [];
  let releaseRead: (() => void) | undefined;
  const readHeld = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    readerPoolSize: READER_POOL_SIZE,
    idleShrinkIntervalMs: 60_000,
    onShrinkMemory: (shrunk) => passes.push(shrunk),
  });
  closers.push(close);

  // `read` claims its slot synchronously, before any await, so the slot is
  // already marked in-flight by the time this expression returns.
  const inFlight = prisma.read(async (r) => {
    await readHeld;
    return r.$queryRawUnsafe<{ n: number }[]>(READ_ONE);
  });

  await prisma.shrinkMemory();
  assert.deepEqual(
    passes,
    [EVERY_CONNECTION - 1],
    "the busy reader must be skipped, not shrunk under its own read"
  );

  releaseRead?.();
  await inFlight;

  await prisma.shrinkMemory();
  assert.deepEqual(passes[1], EVERY_CONNECTION);
});

test("a pass skips the writer while a `prisma.client` read is in flight", async () => {
  const passes: number[] = [];
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    readerPoolSize: READER_POOL_SIZE,
    idleShrinkIntervalMs: 60_000,
    onShrinkMemory: (shrunk) => passes.push(shrunk),
  });
  closers.push(close);

  // `prisma.client` is bound to the WRITER connection and is the store's
  // dominant read path (225 call sites under `src/main`), so a shrink under one
  // of its reads takes the writer's mutex to free pages that read is about to
  // re-read. The call marks the writer in flight synchronously, and a shrink
  // pass reads that count synchronously too, so no await separates them here —
  // this case is deterministic rather than a race the clock happens to win.
  const inFlight = prisma.client.$queryRawUnsafe<{ n: number }[]>(READ_ONE);
  const pass = prisma.shrinkMemory();
  await pass;

  assert.deepEqual(
    passes,
    [EVERY_CONNECTION - 1],
    "the writer must be skipped, not shrunk under a `prisma.client` read"
  );

  const rows = await inFlight;
  assert.equal(Number(rows[0]?.n), 1);

  await prisma.shrinkMemory();
  assert.equal(passes[1], EVERY_CONNECTION);
});

test("overlapping shrink calls join one pass", async () => {
  const passes: number[] = [];
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    readerPoolSize: READER_POOL_SIZE,
    idleShrinkIntervalMs: 60_000,
    onShrinkMemory: (shrunk) => passes.push(shrunk),
  });
  closers.push(close);

  // Two heavy-gate ops back to back reach `shrinkMemory` twice with nothing
  // awaited in between. A second concurrent pass would make `shrinkTail` track
  // only the later one, and `disconnect()` would then drain that one while
  // `$disconnect`ing a reader the earlier pass is still inside — the case the
  // drain comment claims cannot happen.
  const first = prisma.shrinkMemory();
  const second = prisma.shrinkMemory();
  await Promise.all([first, second]);

  assert.deepEqual(
    passes,
    [EVERY_CONNECTION],
    "two overlapping calls must run one pass, not two"
  );
  // The joined promise is what makes the drain claim hold: `shrinkTail` is
  // assigned from it on both calls, so there is one pass for `disconnect()` to
  // await rather than a later one shadowing an earlier one still in flight.
  assert.equal(first, second, "the second call must join the running pass");
});

test("the idle timer shrinks once per quiet stretch and re-arms on activity", async () => {
  // An injected clock, so "the store has been idle for the interval" is a fact
  // this test sets rather than one it waits for. The production default is
  // monotonic `performance.now()`; see `IDLE_SHRINK_MEMORY_INTERVAL_MS`.
  let clock = 0;
  let passes = 0;
  let onPass: (() => void) | undefined;
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    readerPoolSize: READER_POOL_SIZE,
    idleShrinkIntervalMs: TICK_MS,
    now: () => clock,
    onShrinkMemory: () => {
      passes += 1;
      onPass?.();
    },
  });
  closers.push(close);

  const nextPass = (): Promise<void> =>
    new Promise<void>((resolve) => {
      onPass = resolve;
    });

  // Nothing fires while the store looks busy: the clock has not moved past the
  // idleness threshold, so every tick in this window must decline.
  assert.equal(
    await passFiredWithinWindow(nextPass()),
    false,
    "a pass fired before the store had been idle for the interval"
  );
  assert.equal(passes, 0);

  // Now it has been idle for the threshold, so the next tick reclaims.
  const first = nextPass();
  clock += TICK_MS;
  await withTimeout(first, "no idle shrink pass observed");
  assert.equal(passes, 1);

  // ...and exactly once. The clock stays far past the threshold, so a cadence
  // that ignored "already shrunk since the last activity" would fire on every
  // remaining tick in this window.
  clock += TICK_MS * 100;
  assert.equal(
    await passFiredWithinWindow(nextPass()),
    false,
    "a second pass fired with no activity since the first"
  );
  assert.equal(passes, 1);

  // A read is activity, which re-arms the gate: once the store is idle again,
  // the next tick reclaims what that read brought into cache.
  const second = nextPass();
  await prisma.read((r) => r.$queryRawUnsafe<{ n: number }[]>(READ_ONE));
  clock += TICK_MS;
  await withTimeout(second, "no shrink pass after the gate re-armed");
  assert.equal(passes, 2);

  // `prisma.client` traffic is activity on the same terms. It runs on the WRITER
  // connection rather than the reader pool, so until ISS-12023 tracked it the
  // gate stayed latched through it: a store busy entirely through this path —
  // which is most of the store's reads — looked quiet for the rest of the run.
  const third = nextPass();
  await prisma.client.$queryRawUnsafe<{ n: number }[]>(READ_ONE);
  clock += TICK_MS;
  await withTimeout(third, "no shrink pass after `prisma.client` activity");
  assert.equal(passes, 3);
});

/** Reject if `promise` has not settled within {@link PASS_TIMEOUT_MS}. */
function withTimeout(promise: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${message} within ${PASS_TIMEOUT_MS}ms`)),
      PASS_TIMEOUT_MS
    );
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/**
 * Whether `pass` settles inside {@link NO_PASS_WINDOW_MS}.
 *
 * A bounded event wait with an explicit timeout is the sanctioned shape for a
 * non-occurrence claim here: the thing being proven absent is a TIMER fire, so
 * there is no blocking state to assert instead. The window spans many ticks, and
 * the surrounding cases prove the timer is alive rather than simply dead.
 */
async function passFiredWithinWindow(pass: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quietWindow = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), NO_PASS_WINDOW_MS);
  });
  try {
    return await Promise.race([pass.then(() => true), quietWindow]);
  } finally {
    clearTimeout(timer);
  }
}
