import { RealtimeStatus } from "./port";

export type StatusStore = {
  get: () => RealtimeStatus;
  /** No-op once `closed`: a closed client never reopens. */
  set: (next: RealtimeStatus) => void;
  subscribe: (callback: (status: RealtimeStatus) => void) => () => void;
};

export function createStatusStore(): StatusStore {
  let current: RealtimeStatus = RealtimeStatus.Connecting;
  const callbacks = new Set<(status: RealtimeStatus) => void>();
  return {
    get: () => current,
    set(next) {
      if (next === current || current === RealtimeStatus.Closed) {
        return;
      }
      current = next;
      for (const callback of [...callbacks]) {
        callback(next);
      }
    },
    subscribe(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };
}
