import {
  type RealtimeChannelListener,
  type RealtimeClientPort,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import { vi } from "vitest";

type Joined = {
  channel: string;
  listener: RealtimeChannelListener;
  leave: ReturnType<typeof vi.fn>;
};

/** A `RealtimeClientPort` the test drives: it records joins and plays status changes. */
export function createFakeRealtimePort() {
  let status: RealtimeStatus = RealtimeStatus.Connecting;
  const statusCallbacks = new Set<(next: RealtimeStatus) => void>();
  const joins: Joined[] = [];
  const port: RealtimeClientPort = {
    join: (channel, listener) => {
      const leave = vi.fn();
      joins.push({ channel, listener, leave });
      return leave;
    },
    status: () => status,
    onStatus: (callback) => {
      statusCallbacks.add(callback);
      return () => {
        statusCallbacks.delete(callback);
      };
    },
  };
  return {
    port,
    joins,
    setStatus(next: RealtimeStatus) {
      status = next;
      for (const callback of [...statusCallbacks]) {
        callback(next);
      }
    },
    /** The one listener joined so far. */
    onlyListener(): RealtimeChannelListener {
      const [joined, ...rest] = joins;
      if (joined === undefined || rest.length > 0) {
        throw new Error(`expected one join, got ${joins.length}`);
      }
      return joined.listener;
    },
  };
}
