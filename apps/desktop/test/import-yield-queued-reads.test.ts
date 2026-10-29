/**
 * ISS-10401: a Sessions or Branches listing read posted while a session imports
 * must be served BETWEEN the import's record groups, not after the whole
 * session.
 *
 * Every `desktop:db:*` read executes on the db-host's single store thread, and
 * a read reaches it as an `Execute` message on the inner port, which that thread
 * picks up only when its loop reaches the poll phase. `@libsql/client` is
 * synchronous, so an `importSession` whose twelve record groups chain on
 * microtask continuations alone never gives the loop that turn: the read waited
 * out the entire session. `importSessionIsolated` now awaits `yieldDbHostLoop`
 * before each group's write is queued (FEA-2264's `setImmediate` boundary), so
 * the read is delivered at the next gap.
 *
 * The store thread is modelled with an in-process `MessageChannel`: a message
 * posted on one port is delivered on the other in the poll phase and only when
 * the loop turns — the same delivery the worker's inner port has. The database
 * is the real `SqliteAgentDatabase` (`openTestDb`, which wraps the production
 * `openSqliteAgentDatabase` and checks foreign keys at close), and the AFTER
 * arms drive the production importer. The BEFORE arms build a second importer
 * over the same database with a microtask-only `yieldBetweenGroups`, which is
 * exactly the shape that hung: it is what makes the AFTER assertions capable of
 * failing, and it is the arm ISS-8571 re-measures when a reader thread retires
 * the yields.
 *
 * Interleaving is one-for-one: the import hands the loop back once per group,
 * and a read hands it back at each of its OWN macrotask boundaries. A
 * single-statement read (`readLocalBranchLinkRows`) has none, so it settles
 * within ONE group of being posted. `loadSyncedSessions` has several (the
 * attribution `cwdExists` stats, its own FEA-2264 yields), so one import group
 * runs at each; it still settles while the import is in flight rather than
 * behind it, and the arm posted at the gate proves the row it returns is the
 * mid-import one.
 *
 * Every assertion is a happens-before over the write queue's task phases
 * (`onWriteTaskPhase`, keyed by the import's session-id token); no wall-clock
 * value is measured or asserted.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import { DATA_REVISION_IMPORT_PENDING } from "../src/main/collectors/engine/data-revision.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type {
  Importer,
  ImportResult,
} from "../src/main/dashboard/agent-dashboard-db-types.js";
import { readLocalBranchLinkRows } from "../src/main/database/branch-reads.js";
import {
  markStoreReadCancelled,
  runStoreReadUnderCancellation,
} from "../src/main/database/db-host/store-read-cancellation.js";
import { isImportFailureLogLine } from "../src/main/database/import-log-messages.js";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  createSqliteImporter,
  importSessionWithTx,
} from "../src/main/database/write-core.js";
import {
  WriteQueueTaskPhase,
  type WriteQueueTaskToken,
} from "../src/main/database/write-queue.js";
import { effectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import type { BillingMode } from "../src/shared/billing-mode.js";
import { READ_CANCELLED_ERROR_NAME } from "../src/shared/read-cancellation-contract.js";
import {
  assertNoSwallowedImportFailures,
  openTestDb,
} from "./agent-db-test-utils.js";
import {
  LARGE_SESSION_EVENT_CATEGORIES,
  makeLargeNormalizedSession,
} from "./support/large-normalized-session.js";

const HARNESS = "claude";
const NOW = "2026-06-07T12:00:00.000Z";
/**
 * `openTestDb`'s ledger-neutral default (ISS-7839), for the importers this
 * suite builds by hand over the same database. Nothing here asserts on
 * billing mode.
 */
const detectTestBillingMode = (): BillingMode => "unknown";
/** Enough rows to cross the chunked-INSERT boundary in every batched group. */
const PER_CATEGORY = 300;
/** Write tasks `importSessionIsolated` queues for one session. */
const IMPORT_TASK_COUNT = 12;
/**
 * One more than `SYNCED_SESSION_HYDRATE_CHUNK_SIZE` (200) so the hydration
 * plan takes its multi-batch path, which is where `loadSyncedSessions` reaches
 * a `yieldDbHostLoop` checkpoint at all.
 */
const CANCELLABLE_READ_ID_COUNT = 201;

type PhaseRecord = {
  token: WriteQueueTaskToken;
  phase: WriteQueueTaskPhase;
  taskSeq: number;
};

type PhaseListener = (record: PhaseRecord) => void;

type TestHarness = {
  db: SqliteAgentDatabase;
  phases: PhaseRecord[];
  listeners: Set<PhaseListener>;
  /**
   * Import-failure log lines from the hand-built control importer. `openTestDb`'s
   * ISS-5101 collector wraps only the log it hands `openSqliteAgentDatabase`,
   * so a tolerated group failing in the control arm is invisible to it;
   * `afterEach` runs the same assertion over these.
   */
  controlImportFailures: string[];
  /** Settled write tasks carrying `token` so far. */
  settledCount(token: string): number;
  lastPhase(token: string): WriteQueueTaskPhase | undefined;
};

type ImportRun = {
  settled: Promise<ImportResult>;
  isDone: () => boolean;
  token: string;
};

/** What a read observed about the import(s) it was posted against. */
type ReadObservation<T> = {
  value: T;
  /** Import-token tasks settled when the read was posted / when it settled. */
  settledAtPost: number;
  settledAtSettle: number;
  /** The import token's most recent phase when the read settled. */
  lastImportPhaseAtSettle: WriteQueueTaskPhase | undefined;
  importDoneAtSettle: boolean;
  /** `isDone()` of each extra import handed to `observeRead`, at settle. */
  othersDoneAtSettle: boolean[];
};

/**
 * The store thread's inner port, in-process. `post(run)` sends one message;
 * the handler on the far port starts `run` when the loop delivers it. A
 * microtask-only op between the post and the next loop turn therefore holds
 * every posted read exactly as the real store thread does.
 */
function createStoreThreadPort() {
  const { port1, port2 } = new MessageChannel();
  const pending = new Map<number, () => void>();
  let nextId = 0;
  port2.on("message", (message: { id: number }) => {
    const start = pending.get(message.id);
    pending.delete(message.id);
    start?.();
  });
  port2.unref();
  return {
    post<T>(run: () => Promise<T>): Promise<T> {
      const id = nextId;
      nextId += 1;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, () => {
          run().then(resolve, reject);
        });
        port1.postMessage({ id });
      });
    },
    close(): void {
      port1.close();
      port2.close();
    },
  };
}

let dir: string;
let harness: TestHarness;
let port: ReturnType<typeof createStoreThreadPort>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "import-yield-queued-reads-"));
  const phases: PhaseRecord[] = [];
  const listeners = new Set<PhaseListener>();
  const db = await openTestDb(dir, {
    now: () => NOW,
    onWriteTaskPhase: (token, phase, taskSeq) => {
      const record = { token, phase, taskSeq };
      phases.push(record);
      for (const listener of listeners) {
        listener(record);
      }
    },
  });
  harness = {
    db,
    phases,
    listeners,
    controlImportFailures: [],
    settledCount: (token) =>
      phases.filter(
        (record) =>
          record.token === token && record.phase === WriteQueueTaskPhase.Settled
      ).length,
    lastPhase: (token) =>
      phases.filter((record) => record.token === token).at(-1)?.phase,
  };
  port = createStoreThreadPort();
});

afterEach(async () => {
  port.close();
  try {
    assertNoSwallowedImportFailures(harness.controlImportFailures);
  } finally {
    await harness.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** The production importer, wired by `openSqliteAgentDatabase`. */
function productionImporter(): Importer {
  return harness.db.importer;
}

/**
 * The same import over the same database with the FEA-2264 yield collapsed to
 * a microtask — the pre-ISS-10401 shape. ISS-8571 flips this arm.
 */
function yieldlessImporter(): Importer {
  const { prisma } = harness.db;
  return createSqliteImporter(prisma, createSqliteTokenUsageStore(prisma), {
    detectBillingMode: detectTestBillingMode,
    now: () => NOW,
    log: (message) => {
      if (isImportFailureLogLine(message)) {
        harness.controlImportFailures.push(message);
      }
    },
    yieldBetweenGroups: () => Promise.resolve(),
  });
}

function startImport(
  importer: Importer,
  session: NormalizedSession
): ImportRun {
  let done = false;
  const settled = Promise.resolve(
    importer.importSession(session, HARNESS)
  ).finally(() => {
    done = true;
  });
  return { settled, isDone: () => done, token: session.sessionId };
}

/**
 * Start `session`'s import from the port's message handler — a driver's next
 * import landing on the store thread behind one already running.
 */
function startImportOnPort(
  importer: Importer,
  session: NormalizedSession
): ImportRun {
  let started: ImportRun | undefined;
  const settled = port.post(() => {
    started = startImport(importer, session);
    return started.settled;
  });
  return {
    settled,
    isDone: () => started?.isDone() ?? false,
    token: session.sessionId,
  };
}

/**
 * Post `run` to the store thread against `imported` and record, at settle, how
 * far that import (and any `others`) had progressed.
 */
function observeRead<T>(
  imported: ImportRun,
  run: () => Promise<T>,
  others: ImportRun[] = []
): Promise<ReadObservation<T>> {
  const settledAtPost = harness.settledCount(imported.token);
  return port.post(run).then((value) => ({
    value,
    settledAtPost,
    settledAtSettle: harness.settledCount(imported.token),
    lastImportPhaseAtSettle: harness.lastPhase(imported.token),
    importDoneAtSettle: imported.isDone(),
    othersDoneAtSettle: others.map((other) => other.isDone()),
  }));
}

/**
 * Fire `post` from inside the observer callback of the import token's Nth
 * (1-based) `Dispatched` phase — i.e. while that group holds the writer — and
 * resolve with what the posted read observed.
 */
function postAtDispatch<T>(
  token: string,
  ordinal: number,
  post: () => Promise<ReadObservation<T>>
): Promise<ReadObservation<T>> {
  return new Promise((resolve, reject) => {
    let dispatched = 0;
    const listener: PhaseListener = (record) => {
      if (
        record.token !== token ||
        record.phase !== WriteQueueTaskPhase.Dispatched
      ) {
        return;
      }
      dispatched += 1;
      if (dispatched === ordinal) {
        harness.listeners.delete(listener);
        post().then(resolve, reject);
      }
    };
    harness.listeners.add(listener);
  });
}

async function loadSessions(ids: string[]) {
  return await harness.db.syncSource.loadSyncedSessions(
    ids,
    createSessionAttributionResolverCache()
  );
}

function branchLinks() {
  return readLocalBranchLinkRows(harness.db.prisma);
}

async function countRows(table: string, sessionId: string): Promise<number> {
  const rows = await harness.db.prisma.client.$queryRawUnsafe<
    { cnt: number | bigint }[]
  >(`SELECT COUNT(*) AS cnt FROM ${table} WHERE session_id = $1`, sessionId);
  return Number(rows[0]?.cnt ?? 0);
}

/** What a complete import of the fixture leaves behind. */
const FULLY_IMPORTED = {
  events: PER_CATEGORY * LARGE_SESSION_EVENT_CATEGORIES,
  tokenEvents: PER_CATEGORY,
  settled: IMPORT_TASK_COUNT,
  gateSettledFirst: true,
};

async function importEvidence(
  session: NormalizedSession
): Promise<typeof FULLY_IMPORTED> {
  const importPhases = harness.phases.filter(
    (record) => record.token === session.sessionId
  );
  // The FK-parent gate is the first of THIS import's tasks to settle. A read
  // served in the pre-gate gap may enqueue its own token-less write (the
  // frustration write-back), which settles first on the idle queue and is
  // deliberately outside this filter.
  const firstSettled = importPhases.find(
    (record) => record.phase === WriteQueueTaskPhase.Settled
  );
  return {
    events: await countRows("events", session.sessionId),
    tokenEvents: await countRows("token_events", session.sessionId),
    settled: harness.settledCount(session.sessionId),
    gateSettledFirst:
      firstSettled !== undefined &&
      firstSettled.taskSeq === importPhases[0]?.taskSeq,
  };
}

describe("queued reads interleave between import groups (ISS-10401)", () => {
  it("serves readLocalBranchLinkRows within one group and loadSyncedSessions before the import finishes", async () => {
    const session = makeLargeNormalizedSession(PER_CATEGORY, "after-single");
    const imported = startImport(productionImporter(), session);
    const [sessions, links] = await Promise.all([
      observeRead(imported, () => loadSessions([session.sessionId])),
      observeRead(imported, branchLinks),
    ]);
    const result = await imported.settled;

    expect(result.failed).toBeUndefined();
    expect(result.incomplete).toBeUndefined();
    for (const observation of [sessions, links]) {
      expect(observation.importDoneAtSettle).toBe(false);
      expect(observation.settledAtSettle).toBeLessThan(IMPORT_TASK_COUNT);
    }
    // One statement, no boundary of its own: served whole at a gap — the
    // pre-gate one, or the one after the gate when the hydration read delivered
    // ahead of it hands the loop back first — never mid-group, so at its settle
    // the import's newest phase is a Settled or nothing yet.
    expect(links.settledAtSettle - links.settledAtPost).toBeLessThanOrEqual(1);
    expect([undefined, WriteQueueTaskPhase.Settled]).toContain(
      links.lastImportPhaseAtSettle
    );
    // ISS-11388: served at a gap before the seal, so it never sees the sealed
    // revision. Which gap is a race: the pre-gate one returns no row yet, a
    // later one returns the one row at the sentinel. Both arms are pinned; the
    // sentinel arm is also pinned deterministically by "a read served after the
    // gate sees the row at the import-pending sentinel".
    expect([[], [DATA_REVISION_IMPORT_PENDING]]).toContainEqual(
      sessions.value.map((row) => row.dataRevision)
    );
    expect(await importEvidence(session)).toEqual(FULLY_IMPORTED);
  });

  it("serves a read posted mid-import at the next gap, before the following group is queued", async () => {
    const session = makeLargeNormalizedSession(PER_CATEGORY, "after-midway");
    const imported = startImport(productionImporter(), session);
    // Posted while the events group (dispatch #2) holds the writer.
    const links = await postAtDispatch(session.sessionId, 2, () =>
      observeRead(imported, branchLinks)
    );
    await imported.settled;

    expect(links.importDoneAtSettle).toBe(false);
    expect(links.settledAtSettle - links.settledAtPost).toBe(1);
    // The yield precedes the next group's enqueue: at the read's settle the
    // import's newest phase is the previous group's Settled, never Queued or
    // Dispatched. That is what keeps the ISS-6003 per-group clock, which
    // starts on dispatch, from ever counting the gap.
    expect(links.lastImportPhaseAtSettle).toBe(WriteQueueTaskPhase.Settled);
    expect(await importEvidence(session)).toEqual(FULLY_IMPORTED);
  });

  it("control (yields collapsed): both reads wait out the whole session", async () => {
    const session = makeLargeNormalizedSession(PER_CATEGORY, "before-single");
    const imported = startImport(yieldlessImporter(), session);
    const [sessions, links] = await Promise.all([
      observeRead(imported, () => loadSessions([session.sessionId])),
      observeRead(imported, branchLinks),
    ]);
    const result = await imported.settled;

    expect(result.failed).toBeUndefined();
    expect(result.incomplete).toBeUndefined();
    for (const observation of [sessions, links]) {
      expect(observation.importDoneAtSettle).toBe(true);
      expect(observation.settledAtSettle).toBe(IMPORT_TASK_COUNT);
    }
    // Served after the seal, so it sees the finished row.
    expect(sessions.value.map((row) => row.dataRevision)).toEqual([
      effectiveDataRevision(),
    ]);
    expect(await importEvidence(session)).toEqual(FULLY_IMPORTED);
  });

  it("serves a read posted behind two concurrently in-flight imports before either finishes", async () => {
    const a = makeLargeNormalizedSession(PER_CATEGORY, "after-concurrent-a");
    const b = makeLargeNormalizedSession(PER_CATEGORY, "after-concurrent-b");
    const importA = startImport(productionImporter(), a);
    const importB = startImport(productionImporter(), b);
    const links = await observeRead(importA, branchLinks, [importB]);
    await Promise.all([importA.settled, importB.settled]);

    expect(links.importDoneAtSettle).toBe(false);
    expect(links.othersDoneAtSettle).toEqual([false]);
    expect(await importEvidence(a)).toEqual(FULLY_IMPORTED);
    expect(await importEvidence(b)).toEqual(FULLY_IMPORTED);
  });

  it("control (yields collapsed): a read behind two in-flight imports waits out both", async () => {
    const a = makeLargeNormalizedSession(PER_CATEGORY, "before-concurrent-a");
    const b = makeLargeNormalizedSession(PER_CATEGORY, "before-concurrent-b");
    const importer = yieldlessImporter();
    const importA = startImport(importer, a);
    const importB = startImport(importer, b);
    const links = await observeRead(importA, branchLinks, [importB]);
    const results = await Promise.all([importA.settled, importB.settled]);

    for (const result of results) {
      expect(result.failed).toBeUndefined();
      expect(result.incomplete).toBeUndefined();
    }
    expect(links.importDoneAtSettle).toBe(true);
    expect(links.othersDoneAtSettle).toEqual([true]);
    expect(await importEvidence(a)).toEqual(FULLY_IMPORTED);
    expect(await importEvidence(b)).toEqual(FULLY_IMPORTED);
  });

  it("a read posted during one import's group waits for that group only, not for a sibling import's group too (ISS-10911)", async () => {
    // Every in-flight import takes its between-group turn from one chain, so
    // one import group runs per loop turn. With a bare yield per import, both
    // imports' `setImmediate`s fired in the same check phase and B's group ran
    // straight after A's, before the poll phase delivered the read: every
    // macrotask boundary of a read cost N groups (ISS-10935's 197 s).
    const a = makeLargeNormalizedSession(PER_CATEGORY, "turns-a");
    const b = makeLargeNormalizedSession(PER_CATEGORY, "turns-b");
    const importer = productionImporter();
    const importA = startImport(importer, a);
    const importB = startImport(importer, b);
    let bSettledAtPost = 0;
    let bSettledAtSettle = 0;
    // Posted while A's events group (dispatch #2) holds the writer.
    const links = await postAtDispatch(a.sessionId, 2, () => {
      bSettledAtPost = harness.settledCount(b.sessionId);
      return observeRead(importA, branchLinks, [importB]).then(
        (observation) => {
          bSettledAtSettle = harness.settledCount(b.sessionId);
          return observation;
        }
      );
    });
    await Promise.all([importA.settled, importB.settled]);

    expect(links.othersDoneAtSettle).toEqual([false]);
    // A's own in-flight group, and nothing of B's.
    expect(links.settledAtSettle - links.settledAtPost).toBe(1);
    expect(bSettledAtSettle - bSettledAtPost).toBe(0);
    expect(await importEvidence(a)).toEqual(FULLY_IMPORTED);
    expect(await importEvidence(b)).toEqual(FULLY_IMPORTED);
  });

  it("serves a read queued behind the NEXT import's Execute before that import finishes", async () => {
    // A is running; a driver's next import (B) lands on the port ahead of a
    // renderer read (R). R must not wait out B — the pre-gate yield is what
    // lets it through.
    const a = makeLargeNormalizedSession(PER_CATEGORY, "after-port-a");
    const b = makeLargeNormalizedSession(PER_CATEGORY, "after-port-b");
    const importer = productionImporter();
    const importA = startImport(importer, a);
    const importB = startImportOnPort(importer, b);
    const links = await observeRead(importA, branchLinks, [importB]);
    await Promise.all([importA.settled, importB.settled]);

    expect(links.othersDoneAtSettle).toEqual([false]);
    expect(await importEvidence(a)).toEqual(FULLY_IMPORTED);
    expect(await importEvidence(b)).toEqual(FULLY_IMPORTED);
  });

  it("control (yields collapsed): a read queued behind the next import's Execute waits out that import too", async () => {
    const a = makeLargeNormalizedSession(PER_CATEGORY, "before-port-a");
    const b = makeLargeNormalizedSession(PER_CATEGORY, "before-port-b");
    const importer = yieldlessImporter();
    const importA = startImport(importer, a);
    const importB = startImportOnPort(importer, b);
    const links = await observeRead(importA, branchLinks, [importB]);
    const results = await Promise.all([importA.settled, importB.settled]);

    for (const result of results) {
      expect(result.failed).toBeUndefined();
      expect(result.incomplete).toBeUndefined();
    }
    expect(links.importDoneAtSettle).toBe(true);
    expect(links.othersDoneAtSettle).toEqual([true]);
    expect(await importEvidence(a)).toEqual(FULLY_IMPORTED);
    expect(await importEvidence(b)).toEqual(FULLY_IMPORTED);
  });

  it("a cancelled read's checkpoint never reaches the import, which runs with no cancellation scope", async () => {
    const session = makeLargeNormalizedSession(PER_CATEGORY, "cancel-inert");
    const token = "read-cancelled-mid-import";
    const ids = [
      session.sessionId,
      ...Array.from(
        { length: CANCELLABLE_READ_ID_COUNT - 1 },
        (_, index) => `absent-${index}`
      ),
    ];
    const imported = startImport(productionImporter(), session);
    // Cancelled from inside the message handler, right after the read starts:
    // the read runs to its first `yieldDbHostLoop` checkpoint and rejects on
    // resume, while the import's own yields see no scope and keep going.
    const read = port.post(() => {
      const running = runStoreReadUnderCancellation(token, () =>
        loadSessions(ids)
      );
      markStoreReadCancelled(token);
      return running;
    });
    await expect(read).rejects.toMatchObject({
      name: READ_CANCELLED_ERROR_NAME,
    });
    const result = await imported.settled;

    expect(result.failed).toBeUndefined();
    expect(result.incomplete).toBeUndefined();
    expect(await importEvidence(session)).toEqual(FULLY_IMPORTED);
  });

  it("an import dispatched under a cancelled read token still completes: its yields exit the scope", async () => {
    // No production path dispatches an import under a token today, but
    // `db-host-client.ts` attaches the ambient token to whatever op is going
    // out, by name, so the importer must not depend on that staying true. Every
    // between-group yield sits outside its group's `try`; without
    // `yieldImportGroupBoundary` exiting the scope, the first one throws
    // `DesktopReadCancelledError` and the import unwinds to `failed`.
    const session = makeLargeNormalizedSession(
      PER_CATEGORY,
      "cancel-scoped-import"
    );
    const token = "import-under-cancelled-token";
    markStoreReadCancelled(token);
    const result = await port.post(() =>
      runStoreReadUnderCancellation(token, () =>
        Promise.resolve(productionImporter().importSession(session, HARNESS))
      )
    );

    expect(result.failed).toBeUndefined();
    expect(result.incomplete).toBeUndefined();
    expect(await importEvidence(session)).toEqual(FULLY_IMPORTED);
  });

  it("the atomic rebuild path takes no loop turn", async () => {
    // `importSessionWithTx` runs INSIDE one caller transaction, the shape
    // #7538 measured expiring the transaction budget when it yields. A probe
    // posted while it runs must be delivered only after the transaction
    // settles; routing the rebuild through `runGroup` would redden this.
    const session = makeLargeNormalizedSession(PER_CATEGORY, "rebuild-atomic");
    const { prisma } = harness.db;
    let rebuilt = false;
    const rebuild = prisma
      .write((client) =>
        client.$transaction((tx) =>
          importSessionWithTx(
            tx,
            createSqliteTokenUsageStore(prisma),
            {
              detectBillingMode: detectTestBillingMode,
              log: () => {
                // The rebuild's own log lines are not this arm's subject.
              },
            },
            session,
            HARNESS,
            NOW,
            createSessionAttributionResolverCache(),
            effectiveParsePolicy()
          )
        )
      )
      .finally(() => {
        rebuilt = true;
      });
    const probeSawRebuildDone = await port.post(() => Promise.resolve(rebuilt));
    await rebuild;

    expect(probeSawRebuildDone).toBe(true);
    expect(await countRows("events", session.sessionId)).toBe(
      PER_CATEGORY * LARGE_SESSION_EVENT_CATEGORIES
    );
  });

  it("a read served after the gate sees the row at the import-pending sentinel, and the real revision after the seal", async () => {
    const session = makeLargeNormalizedSession(PER_CATEGORY, "pending-visible");
    const imported = startImport(productionImporter(), session);
    // Posted from the gate's dispatch, so it is delivered at the pre-events gap
    // — after the FK parent committed, before any child rows exist.
    const midway = await postAtDispatch(session.sessionId, 1, () =>
      observeRead(imported, () => loadSessions([session.sessionId]))
    );
    await imported.settled;
    const afterSeal = await loadSessions([session.sessionId]);

    expect(midway.importDoneAtSettle).toBe(false);
    expect(midway.settledAtSettle).toBeLessThan(IMPORT_TASK_COUNT);
    expect(midway.value.map((row) => row.dataRevision)).toEqual([
      DATA_REVISION_IMPORT_PENDING,
    ]);
    expect(afterSeal.map((row) => row.dataRevision)).toEqual([
      effectiveDataRevision(),
    ]);
    expect(await importEvidence(session)).toEqual(FULLY_IMPORTED);
  });
});
