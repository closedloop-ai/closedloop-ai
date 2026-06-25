import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  type FSWatcher,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { createCatchupCache } from "../src/main/collectors/catchup-cache.js";
import {
  CollectorManager,
  sourcePathsForWatcherEvents,
} from "../src/main/collectors/collector-manager.js";
import type { HistoricalParseRunner } from "../src/main/collectors/historical-parse-runner.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/historical-parse-worker-protocol.js";
import { createOpencodeCollector } from "../src/main/collectors/opencode/opencode-collector.js";
import { isImportableCollectorSource } from "../src/main/collectors/source-admission.js";
import type {
  HarnessCollector,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import { createHarnessWatcher } from "../src/main/collectors/watcher.js";
import { InvalidTokenCountError } from "../src/main/token-counts.js";

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
        fakeCollector("codex", [codexSource], [makeSession("codex-session")]),
        fakeCollector(
          "opencode",
          [opencodeSentinel],
          [makeSession("opencode-session")],
          true
        ),
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
        fakeCollector(
          "codex",
          [source],
          [
            makeSession("inside-session", "/sandbox/project"),
            makeSession("outside-session", "/other/project"),
          ]
        ),
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
        return [makeSession("worker-session")];
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

test("first-party CollectorManager can stagger boot historical imports", async () => {
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
    const codexSource = join(dir, "codex.jsonl");
    const cursorSource = join(dir, "cursor.jsonl");
    writeFileSync(codexSource, "{}\n");
    writeFileSync(cursorSource, "{}\n");

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
    await new Promise((resolve) => setImmediate(resolve));
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

test("first-party HarnessWatcher drains live events queued during historical import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-queued-events-"));
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    let emitWatcherEvent: ((filename: string) => void) | undefined;
    let resolveHistoricalStarted: (() => void) | undefined;
    let resolveHistorical: (() => void) | undefined;
    const historicalStarted = new Promise<void>((resolve) => {
      resolveHistoricalStarted = resolve;
    });
    const releaseHistorical = new Promise<void>((resolve) => {
      resolveHistorical = resolve;
    });
    const eventImports: string[][] = [];
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      runImport: async (events) => {
        if (events === null) {
          resolveHistoricalStarted?.();
          await releaseHistorical;
          return;
        }
        eventImports.push(events.map((event) => event.filename));
      },
    });

    const firstImport = watcher.start();
    await historicalStarted;
    emitWatcherEvent?.("live.jsonl");
    mock.timers.tick(600);
    resolveHistorical?.();
    await firstImport;
    assert.equal(
      eventImports.some((events) =>
        events.some((filename) => filename.endsWith("live.jsonl"))
      ),
      true
    );
    watcher.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher lets live events preempt resumable historical import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-preempt-live-"));
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    let emitWatcherEvent: ((filename: string) => void) | undefined;
    let resolveHistoricalStarted: (() => void) | undefined;
    let resolveLiveQueued: (() => void) | undefined;
    const historicalStarted = new Promise<void>((resolve) => {
      resolveHistoricalStarted = resolve;
    });
    const liveQueued = new Promise<void>((resolve) => {
      resolveLiveQueued = resolve;
    });
    const imports: string[] = [];
    let historicalRuns = 0;
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      runImport: async (events, controls) => {
        if (events !== null) {
          imports.push(`live:${events[0]?.filename}`);
          return;
        }
        historicalRuns++;
        imports.push(`historical:${historicalRuns}`);
        if (historicalRuns === 1) {
          resolveHistoricalStarted?.();
          await liveQueued;
          return {
            completed: !controls?.shouldYieldToLiveEvents(),
          };
        }
        return { completed: true };
      },
    });

    const firstImport = watcher.start();
    await historicalStarted;
    emitWatcherEvent?.("live.jsonl");
    mock.timers.tick(600);
    resolveLiveQueued?.();
    await firstImport;
    watcher.stop();

    assert.deepEqual(imports, [
      "historical:1",
      "live:live.jsonl",
      "historical:2",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher settles delayed initial import when stopped before it fires", async () => {
  let importCount = 0;
  const watcher = createHarnessWatcher({
    roots: () => [],
    match: () => true,
    runImport: async () => {
      importCount++;
    },
    initialImportDelayMs: 10_000,
  });

  const firstImport = watcher.start();
  watcher.stop();
  await firstImport;

  assert.equal(importCount, 0);
});

test("first-party HarnessWatcher coalesces excessive event bursts to a historical import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-event-burst-"));
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    let emitWatcherEvent: ((filename: string) => void) | undefined;
    const imports: Array<"historical" | number> = [];
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      runImport: async (events) => {
        imports.push(events === null ? "historical" : events.length);
      },
    });

    await watcher.start();
    for (let index = 0; index < 1005; index++) {
      emitWatcherEvent?.(`burst-${index}.jsonl`);
    }
    mock.timers.tick(600);
    await new Promise((resolve) => setImmediate(resolve));
    watcher.stop();

    assert.deepEqual(imports, ["historical"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party watcher event mapping keeps imports scoped to contained regular files", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-event-scope-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "collector-manager-outside-"));
  try {
    const mapped = join(dir, "mapped.jsonl");
    const outside = join(outsideDir, "outside.jsonl");
    const linked = join(dir, "linked.jsonl");
    const linkedParent = join(dir, "linked-parent");
    const linkedParentTranscript = join(linkedParent, "outside.jsonl");
    writeFileSync(mapped, "{}\n");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, linked);
    symlinkSync(outsideDir, linkedParent);

    const collector = fakeCollector("codex", [], []);
    collector.sourcePathsForWatchEvent = () => [
      mapped,
      outside,
      linked,
      linkedParentTranscript,
    ];

    assert.deepEqual(
      sourcePathsForWatcherEvents(collector, [
        { root: dir, filename: "changed.jsonl" },
      ]),
      [mapped]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("first-party OpenCode collector does not persist changed fingerprint after stale parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-fingerprint-drift-"));
  const previousOpenCodeDir = process.env.OPENCODE_DATA_DIR;
  try {
    process.env.OPENCODE_DATA_DIR = dir;
    const dbPath = join(dir, "opencode.db");
    const fingerprintPath = join(dir, "state", "opencode-fingerprint");
    writeFileSync(dbPath, "original");
    const collector = createOpencodeCollector({ fingerprintPath });
    assert.deepEqual(collector.listSources(), [dbPath]);
    const staleSnapshot = {
      fingerprint: collector.sourceFingerprint?.(dbPath) ?? null,
    };

    appendFileSync(dbPath, "changed");
    collector.markSourceImported?.(dbPath, staleSnapshot);

    assert.deepEqual(collector.listSources(), [dbPath]);
    collector.markSourceImported?.(dbPath, {
      fingerprint: collector.sourceFingerprint?.(dbPath) ?? null,
    });
    assert.deepEqual(collector.listSources(), []);
  } finally {
    if (previousOpenCodeDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCODE_DATA_DIR");
    } else {
      process.env.OPENCODE_DATA_DIR = previousOpenCodeDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party watcher event mapping rejects traversal-shaped default paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-traversal-"));
  const outsideDir = mkdtempSync(
    join(tmpdir(), "collector-manager-traversal-outside-")
  );
  try {
    const outside = join(outsideDir, "outside.jsonl");
    writeFileSync(outside, "{}\n");

    assert.deepEqual(
      sourcePathsForWatcherEvents(fakeCollector("codex", [], []), [
        { root: dir, filename: "../outside.jsonl" },
      ]),
      []
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
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

function fakeCollector(
  key: HarnessCollector["key"],
  sources: string[],
  sessions: NormalizedSession[],
  batch = false
): HarnessCollector {
  return {
    key,
    cacheName: key,
    batch,
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => sources,
    parse: async () => sessions,
  };
}

function makeSession(
  sessionId: string,
  cwd = "/sandbox/project"
): NormalizedSession {
  return {
    sessionId,
    name: sessionId,
    cwd,
    model: "gpt-5",
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    plans: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "codex",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
    },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    artifacts: {
      prs: [],
      issues: [],
      repo: null,
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2000) {
      throw new Error("timed out waiting for collector import");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeFsWatcher(): FSWatcher {
  const watcher = {
    on: () => watcher,
    close: () => {},
  };
  return watcher as unknown as FSWatcher;
}

async function noopCooperativeDelay(): Promise<void> {}
