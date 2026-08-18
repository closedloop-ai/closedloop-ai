import { createClaudeCollector } from "../claude/claude-collector.js";
import { createCodexCollector } from "../codex/codex-collector.js";
import { createCopilotCollector } from "../copilot/copilot-collector.js";
import { createCursorCollector } from "../cursor/cursor-collector.js";
import { createOpencodeCollector } from "../opencode/opencode-collector.js";
import type { OpencodeWithheldSubagentReport } from "../opencode/opencode-withheld-subagents.js";
import {
  Harness,
  type HarnessCollector,
  type NormalizedSession,
} from "../types.js";
import { isE2ePoisonSource } from "./e2e-parse-quarantine-seam.js";
import { isImportableCollectorSource } from "./source-admission.js";

/**
 * What one out-of-process parse produced: the sessions, plus any SIDE-REPORT the
 * collector emitted while parsing.
 *
 * ISS-5266 (wongk review): a collector side effect that reaches durable storage
 * through an injected sink works in-process, but a historical/boot parse runs
 * HERE, in the utility process, on a different collector instance with no DB
 * handle. Anything the parse learns must therefore be returned as DATA and
 * carried back over the worker response, or it is silently discarded — which is
 * exactly what happened to the OpenCode withheld-subagent report.
 */
export type HistoricalParseResult = {
  sessions: NormalizedSession[];
  /**
   * Present only when this parse was an OpenCode batch load. Optional and
   * additive: absent for every other harness, and never emitted as `null`.
   */
  withheldOpencodeSubagents?: OpencodeWithheldSubagentReport;
};

/** Parse a single collector source without touching main-process import state. */
export async function parseHistoricalSource(
  collectorKey: Harness,
  source: string
): Promise<HistoricalParseResult> {
  // ISS-4573 (TEST-ONLY, E2E-launch-env-gated): a seeded poison transcript wedges
  // the parse — the promise never settles — reproducing the CPU-spin the ~90s parse
  // deadline (ISS-4444) guards against, so the launched-app E2E can trip quarantine
  // fast across the real utility-process boundary. `isE2ePoisonSource` is false in
  // every production run (the E2E launch env is unset), so this returns immediately
  // for a real source and never wedges one.
  if (isE2ePoisonSource(source)) {
    return NEVER_SETTLING_PARSE;
  }
  const collector = getWorkerCollector(collectorKey);
  if (!isImportableCollectorSource(collector, source)) {
    throw new Error(`Historical source is outside collector roots: ${source}`);
  }
  // Drain BEFORE the parse, not after: the slot is written by the collector's
  // injected sink during `parse`, so clearing it first means a report left over
  // from an earlier turn can never be mistaken for this source's. Worker
  // dispatch is serialized (one request per turn), so no other parse can write
  // the slot between this reset and the read below.
  capturedWithheldReport = undefined;
  const sessions = await collector.parse(source);
  const withheldOpencodeSubagents = capturedWithheldReport;
  capturedWithheldReport = undefined;
  return {
    sessions,
    // Omit rather than serialize `null`/`undefined` — the wire field is optional
    // and old main-process builds must see an absent key, not an empty one.
    ...(withheldOpencodeSubagents ? { withheldOpencodeSubagents } : {}),
  };
}

/**
 * ISS-4573: a promise that never settles, handed back for a seeded poison source so
 * the manager's bounded parse deadline dead-letters it. The worker turn is killed by
 * the runner's `abortInFlightParse`/timeout, so this dangling promise is abandoned
 * with the process — it holds no timer or resource of its own.
 */
const NEVER_SETTLING_PARSE: Promise<HistoricalParseResult> = new Promise(() => {
  // Intentionally never resolves or rejects (test-only, E2E-gated poison path).
});

/**
 * ISS-5266: the slot the OpenCode collector's injected `recordWithheld` sink
 * writes during `parse`, drained by {@link parseHistoricalSource}.
 *
 * A module-level slot rather than a per-parse collector, because the collector
 * instances are deliberately CACHED and reused across requests (see
 * {@link getWorkerCollector} — rebuilding the Codex one per parse made the
 * backfill O(sources^2)). The sink is therefore bound once, at construction,
 * and hands its report to whichever parse is currently in flight; worker
 * dispatch is serialized to one request per turn, so that is unambiguous.
 */
let capturedWithheldReport: OpencodeWithheldSubagentReport | undefined;

// One collector per harness, reused across every parse request this worker
// process handles. The Codex collector memoizes an expensive rollout-linkage
// graph on its instance (one bounded metadata read of every source file). A
// fresh collector per request rebuilt that whole-corpus graph on every parse,
// making the historical backfill O(sources^2) in file reads and pacing it at
// roughly one file per second. Reusing the instance keeps the graph warm across
// the pass; it still self-invalidates when the source set changes, since the
// graph cache is keyed on the per-source stats.
type WorkerCollectorFactory = (collectorKey: Harness) => HarnessCollector;

const workerCollectorByHarness = new Map<Harness, HarnessCollector>();
let workerCollectorFactory: WorkerCollectorFactory = createWorkerCollector;

export function getWorkerCollector(collectorKey: Harness): HarnessCollector {
  const cached = workerCollectorByHarness.get(collectorKey);
  if (cached) {
    return cached;
  }
  const collector = workerCollectorFactory(collectorKey);
  workerCollectorByHarness.set(collectorKey, collector);
  return collector;
}

/**
 * Test seam: drop the per-harness collector cache and optionally swap the
 * factory, so the reuse behavior can be asserted without the real Codex home.
 */
export function resetWorkerCollectorsForTesting(
  factory?: WorkerCollectorFactory
): void {
  workerCollectorByHarness.clear();
  workerCollectorFactory = factory ?? createWorkerCollector;
}

function createWorkerCollector(collectorKey: Harness): HarnessCollector {
  switch (collectorKey) {
    case Harness.Claude:
      return createClaudeCollector();
    case Harness.Codex:
      return createCodexCollector();
    case Harness.Cursor:
      return createCursorCollector();
    case Harness.Copilot:
      return createCopilotCollector();
    case Harness.OpenCode:
      // ISS-5266: the worker has no DB handle, so this sink does not PERSIST the
      // report — it captures it so `parseHistoricalSource` can return it and the
      // main process can record it through the very same store call the
      // in-process path uses. Without this the boot/historical import (i.e. the
      // normal path for every existing store) silently dropped every report.
      return createOpencodeCollector({
        recordWithheld: (report) => {
          capturedWithheldReport = report;
        },
      });
    default:
      return assertNeverHarness(collectorKey);
  }
}

function assertNeverHarness(value: never): never {
  throw new Error(`Unsupported historical collector: ${value}`);
}
