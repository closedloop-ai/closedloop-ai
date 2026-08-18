/**
 * @file collector-manager-pass-resources.ts
 * @description The two per-pass resources `CollectorManager` resolves out of its
 * injected options before an import pass can run: the bounded parse invoker for
 * a harness's historical sources, and the one-per-pass snapshot of the session
 * ids the sink currently holds. Both share the same shape — read an OPTIONAL
 * dependency, and degrade to the pre-existing behaviour when it is absent or
 * fails, rather than failing the pass — so they live together here.
 *
 * Extracted from `collector-manager.ts` (ISS-5161) so that grandfathered file
 * keeps travelling DOWN rather than growing with each change; the manager still
 * owns the pass itself and simply calls these with its own collector/options.
 */
import { type HarnessCollector, narrowHarness } from "../types.js";
import type { BoundedParseInvoker } from "./bounded-parse.js";
import type { CatchupCache } from "./catchup-cache.js";
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
 */
export function parseHistoricalSource(
  collector: HarnessCollector,
  runner: HistoricalParseRunner | undefined
): BoundedParseInvoker {
  if (!runner) {
    return (source, onDispatch) => {
      onDispatch();
      return collector.parse(source);
    };
  }
  return async (source, onDispatch) => {
    const result = await runner.parseSource(collector.key, source, onDispatch);
    // ISS-5266 (wongk review): replay the out-of-process parse's SIDE-REPORT on
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
    await applyParseSideReport(collector, result);
    return result.sessions;
  };
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
  result: HistoricalParseResult
): Promise<void> {
  if (!result.withheldOpencodeSubagents) {
    return;
  }
  const { batchCollector } = narrowHarness(collector);
  await batchCollector?.applyParseSideReport?.({
    withheldOpencodeSubagents: result.withheldOpencodeSubagents,
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
 * - ISS-5161 (wongk review), BATCH collectors on the low-duty pass: verify
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
