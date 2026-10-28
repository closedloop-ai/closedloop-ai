import { CollectorTailSamplingPolicy } from "@closedloop-ai/telemetry-contract/collector-tail-sampling-policy";
import { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { isRecoverableDbHostExitError } from "../../shared/db-host-exit-error.js";
import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import { isReadCancelledError } from "../../shared/read-cancellation-contract.js";
import { requestReadInitiator } from "../../shared/read-initiator-contract.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { SessionListQueryRefusedError } from "../session/session-list-query-compiler.js";
import {
  currentSessionListQueryObservation,
  recordSessionListQueryExecution,
  runWithSessionListQueryObservation,
} from "../session/session-list-query-observability.js";
import {
  DesktopIpcOperation,
  type DesktopIpcOperation as DesktopIpcOperationValue,
  type DesktopIpcPerfEventInput,
} from "../telemetry/app-otel-runtime-ipc.js";
import { recordIpcCall } from "../telemetry/dead-end-rate-record.js";

// Slow calls are always kept, the rest at the baseline percentage.
//
// The baseline rate stays SSOT'd to the collector policy (FEA-1997) — emitting
// ordinary IPC spans faster than the collector keeps traces buys nothing.
//
// The slow threshold is a desktop knob and no longer mirrors anything in the
// collector: ISS-9254 moved `keep-slow` from a `duration_ms` numeric_attribute
// to a whole-trace `latency` policy, so no collector policy reads a single IPC
// call's duration any more. 2000ms is the value FEA-1997 shipped, kept because
// what counts as a slow IPC call did not change.
//
// A 100% head-sample is NOT 100% arrival, and that gap widens with ISS-9254.
// This span rides the traces pipeline as a child of the activity-window root
// and `tail_sampling` decides per TRACE, so a slow call in a short window now
// trips no keep policy of its own and falls to the baseline; it survives only
// when a trace-mate errors or the window itself runs past the keep-slow
// threshold. ISS-9254 measured the `duration_ms` policy that used to give it a
// keep path at 57 of 33,551 spans and ruled it near-inert rather than keep it.
// `packages/telemetry-contract/src/sync-sampling-bias.ts` states the same
// correlation for the sync group; read a retained population of these events
// the same way.
const IPC_PERF_SLOW_THRESHOLD_MS = 2000;
const IPC_PERF_BASELINE_SAMPLING_PERCENTAGE =
  CollectorTailSamplingPolicy.baselineSamplingPercentage;

/**
 * Rows a handler returned. The four instrumented handlers return distinct
 * shapes: `list` → `{ items: [...] }` (page rows), `detail` → a single
 * `SharedAgentSessionDetail | null`, `usage` → a single aggregate summary,
 * `page_data` → `{ list: { items }, usage }`. So: a paginated `{ items }`
 * envelope counts its page (nested under `list` for `page_data`); a bare array
 * counts itself; a single non-null record counts as 1; null/undefined counts
 * as 0.
 */
function countResultRows(result: unknown): number {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (result === null || result === undefined) {
    return 0;
  }
  if (typeof result === "object") {
    // `pageData` → `{ list: { items } }`: its rows are the nested list page.
    const { items, list } = result as { items?: unknown; list?: unknown };
    if (Array.isArray(items)) {
      return items.length;
    }
    return list ? countResultRows(list) : 1;
  }
  return 0;
}

/** Derive `payload_bytes` + `result_count` from an IPC handler result. */
export function measureIpcResult(result: unknown): {
  payloadBytes: number;
  resultCount: number;
} {
  try {
    const serialized = JSON.stringify(result);
    // UTF-8 byte length (the attribute is `ipc.payload_bytes`), not UTF-16
    // code-unit count — multi-byte characters in cwd/branch fields would
    // otherwise under-report the serialized response size.
    const payloadBytes = serialized ? Buffer.byteLength(serialized, "utf8") : 0;
    return { payloadBytes, resultCount: countResultRows(result) };
  } catch {
    // A non-serializable result still yields a useful duration/session_count
    // wide event; report zero size/rows rather than dropping the span.
    return { payloadBytes: 0, resultCount: 0 };
  }
}

/** Bounded `error.type` for a thrown IPC handler error. */
export function ipcErrorTypeName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

/**
 * Total local-store session count, the perf-cliff dimension; never throws.
 * Counted via the clone-safe `agentDatabase.sessions.count()` method so the call
 * works across the FEA-2038 db-host process boundary: in db-host mode
 * `agentDatabase` is a forwarding proxy and this code runs in the MAIN process,
 * so issuing `agentDatabase.prisma.read(callback)` here cannot cross IPC; a
 * function can't be structured-cloned (DataCloneError, "An object could not be
 * cloned"). `sessions.count()` takes no callback and returns a plain number, so
 * it forwards cleanly and runs the raw `COUNT(*)` on the reader pool INSIDE the
 * db host, NOT the reader-pool Prisma model-delegate `count()` aggregate, which
 * returned 0 on every span in packaged builds (a libSQL adapter quirk on the
 * `query_only` reader connections; FEA-2211). The reader pool avoids contending
 * with first-launch backfill writes on the serialized writer connection, and it
 * is the same path the Sessions-list pagination total uses.
 *
 * The COUNT is best-effort: on failure it answers `null` and reports the error
 * via `onError` so the failure is observable (the original blanket swallow is
 * what hid this bug). `onError` is itself best-effort; a throwing callback is
 * swallowed so telemetry can never break the IPC handler (mirrors `safeEmit`).
 *
 * ISS-5262 established the null for one failure — the db-host going away during
 * an intentional shutdown — and said why: the COUNT never ran, so the truth is
 * "unknown", not "zero". ISS-8773 extends that to EVERY failure, because the
 * reasoning never depended on the cause. A `db-host exited (code: 1)` took the
 * other branch and emitted `session_count: 0` from a query that never reached
 * SQLite, which is a fabricated metric in exactly the sense the first half of
 * this docstring rejects. A caller that reads a real 0 and a caller that reads
 * a failed 0 cannot tell them apart, so the dimension was unusable in the one
 * situation it most needed to be trusted.
 *
 * `null` (an internal nullable is the sanctioned representation of unknown)
 * makes the caller skip the whole wide event rather than emit a
 * `session_count` it cannot stand behind. The shutdown case stays silent; every
 * other failure still reports through `onError`.
 */
export async function ipcSessionCount(
  agentDatabase: DbHostAgentDatabase,
  onError?: (error: unknown) => void
): Promise<number | null> {
  try {
    return await agentDatabase.sessions.count();
  } catch (error) {
    if (isDbHostShutdownError(error)) {
      return null;
    }
    try {
      onError?.(error);
    } catch {
      // best-effort: a throwing observability sink must not escape into the handler
    }
    return null;
  }
}

/**
 * Productionized `diagTime` (FEA-1997): wrap a hot `withDb` IPC handler so each
 * call can emit one sampled OTel perf wide event carrying duration, payload
 * bytes, result count, and total session count. A head-sampler — whose baseline
 * rate is SSOT'd to the collector tail-sampling policy — always emits slow and
 * errored calls and baseline-samples the rest; only sampled-in spans pay for
 * serialization and the session COUNT. Handler semantics are unchanged: the
 * result is returned and a thrown error is always re-thrown. Separately, and
 * unsampled, each settled user-initiated call writes one `dead_end.rate`
 * record (ISS-12039).
 *
 * ISS-5262 — two cases now emit NOTHING rather than an event that would not be
 * true: a handler error classified as an intentional db-host shutdown (the
 * operation was abandoned, not attempted-and-broken), and any call whose
 * `session_count` came back unknown. A wide event is either true or absent.
 *
 * `options.random` is injectable so the baseline sampler is deterministic in
 * tests; `options.onSessionCountError` surfaces a failed `session_count` COUNT.
 */
type InstrumentIpcPerfOptions = {
  /** Injectable RNG so the baseline sampler is deterministic in tests. */
  random?: () => number;
  /**
   * Observability for a failed `session_count` COUNT (FEA-2211). The count is
   * best-effort and answers `null`; this surfaces the failure (wired to the
   * desktop logger) so the dropped event never goes unnoticed. NOT called for
   * an ISS-5262 shutdown failure — that also returns `null` (unknown) but stays
   * silent, rather than reporting a fault the user caused by quitting.
   */
  onSessionCountError?: (error: unknown) => void;
};

export function instrumentIpcPerf<TArgs extends unknown[], TResult>(
  operation: DesktopIpcOperationValue,
  emit: ((input: DesktopIpcPerfEventInput) => void) | undefined,
  handler: (
    agentDatabase: DbHostAgentDatabase,
    ...args: TArgs
  ) => TResult | Promise<TResult>,
  options: InstrumentIpcPerfOptions = {}
): (agentDatabase: DbHostAgentDatabase, ...args: TArgs) => Promise<TResult> {
  const random = options.random ?? Math.random;
  return async (agentDatabase, ...args) => {
    if (!emit) {
      return await handler(agentDatabase, ...args);
    }
    // Telemetry must never alter handler semantics: a throwing emit sink can
    // neither swallow the success result nor mask the handler's own error.
    // (The wired `emitIpcPerfEvent` is already best-effort, but the contract is
    // enforced here so any caller's sink is safe.)
    const safeEmit = (input: DesktopIpcPerfEventInput): void => {
      try {
        emit(input);
      } catch {
        // best-effort
      }
    };
    const execute = async (): Promise<TResult> => {
      const startTimeUnixMs = Date.now();
      const startedAt = performance.now();
      try {
        const result = await handler(agentDatabase, ...args);
        const durationMs = Math.round(performance.now() - startedAt);
        recordUserInitiatedCall(operation, args);
        if (
          durationMs >= IPC_PERF_SLOW_THRESHOLD_MS ||
          random() * 100 < IPC_PERF_BASELINE_SAMPLING_PERCENTAGE
        ) {
          const { payloadBytes, resultCount } = measureIpcResult(result);
          const sessionCount = await ipcSessionCount(
            agentDatabase,
            options.onSessionCountError
          );
          // ISS-5262: `null` means the COUNT could not run because the db-host is
          // shutting down. Drop the event rather than emit a `session_count` of 0
          // that never was measured — a wide event is either true or absent.
          if (sessionCount !== null) {
            const observation = currentSessionListQueryDimensions();
            safeEmit({
              ...observation,
              operation,
              startTimeUnixMs,
              durationMs,
              payloadBytes,
              resultCount,
              sessionCount,
            });
          }
        }
        return result;
      } catch (error) {
        const refusal = recordRefusedQueryExecution(error);
        // Errored calls are always retained (mirrors the collector keep-error
        // policy) and carry no payload/result.
        const durationMs = Math.round(performance.now() - startedAt);
        // ISS-5262: a handler that failed only because shutdown began is not an
        // errored call worth an `error.type` span — the operation was abandoned,
        // not attempted-and-broken. Re-throw untouched so the wrapper above can
        // classify it; emitting nothing here is what keeps the shutdown log quiet.
        // ISS-8773: a RECOVERABLE db-host exit is the same category — the
        // ISS-5808 re-drive is about to run this handler again against the
        // replacement child, so this attempt is abandoned, not
        // attempted-and-broken. Emitting here would bill one logical call as a
        // failure plus a success, and the `usage` channel is now both
        // instrumented and re-driven.
        // ISS-12039: a read the renderer cancelled (ISS-9802) is abandoned too.
        // Nobody saw its answer, so it can neither render a dead end nor count
        // as a read in the rate's denominator.
        if (isAbandonedIpcAttempt(error)) {
          throw error;
        }
        recordUserInitiatedCall(operation, args);
        const sessionCount = await ipcSessionCount(
          agentDatabase,
          options.onSessionCountError
        );
        // ISS-8773: emitted even when the COUNT came back unknown. `errorType` is
        // the dimension a failed call exists to record, and it is most likely to
        // be lost exactly when it matters — a distressed db-host fails the handler
        // and the follow-up COUNT together. The count is omitted, never faked.
        const observation = currentSessionListQueryDimensions();
        safeEmit(
          failedIpcPerfEvent({
            durationMs,
            error,
            observation,
            operation,
            refusal,
            sessionCount,
            startTimeUnixMs,
          })
        );
        throw error;
      }
    };
    if (operation === DesktopIpcOperation.Detail) {
      return await execute();
    }
    return await runWithSessionListQueryObservation(args.at(0), execute);
  };
}

/**
 * ISS-12039 (Perrin Upcott ruling, 2026-10-05): only a user-initiated read
 * enters the dead-end rate denominator. The initiator rides the request object
 * (`list`/`usage`/`page_data`) or `detail`'s options argument; a read with
 * none — an older renderer, or an unknown value — writes no record.
 */
function recordUserInitiatedCall(
  operation: DesktopIpcOperationValue,
  args: readonly unknown[]
): void {
  if (args.some((arg) => requestReadInitiator(arg) === ReadInitiator.User)) {
    recordIpcCall(operation);
  }
}

function recordRefusedQueryExecution(
  error: unknown
): SessionListQueryRefusedError["refused"]["code"] | undefined {
  if (error instanceof SessionListQueryRefusedError) {
    recordSessionListQueryExecution(ListQueryExecution.Refused);
    return error.refused.code;
  }
  return undefined;
}

function currentSessionListQueryDimensions(): Pick<
  DesktopIpcPerfEventInput,
  "execution" | "matchedCount" | "scannedCount" | "source"
> {
  const { execution, matchedCount, scannedCount, source } =
    currentSessionListQueryObservation();
  return {
    ...(source === undefined ? {} : { source }),
    ...(execution === undefined ? {} : { execution }),
    ...(matchedCount === undefined ? {} : { matchedCount }),
    ...(scannedCount === undefined ? {} : { scannedCount }),
  };
}

function failedIpcPerfEvent(input: {
  durationMs: number;
  error: unknown;
  observation: ReturnType<typeof currentSessionListQueryDimensions>;
  operation: DesktopIpcOperationValue;
  refusal?: DesktopIpcPerfEventInput["refusal"];
  sessionCount: number | null;
  startTimeUnixMs: number;
}): DesktopIpcPerfEventInput {
  return {
    ...input.observation,
    operation: input.operation,
    startTimeUnixMs: input.startTimeUnixMs,
    durationMs: input.durationMs,
    payloadBytes: 0,
    resultCount: 0,
    ...(input.sessionCount === null
      ? {}
      : { sessionCount: input.sessionCount }),
    errorType: ipcErrorTypeName(input.error),
    ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
  };
}

function isAbandonedIpcAttempt(error: unknown): boolean {
  return (
    isDbHostShutdownError(error) ||
    isRecoverableDbHostExitError(error) ||
    isReadCancelledError(error)
  );
}
