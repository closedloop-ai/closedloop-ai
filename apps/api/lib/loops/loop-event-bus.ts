import type { LoopEvent } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";

type LoopEventHandler = (event: LoopEvent) => void;

/**
 * In-memory pub/sub event bus for real-time loop event streaming.
 *
 * When a container POSTs an event to /api/loops/[id]/events, the route
 * publishes it here. SSE subscribers (GET /api/loops/[id]/stream) receive
 * the event in real time.
 *
 * This is intentionally in-memory for V1. If the API server restarts,
 * active SSE connections are dropped and clients reconnect. Historical
 * events are always available from the database via GET /api/loops/[id]/events.
 */
const subscribers = new Map<string, Set<LoopEventHandler>>();

export const loopEventBus = {
  /**
   * Subscribe to events for a specific loop.
   * Returns an unsubscribe function that removes the handler.
   */
  subscribe(loopId: string, handler: LoopEventHandler): () => void {
    let handlers = subscribers.get(loopId);
    if (!handlers) {
      handlers = new Set();
      subscribers.set(loopId, handlers);
    }
    handlers.add(handler);

    log.info("SSE subscriber added", {
      loopId,
      subscriberCount: handlers.size,
    });

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        subscribers.delete(loopId);
      }
      log.info("SSE subscriber removed", {
        loopId,
        subscriberCount: handlers.size,
      });
    };
  },

  /**
   * Publish an event to all subscribers of a loop.
   * Non-blocking: errors in individual handlers are caught and logged.
   */
  publish(loopId: string, event: LoopEvent): void {
    const handlers = subscribers.get(loopId);
    if (!handlers || handlers.size === 0) {
      return;
    }

    log.info("Publishing loop event", {
      loopId,
      eventType: event.type,
      subscriberCount: handlers.size,
    });

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        log.error("Error in loop event handler", { loopId, error });
      }
    }
  },

  /**
   * Get the number of active subscribers for a loop.
   * Useful for diagnostics.
   */
  subscriberCount(loopId: string): number {
    return subscribers.get(loopId)?.size ?? 0;
  },
};
