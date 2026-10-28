import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { deferred } from "./deferred.js";
import {
  makeSession,
  noopCooperativeDelay,
} from "./helpers/collector-manager-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
});

test("first-party CollectorManager boot-import watchdog surfaces timedOut (NOT complete) when a harness import wedges (never hangs the splash)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-wedged-import-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    let bootCompleteCount = 0;
    let bootTimeoutCount = 0;
    let resolveBootTimeout: (() => void) | undefined;
    const bootTimeout = new Promise<void>((resolve) => {
      resolveBootTimeout = resolve;
    });
    // Explicit completion signals so the test proves both imports actually ran
    // before it ticks the watchdog: the codex import must complete, and the
    // wedged claude parse must have been entered. Waiting on event-loop turns
    // alone would pass even if neither deferred import ever fired (the watchdog
    // is armed synchronously in start()).
    const codexImported = deferred<void>();
    const claudeParseStarted = deferred<void>();
    const codexSource = join(dir, "codex.jsonl");
    const claudeSource = join(dir, "claude.jsonl");
    writeFileSync(codexSource, "{}\n");
    writeFileSync(claudeSource, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      // Small watchdog so the wedged-harness path times out deterministically
      // under fake timers instead of the 30-minute production default.
      bootImportWatchdogMs: 5000,
      // FEA-4156: the watchdog must NOT declare completion — completion triggers
      // post-boot maintenance, which would re-queue onto the wedged host.
      onBootImportComplete: () => {
        bootCompleteCount++;
      },
      onBootImportTimeout: () => {
        bootTimeoutCount++;
        resolveBootTimeout?.();
      },
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [codexSource],
          parse: async () => {
            codexImported.resolve();
            return [makeSession("codex-session")];
          },
        },
        {
          key: "claude",
          cacheName: "claude",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [claudeSource],
          // The wedged Claude import: its parse promise never settles, so this
          // harness's first-import promise stays pending forever. Without the
          // watchdog `Promise.allSettled` never resolves and the splash hangs.
          parse: () => {
            claudeParseStarted.resolve();
            return new Promise<NormalizedSession[]>(() => undefined);
          },
        },
      ],
    });

    manager.start();
    // Await the two completion signals declared above before ticking the timer.
    await Promise.all([codexImported.promise, claudeParseStarted.promise]);
    // Let the codex import's post-parse write settle so its first-import promise
    // resolves before we assert the aggregate is still pending on claude.
    await new Promise((resolve) => setImmediate(resolve));

    // The wedged Claude harness keeps boot completion pending on its own.
    assert.equal(bootCompleteCount, 0);
    assert.equal(bootTimeoutCount, 0);
    assert.equal(
      manager.getIngestProgress().complete,
      false,
      "completion stays pending while a harness import is wedged"
    );
    assert.equal(manager.getIngestProgress().timedOut, false);

    // The bounded watchdog fires and surfaces the degraded timedOut signal so the
    // splash can resolve — but it does NOT declare completion (which would run
    // post-boot maintenance against the still-wedged import boundary).
    nodeTestTimers.tick(5000);
    await bootTimeout;
    assert.equal(bootTimeoutCount, 1);
    assert.equal(
      bootCompleteCount,
      0,
      "the watchdog must never fire onBootImportComplete (no maintenance on a wedged import)"
    );
    assert.equal(
      manager.getIngestProgress().complete,
      false,
      "complete stays reserved for imports that actually settled"
    );
    assert.equal(
      manager.getIngestProgress().timedOut,
      true,
      "the watchdog surfaces the degraded timedOut signal so the splash never hangs"
    );

    await manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager boot-import watchdog re-arms while paused instead of timing out (a deliberate pause is not a wedge)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-paused-import-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    let bootTimeoutCount = 0;
    const claudeParseStarted = deferred<void>();
    const claudeSource = join(dir, "claude.jsonl");
    writeFileSync(claudeSource, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      bootImportWatchdogMs: 5000,
      onBootImportTimeout: () => {
        bootTimeoutCount++;
      },
      collectors: [
        {
          key: "claude",
          cacheName: "claude",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [claudeSource],
          // Never settles, so the boot import stays pending — the watchdog would
          // fire were the import not intentionally paused.
          parse: () => {
            claudeParseStarted.resolve();
            return new Promise<NormalizedSession[]>(() => undefined);
          },
        },
      ],
    });

    manager.start();
    // Wait for the wedged parse to actually be entered before pausing, so the
    // test proves the import is genuinely in-flight (not merely that four
    // event-loop turns elapsed) when the pause makes the watchdog re-arm.
    await claudeParseStarted.promise;
    // The user pauses the backfill: an intentional pause, not a wedge.
    manager.pauseImport();

    // The window elapses. Because the import is paused, the watchdog re-arms
    // rather than declaring a timeout.
    nodeTestTimers.tick(5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      bootTimeoutCount,
      0,
      "a paused import must not be treated as a wedged one"
    );
    assert.equal(manager.getIngestProgress().timedOut, false);

    // After resume, the re-armed watchdog fires on the still-wedged import.
    manager.resumeImport();
    nodeTestTimers.tick(5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      bootTimeoutCount,
      1,
      "once resumed, the re-armed watchdog times out the genuinely wedged import"
    );
    assert.equal(manager.getIngestProgress().timedOut, true);

    await manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager pauses the historical import loop until resumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-pause-"));
  try {
    const sources: string[] = [];
    for (let i = 0; i < 3; i++) {
      const source = join(dir, `codex-${i}.jsonl`);
      writeFileSync(source, "{}\n");
      sources.push(source);
    }
    let imported = 0;
    const managerRef: { current?: CollectorManager } = {};
    const bootComplete = deferred();
    const firstImported = deferred();

    const manager = new CollectorManager({
      importer: {
        importSession: async () => {
          imported += 1;
          // Pause after the first source imports, before the loop re-checks.
          if (imported === 1) {
            managerRef.current?.pauseImport();
            firstImported.resolve();
          }
          return { skipped: false, reactivated: false };
        },
      },
      stateDir: join(dir, "state"),
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: noopCooperativeDelay,
      onBootImportComplete: () => bootComplete.resolve(),
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => sources,
          parse: async (source) => [makeSession(`session-${source}`)],
        },
      ],
    });
    managerRef.current = manager;

    manager.start();
    await firstImported.promise;
    // Extra turns to prove the loop does NOT advance past the pause gate.
    await settleAsyncTurns(10);
    assert.equal(imported, 1, "halts at the pause gate after one source");
    assert.equal(manager.isImportPaused(), true);
    assert.deepEqual(manager.getIngestProgress(), {
      byHarness: [{ harness: "codex", total: 3, processed: 1 }],
      total: 3,
      processed: 1,
      preparing: false,
      // ISS-5281: parked mid-flight (on the gate, not merely the pause REQUEST
      // asserted above), so the pass has NOT drained.
      drained: false,
      importParked: true,
      complete: false,
      timedOut: false,
      retriesExhausted: false,
      quarantinedByStage: { import: 0, parse: 0 },
      quarantinedCount: 0,
    });

    manager.resumeImport();
    await bootComplete.promise;
    assert.equal(imported, 3, "the remaining sources import after resume");
    assert.deepEqual(manager.getIngestProgress(), {
      byHarness: [{ harness: "codex", total: 3, processed: 3 }],
      total: 3,
      processed: 3,
      preparing: false,
      drained: true, // ISS-5281: ran to completion, nothing left retryable.
      importParked: false,
      complete: true,
      timedOut: false,
      retriesExhausted: false,
      quarantinedByStage: { import: 0, parse: 0 },
      quarantinedCount: 0,
    });
    await manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager stop() unblocks a paused historical import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-pause-stop-"));
  try {
    const sources: string[] = [];
    for (let i = 0; i < 3; i++) {
      const source = join(dir, `codex-${i}.jsonl`);
      writeFileSync(source, "{}\n");
      sources.push(source);
    }
    let imported = 0;
    const managerRef: { current?: CollectorManager } = {};
    const firstImported = deferred();

    const manager = new CollectorManager({
      importer: {
        importSession: async () => {
          imported += 1;
          if (imported === 1) {
            managerRef.current?.pauseImport();
            firstImported.resolve();
          }
          return { skipped: false, reactivated: false };
        },
      },
      stateDir: join(dir, "state"),
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: noopCooperativeDelay,
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => sources,
          parse: async (source) => [makeSession(`session-${source}`)],
        },
      ],
    });
    managerRef.current = manager;

    manager.start();
    await firstImported.promise;
    assert.equal(imported, 1);
    assert.equal(manager.isImportPaused(), true);

    // stop() must resolve the pause gate and end the pass without importing more.
    await manager.stop();
    assert.equal(manager.isImportPaused(), false, "stop() clears the pause");
    await settleAsyncTurns(10);
    assert.equal(imported, 1, "no further sources import after stop()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager clears the preparing marker when the scan throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-prep-throw-"));
  try {
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
    });
    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      stateDir: join(dir, "state"),
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: noopCooperativeDelay,
      onBootImportComplete: () => resolveBootComplete?.(),
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          // The source enumeration throws mid-scan, after the preparing marker
          // has been set.
          listSources: () => {
            throw new Error("scan boom");
          },
          parse: async () => [],
        },
      ],
    });

    manager.start();
    await bootComplete;
    // The failed scan must not leave the indeterminate marker stuck on, which
    // would otherwise show preparing:true alongside complete:true until restart.
    const progress = manager.getIngestProgress();
    assert.equal(
      progress.preparing,
      false,
      "preparing cleared after scan throw"
    );
    assert.equal(progress.complete, true);
    await manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager can stagger boot historical imports", {
  timeout: 5000,
}, async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "collector-manager-staggered-import-")
  );
  try {
    nodeTestTimers.enable(["setTimeout"]);
    const imported: string[] = [];
    let bootCompleteCount = 0;
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
    });
    // Deterministic signal for "the codex source finished importing", emitted by
    // the importer itself. Cursor stays gated behind the un-ticked stagger timer,
    // so awaiting this observes exactly the codex import and nothing more.
    const codexImported = deferred();
    const codexSource = join(dir, "codex.jsonl");
    const cursorSource = join(dir, "cursor.jsonl");
    writeFileSync(codexSource, "{}\n");
    writeFileSync(cursorSource, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async (session) => {
          imported.push(session.sessionId);
          if (session.sessionId === "codex-session") {
            codexImported.resolve();
          }
          return { skipped: false, reactivated: false };
        },
      },
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportDelayMs: 25,
      historicalImportStaggerMs: 100,
      catchupPollMs: null,
      onBootImportComplete: () => {
        bootCompleteCount++;
        resolveBootComplete?.();
      },
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [codexSource],
          parse: async () => [makeSession("codex-session")],
        },
        {
          key: "cursor",
          cacheName: "cursor",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [cursorSource],
          parse: async () => [makeSession("cursor-session")],
        },
      ],
    });

    manager.start();
    await new Promise((resolve) => setImmediate(resolve));

    nodeTestTimers.tick(25);
    // Wait for the codex import to land via the importer's own signal — no turn
    // budget, so this cannot race the real prewarm+parse work under CI load.
    await codexImported.promise;
    assert.deepEqual(imported, ["codex-session"]);
    assert.equal(bootCompleteCount, 0);

    nodeTestTimers.tick(100);
    await bootComplete;
    await manager.stop();

    assert.deepEqual(imported, ["codex-session", "cursor-session"]);
    assert.equal(bootCompleteCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager drops a stale generation's ingest progress after a stop mid-scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-stale-gen-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    const source = join(dir, "codex.jsonl");
    writeFileSync(source, "{}\n");

    let extraMtimeCalls = 0;
    let stopManager: (() => void) | undefined;
    let resolveScanReached: (() => void) | undefined;
    const scanReached = new Promise<void>((resolve) => {
      resolveScanReached = resolve;
    });
    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportDelayMs: 25,
      catchupPollMs: null,
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [source],
          // Called per source DURING the cooperative collectPendingSources scan.
          // Stop the manager here so this generation is no longer active by the
          // time the awaited scan returns and importSources would publish
          // progress.
          extraMtime: () => {
            extraMtimeCalls++;
            resolveScanReached?.();
            stopManager?.();
            return null;
          },
          parse: async () => [makeSession("codex-session")],
        },
      ],
    });
    stopManager = () => manager.stop();

    manager.start();
    await new Promise((resolve) => setImmediate(resolve));
    nodeTestTimers.tick(25);
    await scanReached;
    // Let importSources resume past the awaited scan and run its post-scan
    // active-generation guard.
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.ok(extraMtimeCalls > 0, "the scan should have reached the source");
    const progress = manager.getIngestProgress();
    assert.equal(
      progress.byHarness.find((entry) => entry.harness === "codex"),
      undefined,
      "a stopped generation must not publish ingest progress"
    );
    assert.equal(progress.total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager pauses between sources for large cold-cache imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-large-backlog-"));
  try {
    const sources = Array.from({ length: 60 }, (_, index) =>
      join(dir, `codex-${index}.jsonl`)
    );
    for (const source of sources) {
      writeFileSync(source, "{}\n");
    }
    const delayCalls: number[] = [];
    let parseCount = 0;
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
    });

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: true, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: async (ms) => {
        delayCalls.push(ms);
      },
      onBootImportComplete: () => {
        resolveBootComplete?.();
      },
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => sources,
          parse: async () => {
            parseCount++;
            return [];
          },
        },
      ],
    });

    manager.start();
    await bootComplete;
    await manager.stop();

    assert.equal(parseCount, sources.length);
    assert.equal(delayCalls.length, sources.length);
    assert.ok(delayCalls.every((ms) => ms >= 10 && ms <= 100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Yield the event loop `turns` times so pending import microtasks can run. */
async function settleAsyncTurns(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
