export type ShutdownDeps = {
  updateCheckTimer: NodeJS.Timeout | null;
  clearUpdateCheckTimer: () => void;
  observability: { shutdown: () => Promise<void> };
  cloudSocket: { stop: () => void };
  commandExecutor: { dispose: () => void };
  agentMonitor: { stop: () => Promise<void> | void };
  server: { stop: () => Promise<void> };
  desktopWindow: { dispose: () => void };
  tray: { dispose: () => void };
  log?: (message: string) => void;
  reportFailure?: (failure: ShutdownFailure) => void;
  /**
   * ISS-4903 — names of teardown steps that ran BEFORE this sequence and did
   * NOT complete (today: background sync lanes that were still executing work
   * when their quiesce budget elapsed, see `desktop-teardown.ts`).
   *
   * The db-host is disposed before this sequence starts, so those lanes cannot
   * be phases here — but their failure to drain is exactly what made the old
   * `clean` verdict a lie: shutdown claimed success while five subsystems were
   * mid-operation, and 20ms later every one of them failed on the disposed
   * handle. Seeding them here means `clean` can only ever mean "nothing was
   * still running", and the earliest un-drained step is the phase reported.
   */
  priorIncompletePhases?: readonly string[];
};

export type ShutdownResult = "clean" | "timed_out" | "failed";

export type ShutdownFailure = {
  result: Extract<ShutdownResult, "timed_out" | "failed">;
  phase: string;
  elapsedMs: number;
  error?: string;
};

/**
 * Per-phase bound. A single hung shutdown phase (most notably the OTel/Datadog
 * exporter flush in `observability.shutdown`, which can wedge on an unreachable
 * collector / a stuck keepalive socket) must never wedge process shutdown. When
 * a phase does not settle within this deadline we log and PROCEED to the next
 * phase rather than awaiting it forever — a hung flush left `desktop-dev`
 * force-killed with SIGKILL (137) on shutdown (ISS-4585).
 */
const DEFAULT_PHASE_TIMEOUT_MS = 3000;

/**
 * Whether a phase timing out is a benign best-effort skip or a real cleanup
 * failure that shutdown must still surface.
 *
 * `optional` — a best-effort drain (the telemetry flush in
 * `observability.shutdown`) that is itself internally bounded; timing it out is
 * expected offline behavior and leaves the sequence `clean`.
 *
 * `required` — real resource teardown (sockets, the local server, executors,
 * windows). A required phase timing out means cleanup did NOT complete, so the
 * sequence still PROCEEDS through the remaining phases (never wedges exit) but
 * is classified `timed_out` and reported — it must not masquerade as a clean
 * exit(0) (wongk, ISS-4585).
 */
const PhaseCriticality = {
  Optional: "optional",
  Required: "required",
} as const;
type PhaseCriticality =
  (typeof PhaseCriticality)[keyof typeof PhaseCriticality];

export async function runShutdownSequence(
  deps: ShutdownDeps,
  options?: {
    timeoutMs?: number;
    phaseTimeoutMs?: number;
    setTimeoutFn?: typeof setTimeout;
  }
): Promise<ShutdownResult> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const phaseTimeoutMs = options?.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
  const setTimeoutFn = options?.setTimeoutFn ?? setTimeout;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentPhase = "not_started";
  // First REQUIRED phase that timed out, if any. Set once (the earliest) so the
  // reported failure names the phase whose cleanup did not complete.
  // ISS-4903: pre-seeded from `priorIncompletePhases` — a teardown step that ran
  // before this sequence and did not drain is, for verdict purposes, the same
  // thing as a required phase that timed out, and it happened EARLIER, so it
  // wins the "earliest" slot.
  let requiredTimeoutPhase: string | null =
    deps.priorIncompletePhases?.[0] ?? null;
  const startedAt = Date.now();
  const log = deps.log ?? (() => {});

  // Bound a single phase's work against `phaseTimeoutMs`. A phase that never
  // settles resolves the race via the timeout branch so the sequence proceeds;
  // the race timer is always cleared on the winning branch (no leaked handle).
  // Returns whether the phase timed out (vs. settled).
  const runWithPhaseTimeout = async (
    name: string,
    work: () => Promise<void> | void
  ): Promise<boolean> => {
    let phaseTimer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<"phase_timed_out">((resolve) => {
      phaseTimer = setTimeoutFn(
        () => resolve("phase_timed_out"),
        phaseTimeoutMs
      );
      // Unref so a phase timer abandoned when the OVERALL deadline wins the
      // race (its phase is still hung, so its clear below never runs) cannot
      // keep the event loop alive and delay exit.
      unrefTimer(phaseTimer);
    });
    const settled = Promise.resolve()
      .then(() => work())
      .then(() => "phase_done" as const);
    try {
      // A rejecting phase propagates (the outer catch classifies it "failed");
      // the timer is cleared in `finally` on every branch — resolve, timeout,
      // and reject — so only the overall-deadline abandon path leaves it (unref'd).
      const outcome = await Promise.race([settled, timedOut]);
      if (outcome === "phase_timed_out") {
        log(
          `shutdown phase timed out after ${phaseTimeoutMs}ms: ${name} — proceeding to exit`
        );
        return true;
      }
      return false;
    } finally {
      if (phaseTimer != null) {
        clearTimeout(phaseTimer);
      }
    }
  };

  const runPhase = async (
    name: string,
    criticality: PhaseCriticality,
    work: () => Promise<void> | void
  ) => {
    currentPhase = name;
    log(`shutdown phase start: ${name}`);
    const didTimeOut = await runWithPhaseTimeout(name, work);
    // A required phase that timed out did NOT complete its cleanup: record it so
    // the sequence is classified timed_out (not clean) while still proceeding.
    if (
      didTimeOut &&
      criticality === PhaseCriticality.Required &&
      requiredTimeoutPhase == null
    ) {
      requiredTimeoutPhase = name;
    }
    log(`shutdown phase end: ${name}`);
  };
  const reportFailure = (failure: ShutdownFailure) => {
    try {
      deps.reportFailure?.(failure);
    } catch {
      // Shutdown telemetry must never change shutdown control flow.
    }
  };

  const cleanup = async (): Promise<"clean" | "timed_out"> => {
    log("shutdown sequence start");
    // ISS-4903: name the un-drained pre-sequence steps up front so the log shows
    // WHY this run cannot end `clean`, at the point the sequence begins rather
    // than only in the final verdict line.
    const priorIncomplete = deps.priorIncompletePhases ?? [];
    if (priorIncomplete.length > 0) {
      log(
        `shutdown pre-sequence steps did not drain: ${priorIncomplete.join(", ")}`
      );
    }
    await runPhase("clear-update-check-timer", PhaseCriticality.Required, () =>
      deps.clearUpdateCheckTimer()
    );
    // Optional: best-effort telemetry drain, itself internally bounded. Timing
    // it out is expected offline behavior and must not fail the shutdown.
    await runPhase("observability.shutdown", PhaseCriticality.Optional, () =>
      deps.observability.shutdown().catch(() => {})
    );
    await runPhase("cloudSocket.stop", PhaseCriticality.Required, () =>
      deps.cloudSocket.stop()
    );
    await runPhase("commandExecutor.dispose", PhaseCriticality.Required, () =>
      deps.commandExecutor.dispose()
    );
    await runPhase("agentMonitor.stop", PhaseCriticality.Required, () =>
      deps.agentMonitor.stop()
    );
    await runPhase("server.stop", PhaseCriticality.Required, () =>
      deps.server.stop()
    );
    await runPhase("desktopWindow.dispose", PhaseCriticality.Required, () =>
      deps.desktopWindow.dispose()
    );
    await runPhase("tray.dispose", PhaseCriticality.Required, () =>
      deps.tray.dispose()
    );
    // Required-phase timeouts are logged/reported by the caller (with elapsed
    // time), so only emit the clean-end marker here.
    if (requiredTimeoutPhase != null) {
      return "timed_out";
    }
    log("shutdown sequence end: clean");
    return "clean";
  };

  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeoutFn(() => resolve("timed_out"), timeoutMs);
    unrefTimer(timer);
  });

  try {
    const result = await Promise.race([cleanup(), timeout]);
    if (result === "timed_out") {
      // Two ways to be timed_out: a REQUIRED phase's per-phase deadline fired
      // (cleanup ran to the end but a phase didn't complete — name that phase),
      // or the OVERALL deadline won the race (a phase is still hung now — name
      // the current phase). Either way this is not a clean exit(0).
      const failure: ShutdownFailure = {
        result,
        phase: requiredTimeoutPhase ?? currentPhase,
        elapsedMs: Date.now() - startedAt,
      };
      log(
        `shutdown sequence end: timed_out phase=${failure.phase} elapsedMs=${failure.elapsedMs}`
      );
      reportFailure(failure);
    }
    return result;
  } catch (error) {
    const failure: ShutdownFailure = {
      result: "failed",
      phase: currentPhase,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    log(
      `shutdown sequence end: failed phase=${failure.phase} elapsedMs=${failure.elapsedMs} error=${failure.error}`
    );
    reportFailure(failure);
    return "failed";
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") {
    maybeUnref.call(timer);
  }
}
