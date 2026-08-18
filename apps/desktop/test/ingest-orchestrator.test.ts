import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { createCatchupCache } from "../src/main/collectors/engine/catchup-cache.js";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { HistoricalParseRunner } from "../src/main/collectors/engine/historical-parse-runner.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits.js";
import { isImportableCollectorSource } from "../src/main/collectors/engine/source-admission.js";
import type {
  HarnessCollector,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import { InvalidTokenCountError } from "../src/main/cost/token-counts.js";
import { parseIngest } from "../src/renderer/hooks/use-ingest-progress.js";
import { deferred } from "./deferred.js";
import {
  makeSession,
  waitUntil,
} from "./helpers/collector-manager-fixtures.js";
import { fakeCollector } from "./normalized-session-test-utils.js";

afterEach(() => {
  mock.timers.reset();
});

test("first-party CollectorManager imports every injected harness, including OpenCode batch ingestion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-ingest-"));
  const imported: Array<{ sessionId: string; harness: string }> = [];
  try {
    const codexSource = join(dir, "codex.jsonl");
    const opencodeSentinel = join(dir, "opencode");
    writeFileSync(codexSource, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async (session, harness) => {
          imported.push({ sessionId: session.sessionId, harness });
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      collectors: [
        fakeCollector("codex", {
          sources: [codexSource],
          sessions: [makeSession("codex-session")],
        }),
        fakeCollector("opencode", {
          sources: [opencodeSentinel],
          sessions: [makeSession("opencode-session")],
          batch: true,
        }),
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 2);
    manager.stop();

    assert.deepEqual(
      imported.sort((a, b) => a.harness.localeCompare(b.harness)),
      [
        { sessionId: "codex-session", harness: "codex" },
        { sessionId: "opencode-session", harness: "opencode" },
      ]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4476: a poison session in a batch source does not skip the later sessions or wedge the source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-batch-poison-"));
  const opencodeSentinel = join(dir, "opencode");
  const imported: string[] = [];
  const markedSources: string[] = [];
  try {
    // A single batch: true source (OpenCode) yields THREE sessions; the middle
    // one fails to import (the ISS-4476 mis-owned-collision fail-closed, or any
    // other per-session throw surfaced as ImportResult.failed). Pre-fix the loop
    // `break`ed on the first failure, so `poison-2` skipped `good-3` entirely and
    // — because the batch source is only marked seen when every session imported
    // — the whole batch was retried on every sweep, wedging the backfill.
    const manager = new CollectorManager({
      importer: {
        importSession: async (session) => {
          if (session.sessionId === "poison-2") {
            return { skipped: true, reactivated: false, failed: true };
          }
          imported.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      collectors: [
        {
          ...fakeCollector("opencode", {
            sources: [opencodeSentinel],
            sessions: [
              makeSession("good-1"),
              makeSession("poison-2"),
              makeSession("good-3"),
            ],
            batch: true,
          }),
          // A batch source is only marked seen when EVERY session imported, so a
          // poison session must leave the source unmarked for a retry.
          markSourceImported: (source: string) => {
            markedSources.push(source);
          },
        } as HarnessCollector,
      ],
    });

    manager.start();
    // `good-3` must import despite `poison-2` failing earlier in the same source.
    await waitUntil(() => imported.includes("good-3"));
    manager.stop();

    assert.deepEqual(
      imported.sort(),
      ["good-1", "good-3"],
      "both healthy sessions import; only the poison session is skipped"
    );
    assert.deepEqual(
      markedSources,
      [],
      "a source with a failed session is left unmarked so it is retried, never permanently lost"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager imports parsed sessions from any working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-ungated-"));
  const imported: string[] = [];
  try {
    const source = join(dir, "codex.jsonl");
    writeFileSync(source, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async (session) => {
          imported.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      collectors: [
        fakeCollector("codex", {
          sources: [source],
          sessions: [
            makeSession("inside-session", "/sandbox/project"),
            makeSession("outside-session", "/other/project"),
          ],
        }),
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 2);
    manager.stop();

    assert.deepEqual(imported, ["inside-session", "outside-session"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager uses historical parser runner for bulk imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-worker-runner-"));
  const source = join(dir, "opencode.db");
  const imported: string[] = [];
  const runnerCalls: Array<{ harness: string; source: string }> = [];
  const markedSources: string[] = [];
  let parserCalls = 0;
  let stopCalls = 0;
  try {
    writeFileSync(source, "db");
    const runner: HistoricalParseRunner = {
      parseSource: async (harness, parsedSource) => {
        runnerCalls.push({ harness, source: parsedSource });
        // ISS-5266: the runner resolves with the parse RESULT. This fake carries
        // no side-report, which is the shape every non-OpenCode parse returns.
        return { sessions: [makeSession("worker-session")] };
      },
      stop: () => {
        stopCalls++;
      },
    };

    const manager = new CollectorManager({
      importer: {
        importSession: async (session) => {
          imported.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "disabled",
      historicalParseRunner: runner,
      collectors: [
        {
          key: "opencode",
          cacheName: "opencode",
          batch: true,
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [source],
          parse: async () => {
            parserCalls++;
            throw new Error("historical import should use runner");
          },
          markSourceImported: (markedSource) => {
            markedSources.push(markedSource);
          },
        },
      ],
    });

    manager.start();
    await waitUntil(() => imported.length === 1);
    manager.stop();

    assert.deepEqual(runnerCalls, [{ harness: "opencode", source }]);
    assert.deepEqual(imported, ["worker-session"]);
    assert.deepEqual(markedSources, [source]);
    assert.equal(parserCalls, 0);
    assert.equal(stopCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager front-loads normal-sized sources before giant transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-first-data-"));
  const stateDir = join(dir, "state");
  const smallSource = join(dir, "small.jsonl");
  const giantSource = join(dir, "giant.jsonl");
  const parsedSources: string[] = [];
  let resolveBootComplete: (() => void) | undefined;
  const bootComplete = new Promise<void>((resolve) => {
    resolveBootComplete = resolve;
  });

  try {
    writeFileSync(smallSource, "{}\n");
    writeFileSync(
      giantSource,
      "x".repeat(HistoricalParseWorkerLimits.maxWorkerResponseTextBytes + 1)
    );
    const older = new Date("2026-06-08T12:00:00.000Z");
    const newer = new Date("2026-06-08T12:01:00.000Z");
    utimesSync(smallSource, older, older);
    utimesSync(giantSource, newer, newer);

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir,
      emit: () => {},
      getCollectionMode: () => "disabled",
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
          listSources: () => [giantSource, smallSource],
          parse: async (parsedSource) => {
            parsedSources.push(parsedSource);
            return [makeSession(parsedSource)];
          },
        },
      ],
    });

    manager.start();
    await bootComplete;
    manager.stop();

    assert.deepEqual(parsedSources, [smallSource, giantSource]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager treats null historical delay as live-only collection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-no-history-"));
  try {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let parseCount = 0;
    let bootCompleteCount = 0;
    const source = join(dir, "codex.jsonl");
    writeFileSync(source, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      historicalImportDelayMs: null,
      onBootImportComplete: () => {
        bootCompleteCount++;
      },
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [source],
          parse: async () => {
            parseCount++;
            return [makeSession("codex-session")];
          },
        },
      ],
    });

    manager.start();
    mock.timers.tick(120_000);
    await new Promise((resolve) => setImmediate(resolve));
    manager.stop();

    assert.equal(parseCount, 0);
    assert.equal(bootCompleteCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager skips unchanged malformed token sources after validation failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-invalid-token-"));
  const stateDir = join(dir, "state");
  const source = join(dir, "codex.jsonl");
  writeFileSync(source, "{}\n");
  let parseCount = 0;

  try {
    const collector: HarnessCollector = {
      key: "codex",
      cacheName: "codex",
      allowUnscopedSourceAdmission: true,
      watchRoots: () => [],
      watchMatch: () => true,
      listSources: () => [source],
      parse: async () => {
        parseCount++;
        throw new InvalidTokenCountError("codex.invalid_token_count");
      },
    };

    await runBootImport(stateDir, collector);
    assert.equal(parseCount, 1);

    await runBootImport(stateDir, collector);
    assert.equal(parseCount, 1, "unchanged invalid source stays quarantined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager does not finalize batch source after importer failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-import-failure-"));
  const source = join(dir, "opencode.db");
  const markedSources: string[] = [];
  try {
    writeFileSync(source, "db");

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({
          skipped: true,
          reactivated: false,
          failed: true,
        }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "disabled",
      collectors: [
        {
          key: "opencode",
          cacheName: "opencode",
          batch: true,
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [source],
          parse: async () => [makeSession("opencode-session")],
          markSourceImported: (markedSource) => {
            markedSources.push(markedSource);
          },
        },
      ],
    });

    manager.start();
    await new Promise((resolve) => setImmediate(resolve));
    manager.stop();

    assert.deepEqual(markedSources, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager can delay historical imports without dropping boot completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-delayed-import-"));
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    let parseCount = 0;
    let bootCompleteCount = 0;
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
    });
    const source = join(dir, "codex.jsonl");
    writeFileSync(source, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportDelayMs: 25,
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
          listSources: () => [source],
          parse: async () => {
            parseCount++;
            return [makeSession("codex-session")];
          },
        },
      ],
    });

    manager.start();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(parseCount, 0);
    assert.equal(bootCompleteCount, 0);

    mock.timers.tick(25);
    await bootComplete;
    manager.stop();

    assert.equal(parseCount, 1);
    assert.equal(bootCompleteCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager boot-import watchdog surfaces timedOut (NOT complete) when a harness import wedges (never hangs the splash)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-wedged-import-"));
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
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
      detectBillingMode: () => "metered_api",
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
    mock.timers.tick(5000);
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

    manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager boot-import watchdog re-arms while paused instead of timing out (a deliberate pause is not a wedge)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-paused-import-"));
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    let bootTimeoutCount = 0;
    const claudeParseStarted = deferred<void>();
    const claudeSource = join(dir, "claude.jsonl");
    writeFileSync(claudeSource, "{}\n");

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
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
    mock.timers.tick(5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      bootTimeoutCount,
      0,
      "a paused import must not be treated as a wedged one"
    );
    assert.equal(manager.getIngestProgress().timedOut, false);

    // After resume, the re-armed watchdog fires on the still-wedged import.
    manager.resumeImport();
    mock.timers.tick(5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      bootTimeoutCount,
      1,
      "once resumed, the re-armed watchdog times out the genuinely wedged import"
    );
    assert.equal(manager.getIngestProgress().timedOut, true);

    manager.stop();
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
          // Pause right after the first source imports, before the loop returns
          // to the top for the next source and re-checks the pause flag.
          if (imported === 1) {
            managerRef.current?.pauseImport();
            firstImported.resolve();
          }
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
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
      // ISS-5281: parked mid-flight, so the pass has NOT drained.
      drained: false,
      // Parked on the gate, not merely the pause REQUEST asserted above.
      importParked: true,
      complete: false,
      timedOut: false,
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
      // ISS-5281: ran to completion, nothing left retryable.
      drained: true,
      importParked: false,
      complete: true,
      timedOut: false,
      quarantinedByStage: { import: 0, parse: 0 },
      quarantinedCount: 0,
    });
    manager.stop();
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
      detectBillingMode: () => "metered_api",
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
    manager.stop();
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
      detectBillingMode: () => "metered_api",
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
    manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager getIngestProgress satisfies the renderer parseIngest contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-ingest-contract-"));
  try {
    const source = join(dir, "codex.jsonl");
    writeFileSync(source, "{}\n");
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
    });
    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
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
          listSources: () => [source],
          parse: async () => [makeSession("contract-session")],
        },
      ],
    });

    manager.start();
    await bootComplete;

    // Feed the real producer output through the renderer consumer so the two
    // cannot drift (field names, recomputed `processed`, the booleans).
    const progress = manager.getIngestProgress();
    const parsed = parseIngest({ ingest: progress });
    assert.ok(
      parsed,
      "renderer parseIngest accepts the live getIngestProgress"
    );
    assert.equal(parsed.total, progress.total);
    assert.equal(parsed.processed, progress.processed);
    assert.equal(parsed.preparing, progress.preparing);
    assert.equal(parsed.complete, progress.complete);
    assert.equal(parsed.timedOut, progress.timedOut);
    assert.deepEqual(parsed.byHarness, progress.byHarness);
    manager.stop();
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
    mock.timers.enable({ apis: ["setTimeout"] });
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
      detectBillingMode: () => "metered_api",
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

    mock.timers.tick(25);
    // Wait for the codex import to land via the importer's own signal — no turn
    // budget, so this cannot race the real prewarm+parse work under CI load.
    await codexImported.promise;
    assert.deepEqual(imported, ["codex-session"]);
    assert.equal(bootCompleteCount, 0);

    mock.timers.tick(100);
    await bootComplete;
    manager.stop();

    assert.deepEqual(imported, ["codex-session", "cursor-session"]);
    assert.equal(bootCompleteCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager drops a stale generation's ingest progress after a stop mid-scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-stale-gen-"));
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
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
      detectBillingMode: () => "metered_api",
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
    mock.timers.tick(25);
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
      detectBillingMode: () => "metered_api",
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
    manager.stop();

    assert.equal(parseCount, sources.length);
    assert.equal(delayCalls.length, sources.length);
    assert.ok(delayCalls.every((ms) => ms >= 10 && ms <= 100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager cancels stale-generation historical imports after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-stale-gen-"));
  try {
    const source = join(dir, "opencode.db");
    writeFileSync(source, "db");
    const imported: string[] = [];
    const markedSources: string[] = [];
    let listCalls = 0;
    let releaseDelay: (() => void) | undefined;
    let resolveDelayStarted: (() => void) | undefined;
    const delayStarted = new Promise<void>((resolve) => {
      resolveDelayStarted = resolve;
    });
    const manager = new CollectorManager({
      importer: {
        importSession: async (session) => {
          imported.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: () => {
        resolveDelayStarted?.();
        return new Promise<void>((delayResolve) => {
          releaseDelay = delayResolve;
        });
      },
      collectors: [
        {
          key: "opencode",
          cacheName: "opencode",
          batch: true,
          watchRoots: () => [dir],
          watchMatch: () => true,
          listSources: () => (++listCalls === 1 ? [source] : []),
          parse: async () => [
            makeSession("stale-generation-1"),
            makeSession("stale-generation-2"),
          ],
          markSourceImported: (markedSource) => {
            markedSources.push(markedSource);
          },
        },
      ],
    });

    manager.start();
    await delayStarted;
    manager.stop();
    manager.start();
    releaseDelay?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    manager.stop();

    assert.deepEqual(imported, []);
    assert.deepEqual(markedSources, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager rejects historical sources outside collector roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-source-root-"));
  const outsideDir = mkdtempSync(
    join(tmpdir(), "collector-manager-source-out-")
  );
  try {
    const inside = join(dir, "inside.jsonl");
    const outside = join(outsideDir, "outside.jsonl");
    const linked = join(dir, "linked.jsonl");
    writeFileSync(inside, "{}\n");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, linked);
    const parsedSources: string[] = [];
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
    });

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: true, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "disabled",
      onBootImportComplete: () => {
        resolveBootComplete?.();
      },
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          watchRoots: () => [dir],
          watchMatch: () => true,
          listSources: () => [inside, outside, linked],
          parse: async (source) => {
            parsedSources.push(source);
            return [makeSession(`session-${parsedSources.length}`)];
          },
        },
      ],
    });

    manager.start();
    await bootComplete;
    manager.stop();

    assert.deepEqual(parsedSources, [inside]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("first-party source admission requires explicit unscoped collector opt-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-source-admission-"));
  try {
    const source = join(dir, "session.jsonl");
    writeFileSync(source, "{}\n");
    const collector = {
      key: "codex",
      cacheName: "codex",
      watchRoots: () => [],
      watchMatch: () => true,
      listSources: () => [source],
      parse: async () => [makeSession("codex-session")],
    } satisfies HarnessCollector;

    assert.equal(isImportableCollectorSource(collector, source), false);
    assert.equal(
      isImportableCollectorSource(
        { ...collector, allowUnscopedSourceAdmission: true },
        source
      ),
      true
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party catchup cache persists unchanged source fingerprints", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-cache-"));
  try {
    const cachePath = join(dir, "ingest-cache-codex.json");
    const source = join(dir, "codex.jsonl");
    const removedSource = join(dir, "removed.jsonl");
    writeFileSync(source, "session one\n");
    writeFileSync(removedSource, "remove me\n");

    const first = createCatchupCache({ persistPath: cachePath });
    const firstStatus = first.isUnchanged(source);
    assert.equal(firstStatus.unchanged, false);
    first.markSeenWith(source, firstStatus.stat);
    first.markSeen(removedSource);
    assert.equal(first.size(), 2);
    first.pruneTo([source]);
    assert.equal(first.size(), 1);
    first.flush();
    assert.equal(existsSync(cachePath), true);

    const second = createCatchupCache({ persistPath: cachePath });
    assert.equal(second.isUnchanged(source).unchanged, true);

    appendFileSync(source, "session one changed\n");
    assert.equal(second.isUnchanged(source).unchanged, false);
    assert.equal(second.isUnchanged(removedSource).unchanged, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CollectorManager re-imports a cache-seen source whose session row is missing from the DB (orphan self-heal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-orphan-"));
  const stateDir = join(dir, "state");
  try {
    const source = join(dir, "codex-session.jsonl");
    writeFileSync(source, "{}\n");
    const sessionId = "codex-session";

    // Pass 1: warm import. Marks the source seen in the persistent ingest cache
    // (flushed to disk on stop), exactly like a normal boot import.
    const firstImports: string[] = [];
    const warm = makeOrphanManager({
      stateDir,
      source,
      sessionId,
      imported: firstImports,
    });
    warm.start();
    await waitUntil(() => firstImports.length === 1);
    warm.stop();
    assert.deepEqual(firstImports, [sessionId]);
    assert.equal(
      existsSync(join(stateDir, "ingest-cache-codex.json")),
      true,
      "first pass should persist the catchup cache"
    );

    // Pass 2: a NEW manager (≈ restart) over the SAME persisted cache, but the
    // DB has been reset — listExistingSessionIds() returns the session id set
    // WITHOUT this row. The cache still marks the source "unchanged"; the
    // self-heal must re-import it anyway.
    const healImports: string[] = [];
    const heal = makeOrphanManager({
      stateDir,
      source,
      sessionId,
      imported: healImports,
      listExistingSessionIds: async () => new Set<string>(),
    });
    heal.start();
    await waitUntil(() => healImports.length === 1);
    heal.stop();
    assert.deepEqual(
      healImports,
      [sessionId],
      "orphaned cache-seen source must re-import when its row is absent from the DB"
    );

    // Pass 3: steady state — the DB DOES contain the session id, so the
    // cache-unchanged source is still skipped (no regression, no re-parse).
    // Nothing imports, so wait on boot-complete rather than an import count.
    const steadyImports: string[] = [];
    let resolveBoot: (() => void) | undefined;
    const booted = new Promise<void>((resolve) => {
      resolveBoot = resolve;
    });
    const steadyManager = makeOrphanManager({
      stateDir,
      source,
      sessionId,
      imported: steadyImports,
      listExistingSessionIds: async () => new Set<string>([sessionId]),
      onBootImportComplete: () => resolveBoot?.(),
    });
    steadyManager.start();
    await booted;
    steadyManager.stop();
    assert.deepEqual(
      steadyImports,
      [],
      "cache-unchanged source present in the DB must still be skipped"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeOrphanManager(opts: {
  stateDir: string;
  source: string;
  sessionId: string;
  imported: string[];
  listExistingSessionIds?: () => Promise<ReadonlySet<string>>;
  onBootImportComplete?: () => void;
}): CollectorManager {
  const collector: HarnessCollector = {
    key: "codex",
    cacheName: "codex",
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => [opts.source],
    parse: async () => [makeSession(opts.sessionId)],
    // FEA-1785: id derivable from the path alone — the lever the self-heal uses.
    sessionIdForSource: (s: string) =>
      s === opts.source ? opts.sessionId : null,
  };
  return new CollectorManager({
    importer: {
      importSession: async (session) => {
        opts.imported.push(session.sessionId);
        return { skipped: false, reactivated: false };
      },
    },
    detectBillingMode: () => "metered_api",
    stateDir: opts.stateDir,
    emit: () => {},
    getCollectionMode: () => "disabled",
    catchupPollMs: null,
    collectors: [collector],
    listExistingSessionIds: opts.listExistingSessionIds,
    onBootImportComplete: opts.onBootImportComplete,
  });
}

async function runBootImport(
  stateDir: string,
  collector: HarnessCollector
): Promise<void> {
  let resolveBootComplete: (() => void) | undefined;
  const bootComplete = new Promise<void>((resolve) => {
    resolveBootComplete = resolve;
  });
  const manager = new CollectorManager({
    importer: {
      importSession: async () => ({ skipped: false, reactivated: false }),
    },
    detectBillingMode: () => "metered_api",
    stateDir,
    emit: () => {},
    getCollectionMode: () => "disabled",
    catchupPollMs: null,
    onBootImportComplete: () => {
      resolveBootComplete?.();
    },
    collectors: [collector],
  });

  manager.start();
  await bootComplete;
  manager.stop();
}

async function noopCooperativeDelay(): Promise<void> {}

/** Yield the event loop `turns` times so pending import microtasks can run. */
async function settleAsyncTurns(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
