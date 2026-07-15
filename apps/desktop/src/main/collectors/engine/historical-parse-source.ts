import { createClaudeCollector } from "../claude/claude-collector.js";
import { createCodexCollector } from "../codex/codex-collector.js";
import { createCopilotCollector } from "../copilot/copilot-collector.js";
import { createCursorCollector } from "../cursor/cursor-collector.js";
import { createOpencodeCollector } from "../opencode/opencode-collector.js";
import {
  Harness,
  type HarnessCollector,
  type NormalizedSession,
} from "../types.js";
import { isImportableCollectorSource } from "./source-admission.js";

/** Parse a single collector source without touching main-process import state. */
export function parseHistoricalSource(
  collectorKey: Harness,
  source: string
): Promise<NormalizedSession[]> {
  const collector = getWorkerCollector(collectorKey);
  if (!isImportableCollectorSource(collector, source)) {
    return Promise.reject(
      new Error(`Historical source is outside collector roots: ${source}`)
    );
  }
  return collector.parse(source);
}

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
      return createOpencodeCollector();
    default:
      return assertNeverHarness(collectorKey);
  }
}

function assertNeverHarness(value: never): never {
  throw new Error(`Unsupported historical collector: ${value}`);
}
