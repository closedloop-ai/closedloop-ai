import { CollectorTailSamplingPolicy } from "@closedloop-ai/telemetry-contract/collector-tail-sampling-policy";
import type {
  DesktopIpcOperation,
  DesktopIpcPerfEventInput,
} from "./app-otel-runtime.js";
import type { DbHostAgentDatabase } from "./database/sqlite.js";

// Head-sampler thresholds (FEA-1997), reused from the collector tail-sampling
// SSOT so desktop head-sampling and the collector's tail policy can never drift:
// slow calls are always kept, the rest are kept at the baseline percentage.
const IPC_PERF_SLOW_THRESHOLD_MS =
  CollectorTailSamplingPolicy.slowLatencyThresholdMs;
const IPC_PERF_BASELINE_SAMPLING_PERCENTAGE =
  CollectorTailSamplingPolicy.baselineSamplingPercentage;

/**
 * Rows a handler returned. The three instrumented handlers return distinct
 * shapes: `list` → `{ items: [...] }` (page rows), `detail` → a single
 * `SharedAgentSessionDetail | null`, `usage` → a single aggregate summary. So:
 * a paginated `{ items }` envelope counts its page; a bare array counts itself;
 * a single non-null record counts as 1; null/undefined counts as 0.
 */
function countResultRows(result: unknown): number {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (result === null || result === undefined) {
    return 0;
  }
  if (typeof result === "object") {
    const items = (result as { items?: unknown }).items;
    return Array.isArray(items) ? items.length : 1;
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
 * The COUNT is best-effort: on failure it falls back to 0 but reports the error
 * via `onError` so a silent zero is observable (the previous blanket swallow is
 * what hid this bug). `onError` is itself best-effort; a throwing callback is
 * swallowed so telemetry can never break the IPC handler (mirrors `safeEmit`).
 */
export async function ipcSessionCount(
  agentDatabase: DbHostAgentDatabase,
  onError?: (error: unknown) => void
): Promise<number> {
  try {
    return await agentDatabase.sessions.count();
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // best-effort: a throwing observability sink must not escape into the handler
    }
    return 0;
  }
}

/**
 * Productionized `diagTime` (FEA-1997): wrap a hot `withDb` IPC handler so each
 * call can emit one sampled OTel perf wide event carrying duration, payload
 * bytes, result count, and total session count. A head-sampler — SSOT'd to the
 * collector tail-sampling policy — always emits slow and errored calls and
 * baseline-samples the rest; only sampled-in spans pay for serialization and the
 * session COUNT. Handler semantics are unchanged: the result is returned and a
 * thrown error is re-thrown after its (always-retained) wide event is emitted.
 *
 * `options.random` is injectable so the baseline sampler is deterministic in
 * tests; `options.onSessionCountError` surfaces a failed `session_count` COUNT.
 */
type InstrumentIpcPerfOptions = {
  /** Injectable RNG so the baseline sampler is deterministic in tests. */
  random?: () => number;
  /**
   * Observability for a failed `session_count` COUNT (FEA-2211). The count is
   * best-effort and falls back to 0; this surfaces the failure (wired to the
   * desktop logger) so a silent zero never goes unnoticed again.
   */
  onSessionCountError?: (error: unknown) => void;
};

export function instrumentIpcPerf<TArgs extends unknown[], TResult>(
  operation: DesktopIpcOperation,
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
    const startTimeUnixMs = Date.now();
    const startedAt = performance.now();
    try {
      const result = await handler(agentDatabase, ...args);
      const durationMs = Math.round(performance.now() - startedAt);
      if (
        durationMs >= IPC_PERF_SLOW_THRESHOLD_MS ||
        random() * 100 < IPC_PERF_BASELINE_SAMPLING_PERCENTAGE
      ) {
        const { payloadBytes, resultCount } = measureIpcResult(result);
        const sessionCount = await ipcSessionCount(
          agentDatabase,
          options.onSessionCountError
        );
        safeEmit({
          operation,
          startTimeUnixMs,
          durationMs,
          payloadBytes,
          resultCount,
          sessionCount,
        });
      }
      return result;
    } catch (error) {
      // Errored calls are always retained (mirrors the collector keep-error
      // policy) and carry no payload/result.
      const durationMs = Math.round(performance.now() - startedAt);
      const sessionCount = await ipcSessionCount(
        agentDatabase,
        options.onSessionCountError
      );
      safeEmit({
        operation,
        startTimeUnixMs,
        durationMs,
        payloadBytes: 0,
        resultCount: 0,
        sessionCount,
        errorType: ipcErrorTypeName(error),
      });
      throw error;
    }
  };
}
