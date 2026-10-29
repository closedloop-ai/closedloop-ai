/**
 * @file collector-manager-pass-resources.ts
 * @description The two per-pass resources `CollectorManager` resolves out of its
 * injected options before an import pass can run: the bounded parse invoker for
 * a harness's historical sources, and the one-per-pass snapshot of the session
 * ids the sink currently holds. Both share the same shape — read an OPTIONAL
 * dependency, and degrade to the pre-existing behaviour when it is absent or
 * fails, rather than failing the pass — so they live together here.
 *
 * Extracted from `collector-manager.ts` (ISS-5161) so that file keeps
 * travelling DOWN rather than growing with each change; the manager still
 * owns the pass itself and simply calls these with its own collector/options.
 */
import type { ImportIngestFailure } from "@closedloop-ai/telemetry-contract/app";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import {
  CollectorParseScope,
  type HarnessCollector,
  narrowHarness,
} from "../types.js";
import type { BoundedParseInvoker } from "./bounded-parse.js";
import type { CatchupCache } from "./catchup-cache.js";
import { createUnreadableParseReporter } from "./collector-ingest-failure.js";
import type { HistoricalParseRunner } from "./historical-parse-runner.js";
import type { HistoricalParseResult } from "./historical-parse-source.js";

export type ExistingSessionIdsInput = {
  collector: HarnessCollector;
  cache: CatchupCache | undefined;
  lowDutyImport: boolean;
  listExistingSessionIds: (() => Promise<ReadonlySet<string>>) | undefined;
  log: (message: string) => void;
};

/**
 * Resolve how one harness's historical sources are parsed. With a runner, the
 * parse is dispatched to the shared worker; without one (tests, golden mode)
 * it runs in-process.
 *
 * ISS-4572: `onDispatch` is threaded through to the runner, which fires it only
 * when this source is actually dispatched (past the shared dispatch tail), so a
 * source waiting behind a poison parse does not charge that queue wait to its
 * own deadline. The in-process fallback has no dispatch tail — the parse begins
 * the instant it is invoked — so it fires `onDispatch` immediately, matching the
 * runner path's contract.
 *
 * ISS-7625: the live-watcher default invoker resolves through here too, with no
 * runner (so it still parses in-process), purely so the unreadable-parse drain
 * cannot be present on the historical path and absent on the live one.
 */
export function parseHistoricalSource(
  collector: HarnessCollector,
  runner: HistoricalParseRunner | undefined,
  // ISS-7625: the two primitives the unreadable-parse report needs, rather than
  // a prebuilt sink, so the manager keeps no reporter of its own.
  onIngestFailure?: (reason: ImportIngestFailure) => void,
  isImportActive: () => boolean = () => true
): BoundedParseInvoker {
  const onUnreadableParse = createUnreadableParseReporter(
    onIngestFailure,
    isImportActive
  );
  if (!runner) {
    return async (source, onDispatch) => {
      onDispatch();
      const sessions = await collector.parse(source);
      // ISS-7625: drained straight off the collector, because in-process THIS
      // instance is the one that parsed. The runner branch below has to take the
      // same value off the wire instead — that asymmetry is the whole reason the
      // worker needed a field rather than a shared sink.
      reportUnreadableParse(
        collector.takeUnreadableParseQuality?.(),
        onUnreadableParse
      );
      return sessions;
    };
  }
  return async (source, onDispatch, parsePolicy) => {
    // ISS-7696: the continuation comes from the collector that owns the
    // fingerprint, and only ever holds one a COMPLETED pass earned — see
    // `BatchHarnessCollector.resumeAfterForSource`. Reading it here, on the seam
    // that already replays the side-report, is what keeps "how far the worker
    // got" and "how far the import got" a single answer.
    const resumeAfter =
      narrowHarness(collector).batchCollector?.resumeAfterForSource?.(source);
    const result = await runner.parseSource(
      collector.key,
      source,
      onDispatch,
      resumeAfter,
      parsePolicy
    );
    // ISS-5266 (whitlockk review): replay the out-of-process parse's SIDE-REPORT on
    // the main-process collector before handing the sessions back.
    //
    // This `await` is the whole ordering guarantee, and it is structural rather
    // than a re-implemented check. The manager awaits this invoker and only then
    // calls `markSourceImported`, so the report is recorded — through the same
    // sink, on the same instance, arming the same failure latch — BEFORE the
    // fingerprint can be sealed. A failed record therefore refuses the seal here
    // exactly as it does on the in-process path, instead of the worker's
    // throwaway instance latching a failure nobody ever reads while the real
    // instance seals the store over a record that never landed.
    await applyParseSideReport(
      collector,
      result,
      CollectorParseScope.Import,
      source
    );
    reportUnreadableParse(result.unreadableParseQuality, onUnreadableParse);
    return result.sessions;
  };
}

/**
 * Hand one no-timestamp parse's quality to the pass's sink, when there was one.
 *
 * Extracted so the in-process and worker branches cannot drift: they read the
 * value from different places by necessity, and this is the single point that
 * decides what counts as "there was something to report".
 */
function reportUnreadableParse(
  quality: NormalizedParseQuality | undefined,
  onUnreadableParse: ((quality: NormalizedParseQuality) => void) | undefined
): void {
  if (quality) {
    onUnreadableParse?.(quality);
  }
}

/**
 * Hand a parse side-report to the collector that owns the source, when there is
 * one to hand over and the collector can take it.
 *
 * Deliberately silent about a collector that implements no hook: only OpenCode
 * currently produces a report, and a runner/worker pairing that sends one to a
 * collector which cannot apply it is a version-skew case that must degrade to
 * the pre-ISS-5266 behaviour (the report is simply not recorded), never throw.
 */
export async function applyParseSideReport(
  collector: HarnessCollector,
  result: HistoricalParseResult,
  // ISS-7696: which caller this report speaks for. Defaulted so every existing
  // call site keeps the import reading; only the DATA_REVISION rebuild, which
  // never seals, passes anything else.
  scope: CollectorParseScope = CollectorParseScope.Import,
  // ISS-8561: the source this report describes. Every PRODUCTION caller passes
  // it — a batch collector may own several stores, and the seal gate is a
  // per-store answer. Optional only so a caller predating the multi-store
  // collector still compiles; a collector that owns one store infers it, and
  // one that owns several refuses every seal rather than guess.
  sourcePath?: string
): Promise<void> {
  // ISS-5854: called for EVERY parse, not only one that reported something. The
  // truncation latch below describes the LAST load, so a clean load has to be
  // able to clear it — an early return on "nothing to report" would leave a
  // once-truncated source refusing its seal forever.
  const { batchCollector } = narrowHarness(collector);
  await batchCollector?.applyParseSideReport?.({
    ...(result.withheldOpencodeSubagents
      ? { withheldOpencodeSubagents: result.withheldOpencodeSubagents }
      : {}),
    // ISS-5854: a budget-truncated load must reach the instance that owns the
    // fingerprint, for exactly the reason the withheld report does — this is the
    // same seal gate, not a second one.
    ...(result.droppedSessions
      ? { droppedSessions: result.droppedSessions }
      : {}),
    // ISS-7696: parked as PENDING by the collector; it becomes the next
    // request's continuation only if this pass reaches the seal gate.
    ...(result.resumeAfter ? { resumeAfter: result.resumeAfter } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    scope,
  });
}

/**
 * Load the DB's current session ids ONCE per import pass. Two consumers, both
 * guarding the same class of bug — durable state that survived a SINK rebuild
 * (a DB reset/migration) and now describes rows that no longer exist:
 *
 * - Non-batch collectors: self-heal cache/DB divergence, a cache-"unchanged"
 *   source whose row was dropped. Needs a persistent catchup cache AND a path
 *   → session id (`sessionIdForSource`).
 * - ISS-5161 (whitlockk review), BATCH collectors on the low-duty pass: verify
 *   that a session the resume cursor wants to fast-forward past is still IN
 *   the sink. The store fingerprint proves only that the SOURCE has not moved;
 *   `agent-dashboard.sqlite` is a sibling path that can be rebuilt underneath
 *   a surviving cursor file.
 *
 * Everything else skips the query so the normal path pays nothing. A
 * failed/absent loader degrades to the prior behavior (trust the cache/cursor)
 * — never re-parse everything just because the lookup broke.
 */
export async function loadExistingSessionIds(
  input: ExistingSessionIdsInput
): Promise<ReadonlySet<string> | undefined> {
  const { collector, cache, lowDutyImport, listExistingSessionIds, log } =
    input;
  const forOrphanSelfHeal =
    !collector.batch && cache !== undefined && !!collector.sessionIdForSource;
  const forBatchResumeVerification = collector.batch && lowDutyImport;
  if (
    !(
      (forOrphanSelfHeal || forBatchResumeVerification) &&
      listExistingSessionIds
    )
  ) {
    return undefined;
  }
  try {
    return await listExistingSessionIds();
  } catch (error) {
    log(
      `collector ${collector.key} existing-session lookup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
