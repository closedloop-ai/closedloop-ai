export type RetrySpawnDeps = {
  log: (level: "info" | "warn" | "error", msg: string) => void;
  refreshTray: (msg?: string) => void;
  isShuttingDown: () => boolean;
  delay: (ms: number) => Promise<void>;
};

/**
 * Retry a spawn function up to 3 attempts with a fixed back-off schedule.
 *
 * Attempt 0: immediate (no delay)
 * Attempt 1: after deps.delay(200)
 * Attempt 2: after deps.delay(500)
 *
 * Before each retry (not the initial attempt) the function checks
 * deps.isShuttingDown() and rethrows the last error if true.
 *
 * On final failure (all 3 attempts exhausted) calls
 * deps.refreshTray('Spawn failed -- please disconnect and reconnect') then rethrows.
 *
 * On success after a retry (attempt > 0) calls deps.refreshTray() with no args
 * to clear any previous tray message, then returns the result.
 *
 * NOTE: Do NOT use this for detached fire-and-forget spawns.
 */
export async function retrySpawn<T>(
  fn: () => Promise<T>,
  deps: RetrySpawnDeps
): Promise<T> {
  const delays = [200, 500];
  let lastError: Error = new Error("retrySpawn: not yet attempted");

  for (let attempt = 0; attempt < delays.length + 1; attempt++) {
    if (attempt > 0) {
      if (deps.isShuttingDown()) {
        throw lastError;
      }
      await deps.delay(delays[attempt - 1]);
    }

    try {
      const result = await fn();
      if (attempt > 0) {
        deps.refreshTray();
      }
      return result;
    } catch (err) {
      if (
        !(
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw err;
      }
      lastError = err;
      const msg = err.message;
      deps.log("warn", `retrySpawn attempt ${attempt} failed: ${msg}`);
    }
  }

  deps.refreshTray("Spawn failed -- please disconnect and reconnect");
  throw lastError;
}
