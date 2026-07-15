/**
 * @file cooperative-yield.ts
 * @description FEA-2264: a pure macrotask yield shared by the collector boot
 * paths. Returning a `setImmediate` promise hands control back to the event
 * loop's check/poll phase, so queued renderer reads, timers, and the cloud
 * socket are serviced between synchronous batches (the source scan and the
 * Codex rollout-graph build). Unlike a throttling delay it does not sleep, so it
 * un-blocks the main thread without slowing the work.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
