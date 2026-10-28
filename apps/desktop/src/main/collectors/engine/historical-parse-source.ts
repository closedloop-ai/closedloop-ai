import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import {
  effectiveParsePolicy,
  setEffectiveParsePolicy,
} from "../../parse-policy/effective-parse-policy.js";
import {
  type ParsePolicy,
  readParsePolicy,
  sameParsePolicy,
} from "../../parse-policy/parse-policy.js";
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
import {
  createHistoricalParseWorkerFailedResponse,
  createHistoricalParseWorkerParsedResponse,
  type HistoricalParseWorkerRequest,
  type HistoricalParseWorkerResponse,
  type HistoricalParseWorkerResumePoint,
  resolveHistoricalParseResumeOffset,
} from "./historical-parse-worker-protocol.js";
import { isImportableCollectorSource } from "./source-admission.js";

/**
 * What one out-of-process parse produced: the sessions, plus any SIDE-REPORT the
 * collector emitted while parsing.
 *
 * ISS-5266 (whitlockk review): a collector side effect that reaches durable storage
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
  /**
   * ISS-5854: how many parsed sessions the worker's response budget dropped.
   *
   * This must travel as DATA for the same reason the withheld report above does.
   * The import path's only completeness signal is "every session in the list
   * imported", and a dropped session was never in the list — so without this the
   * manager seals the source (`markSeen` / `markSourceImported`), the catchup
   * fingerprint advances over unchanged bytes, and the dropped tail is never
   * re-read. `opencode-parse-failure.ts` records that exact bug being fixed once
   * already: "the parse resolved with a SHORT list, `markSourceImported`
   * advanced the DB fingerprint, and the missing session froze out".
   *
   * ISS-7696: a positive count now means DEFERRED, not lost — the runner holds
   * the continuation the response came with and the next pass asks for the
   * suffix. What the import path does with it is unchanged and must stay so:
   * refuse the seal, because this load is still not the whole store.
   *
   * Optional and additive: absent whenever nothing was dropped, and never `null`.
   */
  droppedSessions?: number;
  /**
   * ISS-7625: the parse quality of a source that produced NO session because it
   * carried no usable timestamp.
   *
   * Travels as DATA for the same reason as the two fields above: the counts are
   * computed inside the parser running in THIS process, and the main process —
   * which owns the ingest-failure sink — sees only the session list. An
   * all-malformed transcript therefore returned an empty list indistinguishable
   * from a healthy empty one, and the source was sealed with no signal emitted.
   *
   * Optional and additive: absent for every clean parse and every source that
   * yielded a session, and never emitted as `null`.
   */
  unreadableParseQuality?: NormalizedParseQuality;
  /**
   * ISS-7696: where the worker says the next pass should pick up, present only
   * alongside a positive {@link droppedSessions}.
   *
   * It travels as DATA for the same reason the two fields above do, and it is a
   * PROPOSAL rather than a fact: the collector parks it until the pass reaches
   * `markSourceImported`, because this result is handed over before a single one
   * of its sessions has been imported.
   */
  resumeAfter?: HistoricalParseWorkerResumePoint;
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
  // ISS-7625: drained immediately after the awaited parse, before any other
  // parse can run — worker dispatch is serialized to one request per turn.
  const unreadableParseQuality = collector.takeUnreadableParseQuality?.();
  return {
    sessions,
    // Omit rather than serialize `null`/`undefined` — the wire field is optional
    // and old main-process builds must see an absent key, not an empty one.
    ...(withheldOpencodeSubagents ? { withheldOpencodeSubagents } : {}),
    ...(unreadableParseQuality ? { unreadableParseQuality } : {}),
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

/**
 * ISS-12552 (PRD-800 "Rollout"): this worker parses under the policy each
 * request carries. Dispatch is serialized, so the process-local policy is the
 * request's for the whole parse. The cached collectors were built and warmed
 * under the previous policy, so a change drops them.
 */
function applyRequestParsePolicy(policy: ParsePolicy): void {
  if (sameParsePolicy(effectiveParsePolicy(), policy)) {
    return;
  }
  setEffectiveParsePolicy(policy);
  workerCollectorByHarness.clear();
}

function assertNeverHarness(value: never): never {
  throw new Error(`Unsupported historical collector: ${value}`);
}

/**
 * ISS-7696: turn one validated worker request into its response.
 *
 * Lifted out of `historical-parse-worker.ts`, which now owns only the
 * `parentPort` plumbing. The lift is what makes the continuation testable
 * end-to-end: the worker entrypoint installs a `process.parentPort` listener at
 * import time and cannot be loaded by a test, so before this the three lines
 * that decide WHICH sessions a request gets back were the one part of the round
 * trip no suite could execute.
 *
 * The resume offset is resolved HERE, against the sessions this parse actually
 * produced, rather than trusted from the request — see
 * {@link resolveHistoricalParseResumeOffset}.
 */
export async function handleHistoricalParseRequest(
  request: HistoricalParseWorkerRequest
): Promise<HistoricalParseWorkerResponse> {
  try {
    applyRequestParsePolicy(readParsePolicy(request.parsePolicy));
    const parsed = await parseHistoricalSource(
      request.collectorKey,
      request.source
    );
    // ISS-5266: the side-report rides the SAME response as the sessions it was
    // derived from, so it cannot arrive without them or be lost while they land.
    return createHistoricalParseWorkerParsedResponse(
      request.requestId,
      parsed.sessions,
      parsed.withheldOpencodeSubagents,
      resolveHistoricalParseResumeOffset(parsed.sessions, request.resumeAfter),
      // ISS-7625: an all-malformed source parses to zero sessions in the WORKER,
      // so this is the only way its quality reaches the main process at all.
      parsed.unreadableParseQuality
    );
  } catch (error) {
    return createHistoricalParseWorkerFailedResponse(
      request.requestId,
      error instanceof Error ? error.message : String(error)
    );
  }
}
