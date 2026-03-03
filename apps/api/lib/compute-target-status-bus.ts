type StatusChangeEvent = { targetId: string; isOnline: boolean };
type StatusChangeHandler = (event: StatusChangeEvent) => void;

const GLOBAL_KEY = "__computeTargetStatusBusSubscribers";

// Pin to globalThis so the tsx server context and Next.js bundled route
// context share the same Map (same pattern as Prisma's globalThis.prisma).
function getSubscribers(): Map<string, Set<StatusChangeHandler>> {
  const g = globalThis as Record<string, unknown>;
  g[GLOBAL_KEY] ??= new Map<string, Set<StatusChangeHandler>>();
  return g[GLOBAL_KEY] as Map<string, Set<StatusChangeHandler>>;
}

export function publishStatusChange(
  organizationId: string,
  targetId: string,
  isOnline: boolean
): void {
  const subscribers = getSubscribers();
  const handlers = subscribers.get(organizationId);
  if (!handlers || handlers.size === 0) {
    return;
  }
  const event: StatusChangeEvent = { targetId, isOnline };
  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      // Swallow handler errors to avoid breaking other subscribers.
    }
  }
}

export function subscribeStatusChanges(
  organizationId: string,
  handler: StatusChangeHandler
): () => void {
  const subscribers = getSubscribers();
  let handlers = subscribers.get(organizationId);
  if (!handlers) {
    handlers = new Set();
    subscribers.set(organizationId, handlers);
  }
  handlers.add(handler);

  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      subscribers.delete(organizationId);
    }
  };
}
