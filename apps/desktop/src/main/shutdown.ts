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
};

export type ShutdownResult = "clean" | "timed_out" | "failed";

export type ShutdownFailure = {
  result: Extract<ShutdownResult, "timed_out" | "failed">;
  phase: string;
  elapsedMs: number;
  error?: string;
};

export async function runShutdownSequence(
  deps: ShutdownDeps,
  options?: { timeoutMs?: number; setTimeoutFn?: typeof setTimeout }
): Promise<ShutdownResult> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const setTimeoutFn = options?.setTimeoutFn ?? setTimeout;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentPhase = "not_started";
  const startedAt = Date.now();
  const log = deps.log ?? (() => {});

  const runPhase = async (name: string, work: () => Promise<void> | void) => {
    currentPhase = name;
    log(`shutdown phase start: ${name}`);
    await work();
    log(`shutdown phase end: ${name}`);
  };
  const reportFailure = (failure: ShutdownFailure) => {
    try {
      deps.reportFailure?.(failure);
    } catch {
      // Shutdown telemetry must never change shutdown control flow.
    }
  };

  const cleanup = async (): Promise<"clean"> => {
    log("shutdown sequence start");
    await runPhase("clear-update-check-timer", () =>
      deps.clearUpdateCheckTimer()
    );
    await runPhase("observability.shutdown", async () => {
      await deps.observability.shutdown().catch(() => {});
    });
    await runPhase("cloudSocket.stop", () => deps.cloudSocket.stop());
    await runPhase("commandExecutor.dispose", () =>
      deps.commandExecutor.dispose()
    );
    await runPhase("agentMonitor.stop", async () => {
      await deps.agentMonitor.stop();
    });
    await runPhase("server.stop", () => deps.server.stop());
    await runPhase("desktopWindow.dispose", () => deps.desktopWindow.dispose());
    await runPhase("tray.dispose", () => deps.tray.dispose());
    log("shutdown sequence end: clean");
    return "clean";
  };

  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeoutFn(() => resolve("timed_out"), timeoutMs);
  });

  try {
    const result = await Promise.race([cleanup(), timeout]);
    if (result === "timed_out") {
      const failure: ShutdownFailure = {
        result,
        phase: currentPhase,
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
