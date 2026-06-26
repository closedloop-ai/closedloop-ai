export type QueueStats = {
  activeCommands: number;
  queueDepth: number;
};

export type QueueStatsDebounce = {
  trigger(stats: QueueStats): void;
  cancel(): void;
};

/**
 * Trailing-edge debounce for queue stats telemetry. The final value in a
 * burst is the one emitted, at most once per `delayMs`. Presence updates
 * stay synchronous at the call site; only telemetry is batched here.
 */
export function createQueueStatsDebounce(
  fn: (activeCommands: number, queueDepth: number) => void,
  delayMs: number
): QueueStatsDebounce {
  let timer: NodeJS.Timeout | null = null;
  let pending: QueueStats | null = null;

  return {
    trigger(stats) {
      pending = stats;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next) {
          fn(next.activeCommands, next.queueDepth);
        }
      }, delayMs);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
