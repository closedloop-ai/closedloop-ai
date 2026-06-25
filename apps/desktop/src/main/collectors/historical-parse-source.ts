import { createClaudeCollector } from "./claude/claude-collector.js";
import { createCodexCollector } from "./codex/codex-collector.js";
import { createCopilotCollector } from "./copilot/copilot-collector.js";
import { createCursorCollector } from "./cursor/cursor-collector.js";
import { createOpencodeCollector } from "./opencode/opencode-collector.js";
import { isImportableCollectorSource } from "./source-admission.js";
import {
  Harness,
  type HarnessCollector,
  type NormalizedSession,
} from "./types.js";

/** Parse a single collector source without touching main-process import state. */
export function parseHistoricalSource(
  collectorKey: Harness,
  source: string
): Promise<NormalizedSession[]> {
  const collector = createWorkerCollector(collectorKey);
  if (!isImportableCollectorSource(collector, source)) {
    return Promise.reject(
      new Error(`Historical source is outside collector roots: ${source}`)
    );
  }
  return collector.parse(source);
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
