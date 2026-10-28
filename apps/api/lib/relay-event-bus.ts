import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";

/**
 * A handler opts OUT of a delivery by returning `false`. Returning `undefined`
 * means accepted, so a subscriber that just forwards the operation and returns
 * nothing keeps counting as a real delivery (ISS-7558).
 */
type OperationHandler = (
  operation: RelayOperationDispatchRequest
) => boolean | undefined;
type ConnectionCloseHandler = () => void;

const MAX_PENDING_OPERATIONS = 200;
const OPERATION_BACKLOG_TTL_MS = 10 * 60 * 1000;

const operationSubscribers = new Map<string, Set<OperationHandler>>();
const operationBacklog = new Map<
  string,
  { operations: RelayOperationDispatchRequest[]; lastUpdatedAt: number }
>();

const targetConnections = new Map<string, Set<ConnectionCloseHandler>>();

function pruneOperationBacklog(): void {
  const cutoff = Date.now() - OPERATION_BACKLOG_TTL_MS;
  for (const [targetId, entry] of operationBacklog.entries()) {
    if (entry.lastUpdatedAt < cutoff) {
      operationBacklog.delete(targetId);
    }
  }
}

export const relayEventBus = {
  subscribeOperations(targetId: string, handler: OperationHandler): () => void {
    let handlers = operationSubscribers.get(targetId);
    if (!handlers) {
      handlers = new Set();
      operationSubscribers.set(targetId, handlers);
    }
    handlers.add(handler);

    pruneOperationBacklog();
    const entry = operationBacklog.get(targetId);
    const queued = entry?.operations ?? [];
    if (queued.length > 0) {
      operationBacklog.delete(targetId);
      for (const operation of queued) {
        try {
          if (handler(operation) === false) {
            // The backlog was already deleted above, so a rejection on replay is
            // final. No subscriber can reach this today -- the socket one clears
            // the backlog before subscribing and the SSE one never rejects -- but
            // the handler contract permits it, and a silent drop here would be
            // the same class of bug ISS-7558 fixed one layer up.
            log.error("Rejected queued relay operation on replay", {
              targetId,
              computeTargetId: targetId,
              operationId: operation.operationId,
            });
          }
        } catch (error) {
          log.error("Failed replaying queued relay operation", {
            targetId,
            computeTargetId: targetId,
            operationId: operation.operationId,
            error,
          });
        }
      }
    }

    log.info("Relay operation subscriber added", {
      targetId,
      computeTargetId: targetId,
      subscriberCount: handlers.size,
    });

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        operationSubscribers.delete(targetId);
      }
      log.info("Relay operation subscriber removed", {
        targetId,
        computeTargetId: targetId,
        subscriberCount: handlers.size,
      });
    };
  },

  publishOperation(
    targetId: string,
    operation: RelayOperationDispatchRequest
  ): { deliveredToSubscriber: boolean } {
    // Unconditional: a stale entry belongs to a target that
    // by definition is not the one publishing, so sweeping only in the backlog
    // branch would never evict it on an instance whose traffic is all connected.
    pruneOperationBacklog();

    const handlers = operationSubscribers.get(targetId);
    if (!handlers || handlers.size === 0) {
      const pending = operationBacklog.get(targetId) ?? {
        operations: [],
        lastUpdatedAt: Date.now(),
      };
      pending.operations.push(operation);
      pending.lastUpdatedAt = Date.now();
      if (pending.operations.length > MAX_PENDING_OPERATIONS) {
        log.warn("Relay operation backlog overflow, dropping oldest", {
          targetId,
          computeTargetId: targetId,
          operationId: operation.operationId,
          backlogSize: pending.operations.length,
        });
        pending.operations.shift();
      }
      operationBacklog.set(targetId, pending);
      return { deliveredToSubscriber: false };
    }

    let acceptedByAnyHandler = false;
    for (const handler of handlers) {
      try {
        if (handler(operation) !== false) {
          acceptedByAnyHandler = true;
        }
      } catch (error) {
        // A throw is ambiguous: the emit may have partially written, so it is NOT
        // proof of non-delivery and stays accepted, exactly as it always has been.
        // Only an explicit `false` proves nothing went out (ISS-7558).
        acceptedByAnyHandler = true;
        log.error("Failed delivering relay operation", {
          targetId,
          computeTargetId: targetId,
          operationId: operation.operationId,
          error,
        });
      }
    }
    return { deliveredToSubscriber: acceptedByAnyHandler };
  },

  subscribeTargetConnection(
    targetId: string,
    onClose: ConnectionCloseHandler
  ): () => void {
    let handlers = targetConnections.get(targetId);
    if (!handlers) {
      handlers = new Set();
      targetConnections.set(targetId, handlers);
    }
    handlers.add(onClose);

    return () => {
      handlers.delete(onClose);
      if (handlers.size === 0) {
        targetConnections.delete(targetId);
      }
    };
  },

  closeTargetConnections(targetId: string): void {
    const handlers = targetConnections.get(targetId);
    if (!handlers || handlers.size === 0) {
      return;
    }
    for (const handler of handlers) {
      try {
        handler();
      } catch (error) {
        log.error("Failed closing relay target connection", {
          targetId,
          computeTargetId: targetId,
          error,
        });
      }
    }
    targetConnections.delete(targetId);
  },

  clearOperationBacklog(targetId: string): void {
    operationBacklog.delete(targetId);
  },

  /**
   * The TTL sweep has no externally observable effect -- every public path that
   * could read the backlog prunes first -- so a bound on the map itself can only
   * be asserted from here (ISS-7964).
   */
  __operationBacklogSizeForTests(): number {
    return operationBacklog.size;
  },

  __resetForTests(): void {
    operationSubscribers.clear();
    operationBacklog.clear();
    targetConnections.clear();
  },
};
