/**
 * Per-command promise chain to serialize event ingestion.
 * Without this, rapid socket events for the same command trigger concurrent
 * DB transactions that race on `lastSequenceAcked`, causing sequence_gap
 * rejections and expensive retry loops (O(n²) for n events).
 */
const eventIngestionChains = new Map<string, Promise<void>>();

export function enqueueEventIngestion(
  commandId: string,
  fn: () => Promise<void>
): void {
  const previous = eventIngestionChains.get(commandId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  eventIngestionChains.set(commandId, next);
  // Clean up the chain entry when it settles to avoid memory leaks
  next.then(() => {
    if (eventIngestionChains.get(commandId) === next) {
      eventIngestionChains.delete(commandId);
    }
  });
}
