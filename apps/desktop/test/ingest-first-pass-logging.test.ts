/**
 * First-pass backfill console-observability, driven through CollectorManager.
 *
 * Split out of ingest-orchestrator.test.ts (grandfathered shrink-only under the
 * root AGENTS.md line-count contract) as part of ISS-4917, which changed what
 * these lines promise: the begin and complete lines are now emitted for EVERY
 * first pass, and only the slow-first-launch hint and the periodic per-source
 * line remain gated on size/time. The unit-level rules for that (and the stall
 * watch) live in ingest-progress-tracker.test.ts; this file pins the same
 * contract through the real manager and its import loop.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import {
  makeSession,
  noopCooperativeDelay,
} from "./helpers/collector-manager-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
});

// First-pass backfill console lines (hoisted to satisfy Biome useTopLevelRegex).
const BACKFILL_ANNOUNCE_RE =
  /session backfill \[codex\]: importing 60 source file\(s\)/;
const BACKFILL_COMPLETE_RE =
  /session backfill \[codex\] first pass complete: 60 source file\(s\) in \d+s/;
const BACKFILL_LINE_RE = /session backfill/;
// ISS-4917: the sub-threshold first pass logs its lifecycle without the hint.
const SMALL_BACKFILL_ANNOUNCE_RE =
  /session backfill \[codex\]: importing 3 source file\(s\)/;
const SMALL_BACKFILL_COMPLETE_RE =
  /session backfill \[codex\] first pass complete: 3 source file\(s\) in \d+s/;
const SLOW_FIRST_LAUNCH_HINT = "first launch can take a while";

test("first-party CollectorManager logs first-pass backfill announce + completion for a large source backlog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-backfill-log-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    // Above INGEST_LOG_MIN_SOURCES (50) so the first pass announces + completes.
    const sourceCount = 60;
    const sources: string[] = [];
    for (let i = 0; i < sourceCount; i++) {
      const source = join(dir, `codex-${i}.jsonl`);
      writeFileSync(source, "{}\n");
      sources.push(source);
    }
    const logs: string[] = [];
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
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
      log: (message) => logs.push(message),
      onBootImportComplete: () => resolveBootComplete?.(),
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

    manager.start();
    await new Promise((resolve) => setImmediate(resolve));
    nodeTestTimers.tick(25);
    await bootComplete;
    manager.stop();

    assert.ok(
      logs.some((m) => BACKFILL_ANNOUNCE_RE.test(m)),
      `expected a backfill announce line; got: ${logs.join(" | ")}`
    );
    assert.ok(
      logs.some((m) => BACKFILL_COMPLETE_RE.test(m)),
      `expected a backfill completion line; got: ${logs.join(" | ")}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party CollectorManager still logs the lifecycle of a small first-pass backlog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-backfill-small-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    // ISS-4917: below INGEST_LOG_MIN_SOURCES (50) this pass used to emit NOTHING
    // — no start, no progress, no completion — which is exactly the steady-state
    // size for an already-imported machine, so a stall in this range was
    // invisible in main.log. The lifecycle lines are now unconditional; only the
    // periodic per-source line and the slow-launch hint remain size/time-gated.
    const sources: string[] = [];
    for (let i = 0; i < 3; i++) {
      const source = join(dir, `codex-${i}.jsonl`);
      writeFileSync(source, "{}\n");
      sources.push(source);
    }
    const logs: string[] = [];
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
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
      log: (message) => logs.push(message),
      onBootImportComplete: () => resolveBootComplete?.(),
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

    manager.start();
    await new Promise((resolve) => setImmediate(resolve));
    nodeTestTimers.tick(25);
    await bootComplete;
    manager.stop();

    const backfillLines = logs.filter((m) => BACKFILL_LINE_RE.test(m));
    assert.ok(
      backfillLines.some((m) => SMALL_BACKFILL_ANNOUNCE_RE.test(m)),
      `expected a begin line for a 3-source first pass; got: ${logs.join(" | ")}`
    );
    assert.ok(
      backfillLines.some((m) => SMALL_BACKFILL_COMPLETE_RE.test(m)),
      `expected a completion line for a 3-source first pass; got: ${logs.join(" | ")}`
    );
    assert.ok(
      !backfillLines.some((m) => m.includes(SLOW_FIRST_LAUNCH_HINT)),
      `a small backlog must not claim a slow first launch; got: ${backfillLines.join(" | ")}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-pass progress counts a source only once it reaches a terminal outcome", {
  timeout: 15_000,
}, async () => {
  // wongk review (ISS-4917): the counter used to be bumped at the TOP of each
  // loop iteration, so a wedge on the first parse reported 1/N with nothing
  // actually imported, and the last source read N/N before the pass could
  // finish. Both the banner and the no-progress window read off this number.
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-terminal-count-"));
  try {
    const sources = [join(dir, "codex-a.jsonl"), join(dir, "codex-b.jsonl")];
    for (const source of sources) {
      writeFileSync(source, "{}\n");
    }
    let releaseFirstParse: (() => void) | undefined;
    let signalFirstParseStarted: (() => void) | undefined;
    const firstParseStarted = new Promise<void>((resolve) => {
      signalFirstParseStarted = resolve;
    });
    const firstParseGate = new Promise<void>((resolve) => {
      releaseFirstParse = resolve;
    });
    let resolveBootComplete: (() => void) | undefined;
    const bootComplete = new Promise<void>((resolve) => {
      resolveBootComplete = resolve;
    });
    let parseCount = 0;

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: join(dir, "state"),
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: noopCooperativeDelay,
      log: () => {},
      onBootImportComplete: () => resolveBootComplete?.(),
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => sources,
          parse: async (source: string) => {
            parseCount += 1;
            if (parseCount === 1) {
              signalFirstParseStarted?.();
              await firstParseGate;
            }
            return [makeSession(`session-${source}`)];
          },
        },
      ],
    });

    manager.start();
    await firstParseStarted;

    const midFirstSource = manager.getIngestProgress();
    assert.equal(
      midFirstSource.total,
      sources.length,
      `the pass announced its population: ${JSON.stringify(midFirstSource)}`
    );
    assert.equal(
      midFirstSource.processed,
      0,
      `a source still being parsed is not counted as processed: ${JSON.stringify(midFirstSource)}`
    );

    releaseFirstParse?.();
    await bootComplete;
    assert.equal(
      manager.getIngestProgress().processed,
      sources.length,
      "every source is counted once the pass settles"
    );
    manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
