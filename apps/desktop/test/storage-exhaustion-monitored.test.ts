/**
 * @file storage-exhaustion-monitored.test.ts
 * @description ISS-6337 — a disk-full write must be CLASSIFIED at the write
 * boundary, must not leave a half-written unit behind, must not end the app, and
 * must reach the MONITORED store-integrity event as a bounded, PII-free reason.
 *
 * Before this, `SQLITE_FULL`/`ENOSPC` matched nothing in `apps/desktop/src`.
 *
 * ## How disk-full is induced
 *
 * Not by filling the disk. `PRAGMA max_page_count` caps how many pages the store
 * may allocate; pinning it at the store's current size makes the next page
 * allocation fail with SQLite's own `SQLITE_FULL` (result code 13) — the
 * identical result code, message, and rollback path a genuinely out-of-space
 * filesystem produces, raised by the real engine on the real production
 * `prisma.write` path rather than by a stub standing in for it. Raising the cap
 * again is the "user freed some space" half.
 *
 * Both call shapes are exercised, because they throw DIFFERENT error classes and
 * hide the result code in different places: a RAW `$executeRawUnsafe` throws
 * `PrismaClientKnownRequestError` (`code: "P2010"`, no `cause`, driver error at
 * `meta.driverAdapterError.cause`), while a TYPED delegate — the shape of the
 * one production call site the fire-and-forget guard protects — throws
 * `DriverAdapterError` whose `cause` carries `extendedCode: 13`. Each asserts
 * the verdict SURVIVES blanking every message in the chain, which is what
 * distinguishes real code-based classification from text-matching that happens
 * to work.
 *
 * The arm no engine can produce on demand — an OS `ENOSPC` — is driven from a
 * faithful synthetic input.
 *
 * ## The db-host boundary
 *
 * `serializeDbHostError` flattens an error to `{ message, stack, name }`, so the
 * result code does NOT survive the trip to main. The child therefore classifies
 * at serialization time and carries the bounded verdict, exactly as ISS-4714
 * carries `refusalKind`. Both directions are pinned through the REAL
 * serialize → structured-clone → `rebuildError` path (`captureRebuiltBootError`):
 * a genuine `SQLITE_FULL` keeps its verdict, and a message merely QUOTING a
 * pack child's captured output never acquires one.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { serializeDbHostError } from "../src/main/database/db-host/db-host-protocol.js";
import { STORAGE_EXHAUSTION_HEALTH_SCHEMA } from "../src/main/database/storage-exhaustion-integrity.js";
import { closedloopExpectedIndexNames } from "../src/main/database/store-index-policy.js";
import { createWiredStoreIntegrityProbe } from "../src/main/database/store-integrity-wiring.js";
import type { StoreIntegrityDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import { settleFireAndForgetDbHostError } from "../src/shared/db-host-fire-and-forget.js";
import {
  classifyStorageExhaustion,
  createStorageExhaustionTally,
  STORAGE_EXHAUSTION_REASON_KEY,
  type StorageExhaustionHealth,
  StorageExhaustionReason,
} from "../src/shared/storage-exhaustion.js";
import { captureRebuiltBootError } from "./db-host-fake-child-support.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

/** How many rows the fill loop attempts — comfortably past a 220-page store. */
const ROWS_BEYOND_CAPACITY = 5000;
/** SQLite clamps `max_page_count` up to the current page count, so 1 means
 *  "allocate not one more page". */
const NO_FURTHER_PAGES = 1;
/** Restores headroom, standing in for the user freeing disk space. */
const PLENTY_OF_PAGES = 1_000_000;
/**
 * Bound on the probe's first publish. Generous against a 0ms initial delay, and
 * far below the runner's own timeout, so a severed emit sink fails in seconds
 * with a named reason rather than as an anonymous runner timeout.
 */
const EMIT_TIMEOUT_MS = 10_000;

/** The driver's own name for the condition, as it appears in the message. */
const SQLITE_FULL_IN_MESSAGE = /SQLITE_FULL/;
/** A filesystem path — the ISS-6229 leak class — in any emitted field. */
const LEAKED_PATH = /[/\\]Users[/\\]|[/\\]home[/\\]|file:\/\//;
/** An email address — the ISS-6228 leak class. */
const LEAKED_EMAIL = /@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
/** The store's own filenames, which embed the user's profile directory. */
const LEAKED_STORE_FILENAME = /\.sqlite|-wal\b/;
/** The label the dropped-write log line must name. */
const DROPPED_WRITE_LABEL = /pack install end stamp/;
/** The bounded reason token the dropped-write log line must carry. */
const DROPPED_WRITE_REASON = new RegExp(StorageExhaustionReason.SqliteFull);
/** An unrelated failure that must still reach the crash path. */
const UNRELATED_FAILURE = /column x does not exist/;

/** Pin the store so the next page allocation raises a real `SQLITE_FULL`. */
function fillTheDisk(opened: OpenTestPrisma): Promise<unknown> {
  return opened.prisma.write((client) =>
    client.$executeRawUnsafe(`PRAGMA max_page_count = ${NO_FURTHER_PAGES}`)
  );
}

/** Give the store headroom again — the user cleared space. */
function freeTheDisk(opened: OpenTestPrisma): Promise<unknown> {
  return opened.prisma.write((client) =>
    client.$executeRawUnsafe(`PRAGMA max_page_count = ${PLENTY_OF_PAGES}`)
  );
}

/** Run `work` and return what it threw, or `undefined` if it did not throw. */
async function captureRejection(
  work: () => Promise<unknown>
): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * A structural copy of an error chain with every `message` blanked, so a test
 * can prove a verdict came from a structured result code rather than from text.
 * Follows the same two link shapes the classifier does.
 */
function withBlankedMessages(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth > 6) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    copy[key] = source[key];
  }
  for (const key of ["message", "originalMessage", "stack"]) {
    if (key in copy) {
      copy[key] = "";
    }
  }
  copy.message = "";
  if (source.cause !== undefined) {
    copy.cause = withBlankedMessages(source.cause, depth + 1);
  }
  const meta = source.meta;
  if (meta !== null && typeof meta === "object") {
    copy.meta = withBlankedMessages(meta, depth + 1);
  }
  const adapterError = (source as { driverAdapterError?: unknown })
    .driverAdapterError;
  if (adapterError !== undefined) {
    copy.driverAdapterError = withBlankedMessages(adapterError, depth + 1);
  }
  return copy;
}

/**
 * A store whose every OTHER integrity check reports clean, so the only issue a
 * probe run can produce is the disk-full one under test. `readStorageExhaustionHealth`
 * is left to the caller, which is the variable actually under test.
 */
function healthyExceptStorage(
  readStorageExhaustionHealth: () => Promise<StorageExhaustionHealth>
) {
  return {
    runStoreIntegrityCheck: () =>
      Promise.resolve({
        quickRows: [{ quick_check: "ok" }] as Record<string, unknown>[],
        // Every index the production policy expects. Reporting the whole index
        // set missing would push the run past the reported-issue cap.
        indexRows: closedloopExpectedIndexNames().map((name) => ({ name })),
      }),
    runTokenParityCheck: () =>
      Promise.resolve({
        usageInput: 0,
        usageOutput: 0,
        usageCacheRead: 0,
        usageCacheWrite: 0,
        eventsInput: 0,
        eventsOutput: 0,
        eventsCacheRead: 0,
        eventsCacheWrite: 0,
        divergentSessionCount: 0,
      }),
    runInvocationTelemetryIntegrityCheck: () =>
      Promise.resolve({
        outOfRangeTokenRows: 0,
        outOfRangeCostRows: 0,
        nonSubagentUsageRows: 0,
        invalidLineRows: 0,
      }),
    runForeignKeyIntegrityCheck: () =>
      Promise.resolve({
        violationTotal: 0,
        violationTables: [],
        orphanEventAgentRows: 0,
      }),
    runInvocationSyncOutboxIntegrityCheck: () =>
      Promise.resolve({ unreadableCreatedAtRows: 0 }),
    readStorageExhaustionHealth,
  };
}

/** Rows currently in `sessions` whose id starts with `prefix`. */
async function countSessions(
  opened: OpenTestPrisma,
  prefix: string
): Promise<number> {
  const rows = await opened.prisma.read((reader) =>
    reader.$queryRawUnsafe<{ n: number | bigint }[]>(
      "SELECT COUNT(*) AS n FROM sessions WHERE id LIKE ?1",
      `${prefix}%`
    )
  );
  return Number(rows[0]?.n ?? 0);
}

describe("ISS-6337 disk-full at the desktop store write boundary", () => {
  test("a write SUCCEEDS and tallies nothing before the disk fills (positive control)", async () => {
    const opened = await openTestPrisma();
    try {
      await opened.prisma.write((client) =>
        client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status) VALUES (?1, ?2)",
          "control-1",
          "active"
        )
      );

      // The write path genuinely worked, so a later failure cannot be a test
      // that never attempted anything.
      assert.equal(await countSessions(opened, "control-"), 1);
      assert.deepEqual(opened.prisma.readStorageExhaustionHealth(), {
        failures: 0,
        lastReason: null,
        active: false,
      });
    } finally {
      await opened.close();
    }
  });

  test("a real SQLITE_FULL on the production write path is classified, and the caller still sees the failure", async () => {
    const opened = await openTestPrisma();
    try {
      await fillTheDisk(opened);

      const rejection = await captureRejection(() =>
        opened.prisma.write(async (client) => {
          for (let i = 0; i < ROWS_BEYOND_CAPACITY; i += 1) {
            await client.$executeRawUnsafe(
              "INSERT INTO sessions (id, status) VALUES (?1, ?2)",
              `full-${i}`,
              "active"
            );
          }
        })
      );

      // Degrading gracefully is NOT swallowing: the caller's rejection is
      // untouched, so an awaited write can never report success on a full disk.
      assert.ok(rejection instanceof Error);
      assert.match(rejection.message, SQLITE_FULL_IN_MESSAGE);
      assert.equal(
        classifyStorageExhaustion(rejection),
        StorageExhaustionReason.SqliteFull
      );
      // The RAW path throws `PrismaClientKnownRequestError` (`code: "P2010"`,
      // no `cause`), which buries the driver error at
      // `meta.driverAdapterError.cause`. Blanking every message proves the
      // verdict still comes from `extendedCode: 13` down there rather than from
      // the wording Prisma happens to interpolate.
      assert.equal(
        classifyStorageExhaustion(withBlankedMessages(rejection)),
        StorageExhaustionReason.SqliteFull
      );
      assert.deepEqual(opened.prisma.readStorageExhaustionHealth(), {
        failures: 1,
        lastReason: StorageExhaustionReason.SqliteFull,
        active: true,
      });
    } finally {
      await opened.close();
    }
  });

  test("a TYPED delegate write is classified from its result code, not its wording", async () => {
    // This is the shape of the only production call site the fire-and-forget
    // guard can actually protect (`packInstallRun.updateMany` via
    // `recordPackInstallRunEnd`), and it throws a DIFFERENT error class than the
    // raw path: `DriverAdapterError`, whose `cause` carries `extendedCode: 13`.
    // A raw-only suite would leave this path unproven.
    const opened = await openTestPrisma();
    try {
      await fillTheDisk(opened);

      const rejection = await captureRejection(() =>
        opened.prisma.write(async (client) => {
          for (let i = 0; i < ROWS_BEYOND_CAPACITY; i += 1) {
            await client.session.create({
              data: { id: `typed-${i}`, status: "active" },
              select: { id: true },
            });
          }
        })
      );

      assert.ok(rejection instanceof Error);
      assert.equal(
        classifyStorageExhaustion(rejection),
        StorageExhaustionReason.SqliteFull
      );
      // The structured code is genuinely present and genuinely reached: blanking
      // every message in the chain must NOT change the verdict, which is what
      // proves this is code-based rather than text-matching.
      assert.equal(
        classifyStorageExhaustion(withBlankedMessages(rejection)),
        StorageExhaustionReason.SqliteFull
      );
      assert.equal(
        opened.prisma.readStorageExhaustionHealth().lastReason,
        StorageExhaustionReason.SqliteFull
      );
    } finally {
      await opened.close();
    }
  });

  test("a transaction that hits SQLITE_FULL leaves NO partial unit behind", async () => {
    const opened = await openTestPrisma();
    try {
      await fillTheDisk(opened);

      // One unit of work: a session row, then enough rows to exhaust the store.
      // The first insert would succeed on its own — it is exactly the row that
      // must NOT survive its transaction failing.
      const rejection = await captureRejection(() =>
        opened.prisma.write((client) =>
          client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              "INSERT INTO sessions (id, status) VALUES (?1, ?2)",
              "unit-head",
              "active"
            );
            for (let i = 0; i < ROWS_BEYOND_CAPACITY; i += 1) {
              await tx.$executeRawUnsafe(
                "INSERT INTO sessions (id, status) VALUES (?1, ?2)",
                `unit-body-${i}`,
                "active"
              );
            }
          })
        )
      );

      assert.ok(rejection instanceof Error);
      // Queried back from the store, not inferred from the throw: the whole unit
      // is absent, head row included.
      assert.equal(await countSessions(opened, "unit-"), 0);
      assert.equal(await countSessions(opened, "unit-head"), 0);
    } finally {
      await opened.close();
    }
  });

  test("freeing space lets writes resume, and the window reads clean again", async () => {
    const opened = await openTestPrisma();
    try {
      await fillTheDisk(opened);
      await captureRejection(() =>
        opened.prisma.write(async (client) => {
          for (let i = 0; i < ROWS_BEYOND_CAPACITY; i += 1) {
            await client.$executeRawUnsafe(
              "INSERT INTO sessions (id, status) VALUES (?1, ?2)",
              `recover-fill-${i}`,
              "active"
            );
          }
        })
      );
      assert.equal(
        opened.prisma.readStorageExhaustionHealth().failures,
        1,
        "the failure is tallied while the store is full"
      );

      // READING is not recovering. The window's COUNT is consumed, but the disk
      // is still full and no write has succeeded since, so the state must still
      // report exhausted — otherwise this second read alone would drive
      // `store.integrity.recovered` off nothing but the passage of time.
      assert.deepEqual(
        opened.prisma.readStorageExhaustionHealth(),
        {
          failures: 0,
          lastReason: StorageExhaustionReason.SqliteFull,
          active: true,
        },
        "a read must not clear the exhaustion state it merely observed"
      );

      await freeTheDisk(opened);
      await opened.prisma.write((client) =>
        client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status) VALUES (?1, ?2)",
          "recovered-1",
          "active"
        )
      );

      // Writes resume, and a write that SUCCEEDED is what clears the state —
      // so the store can report healthy again instead of latching failing
      // forever and suppressing `store.integrity.recovered`.
      assert.equal(await countSessions(opened, "recovered-"), 1);
      assert.deepEqual(opened.prisma.readStorageExhaustionHealth(), {
        failures: 0,
        lastReason: null,
        active: false,
      });
    } finally {
      await opened.close();
    }
  });

  test("the tally reaches the monitored store-integrity sink as a bounded, PII-free issue", async () => {
    const emitted: StoreIntegrityDiagnostics[] = [];
    const logs: string[] = [];
    let resolveFirstEmit: ((value: StoreIntegrityDiagnostics) => void) | null =
      null;
    const probe = createWiredStoreIntegrityProbe({
      agentDatabase: healthyExceptStorage(() =>
        Promise.resolve({
          failures: 3,
          lastReason: StorageExhaustionReason.SqliteFull,
          active: true,
        })
      ),
      emit: (diagnostics) => {
        emitted.push(diagnostics);
        const resolve = resolveFirstEmit;
        resolveFirstEmit = null;
        resolve?.(diagnostics);
      },
      getIngestProgress: () => ({
        preparing: false,
        total: 0,
        processed: 0,
      }),
      initialDelayMs: 0,
      log: (line) => logs.push(line),
    });

    // Drive the path that actually calls `emit` — the poll tick — rather than
    // pushing `runOnce()`'s return value, which would leave this test green if
    // the probe→`Observability.storeIntegrityResult` wiring were severed. The
    // wait is on the emit itself, not a fixed delay.
    const firstEmit = new Promise<StoreIntegrityDiagnostics>(
      (resolve, reject) => {
        resolveFirstEmit = resolve;
        // An EXPLICIT bound, so an unwired sink fails fast and says why instead
        // of hanging until the runner's default timeout — which reports
        // "timed out" and leaves the reader to guess what did not happen.
        const bound = setTimeout(
          () => reject(new Error("the probe never published to its emit sink")),
          EMIT_TIMEOUT_MS
        );
        bound.unref?.();
      }
    );
    probe.start();
    let diagnostics: StoreIntegrityDiagnostics;
    try {
      diagnostics = await firstEmit;
    } finally {
      probe.stop();
    }
    assert.equal(emitted.length, 1, "the probe must publish to its sink");
    assert.deepEqual(logs, [], "no optional check may have been dropped");

    assert.equal(diagnostics.healthy, false);
    assert.equal(diagnostics.issueCount, 1);
    assert.equal(diagnostics.truncated, false);
    const issue = diagnostics.issues.find(
      (candidate) => candidate.check === "storage_exhaustion"
    );
    assert.ok(issue, "the disk-full window must surface as its own issue");
    assert.equal(issue.category, "storage_exhausted");
    assert.equal(issue.object, StorageExhaustionReason.SqliteFull);

    // Nothing on the wire may carry a filesystem path or a user identifier —
    // the ISS-6228 / ISS-6229 leak class. The whole payload is scanned, not just
    // the field this test happened to build.
    const wire = JSON.stringify(diagnostics);
    assert.doesNotMatch(wire, LEAKED_PATH);
    assert.doesNotMatch(wire, LEAKED_EMAIL);
    assert.doesNotMatch(wire, LEAKED_STORE_FILENAME);
  });

  test("the signal still publishes while the FIRST-LAUNCH IMPORT is running", async () => {
    // The boot-import skip exists to keep `quick_check` off the backfill's hot
    // path — but the disk filling DURING that import is the ISS-6337 scenario
    // itself, and this tally is memory-only, so inheriting the skip means the
    // signal waits for the 30-minute interval and is lost outright if the user
    // quits first. The in-memory read contends with nothing, so it runs anyway.
    const emitted: StoreIntegrityDiagnostics[] = [];
    let resolveFirstEmit: ((value: StoreIntegrityDiagnostics) => void) | null =
      null;
    const probe = createWiredStoreIntegrityProbe({
      agentDatabase: healthyExceptStorage(() =>
        Promise.resolve({
          failures: 2,
          lastReason: StorageExhaustionReason.Enospc,
          active: true,
        })
      ),
      emit: (diagnostics) => {
        emitted.push(diagnostics);
        const resolve = resolveFirstEmit;
        resolveFirstEmit = null;
        resolve?.(diagnostics);
      },
      // The import is actively running — the exact state that skipped the tick.
      getIngestProgress: () => ({
        preparing: false,
        total: 500,
        processed: 12,
      }),
      initialDelayMs: 0,
      log: () => {
        // The skip line is expected here; it is the heavyweight half opting out.
      },
    });

    const firstEmit = new Promise<StoreIntegrityDiagnostics>(
      (resolve, reject) => {
        resolveFirstEmit = resolve;
        const bound = setTimeout(
          () =>
            reject(
              new Error(
                "the disk-full signal never published during boot import"
              )
            ),
          EMIT_TIMEOUT_MS
        );
        bound.unref?.();
      }
    );
    probe.start();
    let diagnostics: StoreIntegrityDiagnostics;
    try {
      diagnostics = await firstEmit;
    } finally {
      probe.stop();
    }

    assert.deepEqual(
      diagnostics.checksRun,
      ["storage_exhaustion"],
      "only the import-safe check may run while the backfill holds the store"
    );
    assert.equal(diagnostics.issueCount, 1);
    assert.equal(diagnostics.issues[0]?.object, StorageExhaustionReason.Enospc);
  });

  test("a CLEAN boot-import tick publishes nothing, so it cannot fake a recovery", async () => {
    // The counterfactual to the test above. `Observability.storeIntegrityResult`
    // keys its cadence on `healthy`, so emitting a healthy result assembled from
    // one check would report `store.integrity.recovered` for a `quick_check`
    // failure this tick never looked at.
    const emitted: StoreIntegrityDiagnostics[] = [];
    let resolveSettled: (() => void) | null = null;
    const probe = createWiredStoreIntegrityProbe({
      agentDatabase: healthyExceptStorage(() =>
        Promise.resolve({ failures: 0, lastReason: null, active: false })
      ),
      emit: (diagnostics) => emitted.push(diagnostics),
      getIngestProgress: () => ({
        preparing: true,
        total: 0,
        processed: 0,
      }),
      initialDelayMs: 0,
      onTickSettled: () => {
        const resolve = resolveSettled;
        resolveSettled = null;
        resolve?.();
      },
      log: () => {
        // expected skip line
      },
    });

    // Wait on the tick's OWN settle signal, not a fixed microtask-flush count:
    // the read, parse and classify settle an indeterminate number of ticks in,
    // so a flush count short of that would pass without proving any silence.
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      const bound = setTimeout(
        () => reject(new Error("the boot-import tick never settled")),
        EMIT_TIMEOUT_MS
      );
      bound.unref?.();
    });
    probe.start();
    try {
      await settled;
    } finally {
      probe.stop();
    }

    assert.deepEqual(
      emitted,
      [],
      "a clean partial run must leave the cadence exactly where the last full run left it"
    );
  });
});

describe("ISS-6337 the reason is BOUNDED", () => {
  test("message text is NEVER evidence, however exactly it names the condition", () => {
    // The verdict comes from result codes only. A message can quote content
    // this process did not author — `recordPackInstallRunEnd` persists a pack
    // child's captured `stdout_tail`, and a failed write of that row echoes the
    // parameter back in the Prisma message — and `storageReasonOf` is what
    // `settleFireAndForgetDbHostError` uses to DROP a write instead of
    // crashing, so a text match there silently swallows an unrelated real bug.
    for (const message of [
      "Raw query failed: database or disk is full",
      "SQLITE_FULL: database or disk is full",
      "ENOSPC: no space left on device, write",
      "sqlite_full: database or disk is full",
    ]) {
      assert.equal(
        classifyStorageExhaustion({ name: "Error", message }),
        null,
        `message text must not produce a verdict: ${message}`
      );
    }
  });

  test("an unrecognized or absurd error code is NEVER passed through as a reason", () => {
    for (const error of [
      new Error("boom"),
      { code: "SQLITE_WEIRDNESS_9999", message: "unrecognized failure" },
      { code: "SQLITE_CONSTRAINT", rawCode: 19, message: "UNIQUE failed" },
      { code: 13, rawCode: "thirteen", message: "wrong types entirely" },
      { rawCode: 999_999_999, message: "nonsense code" },
      { message: "/Users/alice/agent-dashboard.sqlite is unhappy" },
      null,
      undefined,
      "a bare string",
      42,
    ]) {
      assert.equal(
        classifyStorageExhaustion(error),
        null,
        `must not classify ${JSON.stringify(error)} as exhaustion`
      );
    }
  });

  test("each input maps to its OWN reason, so swapping two returns goes red", () => {
    // Asserting the exact member per input, not merely closed-set membership:
    // membership alone stays green if the `SQLITE_FULL` and `ENOSPC` branches
    // are swapped, which would attribute every filesystem exhaustion to SQLite.
    const cases: [unknown, StorageExhaustionReason | null][] = [
      [
        {
          code: "SQLITE_FULL",
          rawCode: 13,
          message: "database or disk is full",
        },
        StorageExhaustionReason.SqliteFull,
      ],
      // An EXTENDED SQLite code still reduces to its primary code.
      [{ rawCode: 13 + 256 }, StorageExhaustionReason.SqliteFull],
      [{ extendedCode: 13 }, StorageExhaustionReason.SqliteFull],
      [{ errcode: 13 }, StorageExhaustionReason.SqliteFull],
      [
        {
          code: "ENOSPC",
          syscall: "write",
          message: "no space left on device",
        },
        StorageExhaustionReason.Enospc,
      ],
      // Wrapped one layer down, the way a driver nests its cause.
      [
        new Error("outer", { cause: { code: "ENOSPC", message: "inner" } }),
        StorageExhaustionReason.Enospc,
      ],
      // The code decides, so quoted content in the message cannot override what
      // the engine actually said.
      [
        { extendedCode: 13, message: "ENOSPC: no space left on device" },
        StorageExhaustionReason.SqliteFull,
      ],
      // A verdict the db-host child already made, carried across the boundary
      // that flattens the result code away.
      [
        { [STORAGE_EXHAUSTION_REASON_KEY]: StorageExhaustionReason.Enospc },
        StorageExhaustionReason.Enospc,
      ],
      // A carried verdict is validated, not trusted: an unknown token is not a
      // reason, and must not be forwarded as one.
      [{ [STORAGE_EXHAUSTION_REASON_KEY]: "someday_reason" }, null],
    ];
    for (const [error, expected] of cases) {
      assert.equal(
        classifyStorageExhaustion(error),
        expected,
        `wrong reason for ${JSON.stringify(error)}`
      );
    }
  });

  test("a hostile error object cannot make the tally throw on the write path", () => {
    // `record` runs inside the write's rejection handler. Classification reads
    // properties off an arbitrary `unknown`, so a throwing getter is reachable —
    // and an escape there would become an unhandled rejection, i.e. the crash
    // this whole feature removes.
    const hostile = {
      get code(): string {
        throw new Error("getter exploded");
      },
      get message(): string {
        throw new Error("getter exploded");
      },
    };
    const tally = createStorageExhaustionTally();

    assert.doesNotThrow(() => tally.record(hostile));
    // Unclassifiable is NOT counted — the tally must never inflate on an error
    // it could not read.
    assert.deepEqual(tally.read(), {
      failures: 0,
      lastReason: null,
      active: false,
    });
  });

  test("only a SUCCESSFUL write clears the latch — reading it twice does not", () => {
    // Windowing the STATE as well as the count is what would make an idle
    // interval look like a recovery: the probe reads a failure, reads again
    // 30 minutes later with no write attempted, sees a clean window and emits
    // `store.integrity.recovered` for a disk that is still full.
    const tally = createStorageExhaustionTally();
    tally.record({ code: "ENOSPC", message: "no space left on device" });

    assert.deepEqual(tally.read(), {
      failures: 1,
      lastReason: StorageExhaustionReason.Enospc,
      active: true,
    });
    // The second read is the regression: the count is consumed, the state is not.
    assert.deepEqual(
      tally.read(),
      { failures: 0, lastReason: StorageExhaustionReason.Enospc, active: true },
      "a read must not be mistaken for a recovery"
    );

    tally.recordSuccess();
    assert.deepEqual(
      tally.read(),
      { failures: 0, lastReason: null, active: false },
      "a write that succeeded is what proves the store writable again"
    );
  });

  test("a version-skewed reason folds to the generic one instead of dropping the count", () => {
    // The child's read has already CONSUMED its window by the time this parses,
    // so failing the parse loses a real exhaustion event permanently and turns
    // it into a healthy probe. The count is the part that must survive; a token
    // this build cannot name is exactly what `unattributed` means.
    const parsed = STORAGE_EXHAUSTION_HEALTH_SCHEMA.parse({
      failures: 4,
      lastReason: "sqlite_full_but_worse",
      active: true,
    });

    assert.deepEqual(parsed, {
      failures: 4,
      lastReason: StorageExhaustionReason.Unattributed,
      active: true,
    });
  });

  test("an older host that predates the latch still parses, and is not read as full", () => {
    // Additive/optional, so a host without `active` degrades to the windowed
    // count — never to a fabricated "still full".
    assert.deepEqual(
      STORAGE_EXHAUSTION_HEALTH_SCHEMA.parse({
        failures: 0,
        lastReason: null,
      }),
      { failures: 0, lastReason: null, active: false }
    );
  });

  test("a hostile error rethrows ITSELF from the guard, not the getter's TypeError", () => {
    // The fire-and-forget guard is the OTHER caller of the same trust-boundary
    // classifier, and it runs in main inside a `work.catch` whose promise
    // nothing tracks. If classification threw here the app would crash carrying
    // the getter's `TypeError` instead of the real failure — the evidence a
    // human needs to diagnose it would be gone.
    const hostile = new Error("the real failure");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new TypeError("getter exploded");
      },
    });

    assert.throws(
      () =>
        settleFireAndForgetDbHostError(hostile, {
          label: "hostile write",
          log: () => {},
        }),
      (thrown: unknown) => thrown === hostile
    );
  });

  test("quoted child output survives the REAL db-host round trip without becoming a verdict", async () => {
    // `recordPackInstallRunEnd` persists an install child's captured stdout and
    // stderr, and a failed write of that row echoes the parameter back in the
    // Prisma message. Both of these phrases are ordinary build output — on Linux
    // ENOSPC is also the inotify watcher-limit errno npm and bundlers print —
    // so classifying either as disk-full would make the fire-and-forget guard
    // swallow an unrelated real failure.
    //
    // Driven through the ACTUAL serialize → structured-clone → rebuild path the
    // production error takes, not a hand-built stand-in, because that boundary
    // is precisely where the codes are lost and text is all that remains.
    for (const quoted of [
      "stderr_tail=ENOSPC: System limit for number of file watchers reached",
      "stdout_tail=fatal: disk is full, aborting install",
      "stdout_tail=warning: no space left on device (in the container)",
    ]) {
      const original = new Error(
        `Invalid \`prisma.packInstallRun.updateMany()\` invocation: ${quoted}`
      );
      const rebuilt = await captureRebuiltBootError(
        serializeDbHostError(original)
      );

      assert.equal(
        classifyStorageExhaustion(rebuilt),
        null,
        `quoted child output must not become a verdict: ${quoted}`
      );
      // And the consequence that actually matters: the guard still CRASHES on
      // it, because it is an unrelated failure and must stay as loud as before.
      assert.throws(
        () =>
          settleFireAndForgetDbHostError(rebuilt, {
            label: "pack install end stamp",
            log: () => {},
          }),
        (thrown: unknown) => thrown === rebuilt
      );
    }
  });

  test("a REAL SQLITE_FULL keeps its verdict across the same round trip", async () => {
    // The positive control for the test above: the boundary that must not
    // manufacture a verdict from text must still carry a genuine one, or the
    // negative case above would pass simply by classifying nothing at all.
    const driverError = new Error("write failed", {
      cause: { kind: "sqlite", extendedCode: 13 },
    });
    const serialized = serializeDbHostError(driverError);
    assert.equal(
      serialized.storageExhaustionReason,
      StorageExhaustionReason.SqliteFull,
      "the child must classify at serialization, while the code still exists"
    );
    const rebuilt = await captureRebuiltBootError(serialized);

    // The result code itself did NOT survive — only the verdict the child made
    // from it, which is the whole point of carrying it.
    assert.equal(
      (rebuilt as { cause?: unknown }).cause,
      undefined,
      "the clone must have flattened the driver cause away"
    );
    assert.equal(
      classifyStorageExhaustion(rebuilt),
      StorageExhaustionReason.SqliteFull
    );
  });

  test("a self-referential cause chain terminates instead of hanging", () => {
    const looped: { message: string; cause?: unknown } = {
      message: "not a disk problem",
    };
    looped.cause = looped;

    assert.equal(classifyStorageExhaustion(looped), null);
  });
});

describe("ISS-6337 a full disk degrades the app instead of ending it", () => {
  test("a best-effort write is DROPPED with a bounded log line, not rethrown into the crash path", async () => {
    const logged: string[] = [];

    // The error as it actually reaches this guard: raised in the db-host child
    // with a real result code, then serialized, cloned, and rebuilt in main.
    // Built through that path rather than hand-written, because the guard now
    // decides on the CARRIED verdict — a stand-in error carrying the phrase but
    // not the code would prove the opposite of what this test claims.
    const rebuilt = await captureRebuiltBootError(
      serializeDbHostError(
        new Error("Raw query failed", {
          cause: { kind: "sqlite", extendedCode: 13 },
        })
      )
    );

    // Rethrowing here is what reaches `handleUnhandledRejection`, which shows
    // the crash dialog and calls exit(1) — once per best-effort write.
    settleFireAndForgetDbHostError(rebuilt, {
      label: "pack install end stamp",
      log: (line) => logged.push(line),
    });

    assert.equal(logged.length, 1);
    assert.match(logged[0], DROPPED_WRITE_LABEL);
    assert.match(logged[0], DROPPED_WRITE_REASON);
    // The local log carries the bounded reason, never the raw error text, so a
    // support bundle cannot ship the user's home path.
    assert.doesNotMatch(logged[0], LEAKED_PATH);
  });

  test("an unrelated failure is still rethrown, so real bugs stay as loud as before", () => {
    assert.throws(
      () =>
        settleFireAndForgetDbHostError(new Error("column x does not exist"), {
          label: "unrelated write",
          log: () => {},
        }),
      UNRELATED_FAILURE
    );
  });
});
