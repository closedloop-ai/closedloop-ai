/**
 * Yield the main-process event loop for one turn so pending renderer IPC,
 * window paints, and timers get a slot before the caller's next chunk of work.
 */
export function yieldToMainLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolve after `ms`. Used for bounded fail-open races and quiet-window waits. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
