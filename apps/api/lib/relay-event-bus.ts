import type { JsonValue } from "@repo/api/src/types/common";
import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import {
  emitProtocolMetric,
  emitQueueMetric,
} from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import { safeEmit } from "@/lib/telemetry-utils";

type OperationHandler = (operation: RelayOperationDispatchRequest) => void;
type ResultHandler = (event: RelayResultEvent) => void;
type ConnectionCloseHandler = () => void;

type RelayResultEvent = {
  operationId: string;
  result?: JsonValue;
  event?: JsonValue;
  done?: boolean;
  error?: string;
  sequence?: number;
};

const MAX_PENDING_OPERATIONS = 200;
const MAX_RESULT_EVENTS = 500;
const RESULT_REPLAY_TTL_MS = 10 * 60 * 1000;

const operationSubscribers = new Map<string, Set<OperationHandler>>();
const operationBacklog = new Map<string, RelayOperationDispatchRequest[]>();

const resultSubscribers = new Map<string, Set<ResultHandler>>();
const resultBacklog = new Map<
  string,
  {
    events: RelayResultEvent[];
    completed: boolean;
    lastUpdatedAt: number;
  }
>();

const targetConnections = new Map<string, Set<ConnectionCloseHandler>>();

function pruneResultBacklog(): void {
  const cutoff = Date.now() - RESULT_REPLAY_TTL_MS;
  for (const [operationId, entry] of resultBacklog.entries()) {
    if (entry.lastUpdatedAt < cutoff) {
      resultBacklog.delete(operationId);
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

    const queued = operationBacklog.get(targetId) ?? [];
    if (queued.length > 0) {
      operationBacklog.delete(targetId);
      for (const operation of queued) {
        try {
          handler(operation);
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
    const handlers = operationSubscribers.get(targetId);
    if (!handlers || handlers.size === 0) {
      const pending = operationBacklog.get(targetId) ?? [];
      pending.push(operation);
      if (pending.length > MAX_PENDING_OPERATIONS) {
        log.warn("Relay operation backlog overflow, dropping oldest", {
          targetId,
          computeTargetId: targetId,
          operationId: operation.operationId,
          backlogSize: pending.length,
        });
        pending.shift();
      }
      operationBacklog.set(targetId, pending);
      return { deliveredToSubscriber: false };
    }

    for (const handler of handlers) {
      try {
        handler(operation);
      } catch (error) {
        log.error("Failed delivering relay operation", {
          targetId,
          computeTargetId: targetId,
          operationId: operation.operationId,
          error,
        });
      }
    }
    return { deliveredToSubscriber: true };
  },

  subscribeResults(operationId: string, handler: ResultHandler): () => void {
    pruneResultBacklog();

    let handlers = resultSubscribers.get(operationId);
    if (!handlers) {
      handlers = new Set();
      resultSubscribers.set(operationId, handlers);
    }
    handlers.add(handler);

    const replay = resultBacklog.get(operationId);
    if (replay) {
      for (const event of replay.events) {
        try {
          handler(event);
        } catch (error) {
          log.error("Failed replaying relay result event", {
            operationId,
            error,
          });
        }
      }
      // Emit once per replay trigger. `value` reflects events attempted
      // (not confirmed-delivered) in this replay batch.
      safeEmit(() =>
        emitQueueMetric({
          metric: "replay_frequency",
          origin: ORIGIN,
          count: 1,
          value: replay.events.length,
        })
      );
    }

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        resultSubscribers.delete(operationId);
      }
    };
  },

  publishResult(operationId: string, event: RelayResultEvent): void {
    pruneResultBacklog();

    const backlog = resultBacklog.get(operationId) ?? {
      events: [],
      completed: false,
      lastUpdatedAt: Date.now(),
    };

    backlog.events.push(event);
    backlog.lastUpdatedAt = Date.now();
    if (backlog.events.length > MAX_RESULT_EVENTS) {
      backlog.events.shift();
    }
    if (event.done || event.result !== undefined) {
      backlog.completed = true;
    }
    resultBacklog.set(operationId, backlog);

    safeEmit(() =>
      emitProtocolMetric({
        metric: "replay_window_usage",
        origin: ORIGIN,
        value: backlog.events.length / MAX_RESULT_EVENTS,
      })
    );

    const handlers = resultSubscribers.get(operationId);
    if (!handlers || handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        log.error("Failed delivering relay result event", {
          operationId,
          error,
        });
      }
    }
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

  __resetForTests(): void {
    operationSubscribers.clear();
    operationBacklog.clear();
    resultSubscribers.clear();
    resultBacklog.clear();
    targetConnections.clear();
  },
};

export type { RelayResultEvent };
