import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  DeadEndFlowPhase,
  type DeadEndFlowReason,
  DeadEndFlowRetryOutcome,
  type DeadEndFlowState,
  type DeadEndFlowTreatment,
  type DeadEndTelemetryCause,
  type DeadEndTelemetryPayload,
} from "../../shared/dead-end-telemetry-contract";
import {
  DesktopAppCoreMode,
  DesktopAppCoreModeContext,
} from "../shared-agent-sessions/desktop-app-core-mode";

/**
 * ISS-7249 — count a rendered dead-end treatment as the tracked error it is,
 * once per render-WITH-CAUSE. React re-renders freely, so a naive effect turns
 * one dead end into dozens of records. Three choices carry that: the effect runs
 * on EVERY commit (no dep array) so the ref comparison is the only thing
 * deduplicating; refs not state, so StrictMode's effect replay sees the emitted
 * key; and the cause KEY is the identity, so a 404 becoming a 503 IS emitted.
 */

export type DeadEndCause = {
  treatment: DeadEndFlowTreatment;
  state: DeadEndFlowState;
  reason: DeadEndFlowReason;
  retryOffered: boolean;
  /** Omitted when no response carried one. */
  httpStatus?: number;
};

export type DeadEndTelemetry = {
  /**
   * Wrap the surface's own retry handler: `retry_attempted` before the read,
   * `retry_settled` after, carrying whether the surface is still a dead end.
   */
  trackRetry: (attempt: () => Promise<unknown>) => Promise<void>;
};

export type UseDeadEndTelemetryArgs = {
  cause: DeadEndCause | null;
  /**
   * Whether the surface is the content the user is actually looking at
   * (ISS-7249, whitlockk review). The desktop shell keeps every visited page mounted
   * under keep-alive, so a hidden Sessions tree keeps polling and can reach a
   * dead end nobody saw. Emitting from there is worse than a duplicate: the key
   * guard would then SUPPRESS the record for the visible occurrence when the
   * user came back, so the one treatment a person actually hit would be the one
   * never counted. Defaults to `true` for a surface that is only ever mounted
   * when it is on screen.
   */
  active?: boolean;
  /** Seam for tests; production uses the preload IPC reporter. */
  report?: DeadEndReporter;
};

export type DeadEndReporter = (payload: DeadEndTelemetryPayload) => void;

/** A pressed Retry: what it was pressed against, and which attempt it was. */
type RetryInFlight = { attempt: number; cause: DeadEndCause };

export function useDeadEndTelemetry({
  cause,
  active = true,
  report = reportDeadEndEvent,
}: UseDeadEndTelemetryArgs): DeadEndTelemetry {
  // Idempotent render-phase writes: safe under StrictMode's doubled render.
  const causeRef = useRef<DeadEndCause | null>(cause);
  causeRef.current = cause;
  const activeRef = useRef(active);
  activeRef.current = active;
  const reportRef = useRef(report);
  reportRef.current = report;
  // ISS-12039: the `useDesktopAppCoreMode` value, the mode that picks the
  // Sessions read source.
  const readsCloud =
    useContext(DesktopAppCoreModeContext) === DesktopAppCoreMode.Cloud;

  // Written only from the effect and the retry callbacks, never the render
  // phase, so a doubled render leaves them intact.
  const emittedKeyRef = useRef<string | null>(null);
  const retryAttemptRef = useRef(0);
  /*
   * INVARIANT: a null cause while a retry is outstanding is not a recovery.
   * Retry re-arms the stall detector, so the cause goes null on the next commit
   * with nothing recovered — cause bookkeeping is held until the read answers.
   */
  const retryInFlightRef = useRef<RetryInFlight | null>(null);
  // Set once the retry's read has answered, so the next commit emits its outcome.
  const retrySettledPendingRef = useRef<RetryInFlight | null>(null);
  const mountedRef = useRef(true);
  // State only because a promise settling outside React schedules no commit.
  const [, setRetrySettleTick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // No dependency array: this runs on every commit, and the key comparison
  // below is the ONLY thing that stops it emitting on every one of them.
  useEffect(() => {
    const currentCause = causeRef.current;
    const key = currentCause === null ? null : deadEndCauseKey(currentCause);

    // Settle FIRST, before the same-key return: a failed retry leaves the same
    // dead end up, and that is the case a key guard would swallow. The attempt
    // count is the one CAPTURED when Retry was pressed, so the settled record
    // and its attempted sibling always agree.
    const settled = retrySettledPendingRef.current;
    if (settled !== null) {
      retrySettledPendingRef.current = null;
      reportRef.current(
        buildSettledPayload(currentCause, settled.cause, settled.attempt)
      );
    }

    // The settle above is NOT gated on `active`: a retry the user pressed while
    // looking at the screen is a real attempt, and withholding its outcome
    // because they navigated away mid-read would strand it with no settled
    // sibling — the same missing-half the in-flight guard exists to prevent.
    // The RENDER emit is, and it leaves every ref untouched: a treatment that
    // came up behind a hidden page is emitted, once, when the page is shown.
    if (!activeRef.current) {
      return;
    }
    if (key === emittedKeyRef.current || retryInFlightRef.current !== null) {
      return;
    }
    emittedKeyRef.current = key;
    if (currentCause === null) {
      // The tally counts retries since the surface last worked.
      retryAttemptRef.current = 0;
      return;
    }
    reportRef.current({
      ...causePayloadFields(currentCause),
      phase: DeadEndFlowPhase.Rendered,
      retryAttempt: retryAttemptRef.current,
      ...(readsCloud ? { readsCloud: true } : {}),
    });
  });

  const trackRetry = useCallback(async (attempt: () => Promise<unknown>) => {
    const currentCause = causeRef.current;
    if (currentCause === null) {
      // Not a dead-end retry, so the tally stays where it is: incrementing on
      // a press that had nothing to recover would inflate the retry rate.
      await attempt().catch(() => undefined);
      return;
    }
    if (retryInFlightRef.current !== null) {
      /*
       * A press landing while a retry is still outstanding is impatience with
       * THAT read, not a second recovery, and the Sessions list offers nothing
       * to stop it: its Retry carries no disabled or pending state. Recording it
       * would corrupt the measurement twice over — a second `retry_attempted`
       * inflates the retries-per-dead-end tally for one logical recovery, and
       * the single settle slot below can hold only one outcome, so the extra
       * attempt would ship with no settled sibling and read as a retry that
       * never came back. The real recovery still runs; only the bookkeeping is
       * skipped, so the outstanding retry keeps ownership of the tally, the
       * in-flight guard, and the settle.
       */
      await attempt().catch(() => undefined);
      return;
    }
    retryAttemptRef.current += 1;
    const inFlight: RetryInFlight = {
      attempt: retryAttemptRef.current,
      cause: currentCause,
    };
    retryInFlightRef.current = inFlight;
    reportRef.current({
      ...causePayloadFields(currentCause),
      phase: DeadEndFlowPhase.RetryAttempted,
      retryAttempt: inFlight.attempt,
    });
    await attempt().catch(() => undefined);
    retryInFlightRef.current = null;
    if (!mountedRef.current) {
      // Navigated away mid-read: an outcome here would be a guess about a
      // screen nobody was looking at.
      return;
    }
    retrySettledPendingRef.current = inFlight;
    setRetrySettleTick((tick) => tick + 1);
  }, []);

  return { trackRetry };
}

/**
 * Two commits with the same key are one dead end. `retryOffered` is excluded —
 * gaining a retry mid-stall is not a second failure.
 */
export function deadEndCauseKey(cause: DeadEndCause): string {
  return [
    cause.treatment,
    cause.state,
    cause.reason,
    cause.httpStatus ?? "",
  ].join("|");
}

/**
 * Silent by design: no log (`no-client-debug-logging`) and no error surfaced —
 * a telemetry failure must not add a second message to a screen already telling
 * the user something went wrong.
 */
export function reportDeadEndEvent(payload: DeadEndTelemetryPayload): void {
  try {
    window.desktopApi.recordDeadEndTelemetry(payload).catch(() => undefined);
  } catch {
    // Preload surface unavailable; nothing to report and nothing to say.
  }
}

function causePayloadFields(cause: DeadEndCause): DeadEndTelemetryCause {
  return {
    treatment: cause.treatment,
    state: cause.state,
    reason: cause.reason,
    retryOffered: cause.retryOffered,
    ...(cause.httpStatus === undefined ? {} : { httpStatus: cause.httpStatus }),
  };
}

/**
 * A recovery carries `retriedCause` — what Retry was pressed AGAINST — because
 * "do retries of this treatment recover?" needs the record to say what it
 * recovered from. A still-failing retry carries the LIVE cause instead.
 */
function buildSettledPayload(
  liveCause: DeadEndCause | null,
  retriedCause: DeadEndCause,
  retryAttempt: number
): DeadEndTelemetryPayload {
  if (liveCause === null) {
    return {
      ...causePayloadFields(retriedCause),
      phase: DeadEndFlowPhase.RetrySettled,
      retryAttempt,
      retryOutcome: DeadEndFlowRetryOutcome.Recovered,
    };
  }
  return {
    ...causePayloadFields(liveCause),
    phase: DeadEndFlowPhase.RetrySettled,
    retryAttempt,
    retryOutcome: DeadEndFlowRetryOutcome.StillDeadEnd,
  };
}
