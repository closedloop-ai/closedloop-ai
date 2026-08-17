/**
 * @file default-collectors.ts
 * @description The five real harness collectors and their durable state paths,
 * extracted out of `collector-manager.ts` (ISS-4649 / wongk review). That file
 * is over the 1,000-line ceiling and shrink-only per the grandfather list in
 * `biome.jsonc`, so the roster — which grows every time a collector gains a
 * constructor seam — lives here instead of adding to it.
 *
 * Registering a NEW harness collector means editing this file; see
 * `apps/desktop/docs/harness-telemetry-matrix.md`, which points at this roster.
 */
import { createClaudeCollector } from "../claude/claude-collector.js";
import { createCodexCollector } from "../codex/codex-collector.js";
import { createCopilotCollector } from "../copilot/copilot-collector.js";
import { createCursorCollector } from "../cursor/cursor-collector.js";
import { createOpencodeCollector } from "../opencode/opencode-collector.js";
import type { OpencodeWithheldSubagentReport } from "../opencode/opencode-withheld-subagents.js";
import type { HarnessCollector } from "../types.js";
import {
  ingestCodexLinkageCachePath,
  ingestOpencodeFingerprintPath,
} from "./ingest-paths.js";

/**
 * The five real harness collectors, wired with their durable state paths.
 *
 * `log` is the CollectorManager's own diagnostic sink — the one that emits
 * `collector <key> import failed: …`. It is threaded to the collectors that must
 * report a refusal themselves, because `importSources` catches a per-source
 * parse rejection and continues WITHOUT logging (a partially-written transcript
 * mid-turn is normal there), so a rejection alone never reaches an operator.
 *
 * ISS-5266: takes the manager's own options object rather than a widening
 * argument list, so threading a new sink through to a collector adds nothing to
 * the grandfathered `collector-manager.ts` call site.
 */
export function defaultCollectors(
  options: DefaultCollectorsOptions,
  log: (message: string) => void
): HarnessCollector[] {
  const {
    stateDir,
    onOpencodeSubagentsWithheld: recordWithheld,
    hasRecordedOpencodeWithheldScan: hasRecordedWithheldScan,
  } = options;
  return [
    // ISS-6048: the parser's schema-drift report is the only signal that the
    // harness started emitting something this parser does not decode, and it is
    // silent unless a logger reaches it.
    createClaudeCollector({ log }),
    createCodexCollector({
      linkageCachePath: ingestCodexLinkageCachePath(stateDir),
    }),
    createCursorCollector(),
    createCopilotCollector(),
    createOpencodeCollector({
      fingerprintPath: ingestOpencodeFingerprintPath(stateDir),
      // ISS-4649 (wongk review): the OpenCode collector refuses an import tick
      // when the DB's parent linkage cannot be read, and must say so on the
      // monitored channel itself.
      log,
      // ISS-5266: and it withholds a dropped root's subagents, which must reach
      // a durable record rather than only the monitored channel.
      ...(recordWithheld ? { recordWithheld } : {}),
      // ISS-5266: and an install upgrading from a release that never wrote a
      // verdict must re-read its store once, or its table stays empty forever.
      ...(hasRecordedWithheldScan ? { hasRecordedWithheldScan } : {}),
    }),
  ];
}

/**
 * The slice of `CollectorManagerOptions` this roster reads. Declared structurally
 * rather than importing the manager's own options type, so the roster keeps no
 * edge back to the engine module it was extracted from.
 */
export type DefaultCollectorsOptions = {
  /** Durable dir for persisted per-collector state (caches, fingerprints). */
  stateDir: string;
  /**
   * ISS-5266: durable sink for the OpenCode WITHHELD-subagent record. Optional
   * so every existing caller (and every test that builds the real roster) is
   * unaffected; omitted = the collector's own no-op and the withhold stays a log
   * line, exactly as before this ticket.
   */
  onOpencodeSubagentsWithheld?: (
    report: OpencodeWithheldSubagentReport
  ) => void | Promise<void>;
  /**
   * ISS-5266: has this OpenCode store already recorded a withheld-scan verdict?
   * Optional for the same reason as the sink above — omitted keeps the exact
   * pre-ticket behaviour (assume scanned, never force a rescan).
   */
  hasRecordedOpencodeWithheldScan?: (dbPath: string) => boolean;
};
