/**
 * Generic `useSyncExternalStore` factory that mirrors a piece of main-process
 * state into the renderer over IPC. Both the desktop auth store
 * ({@link createDesktopAuthStore}) and the existing-user resolution store
 * ({@link createResolutionStore}) share this exact shape: on the first listener
 * it wires the bridge — an initial pull plus a push subscription for every
 * transition — and on the last listener it tears the wiring down. `getSnapshot`
 * returns the latest mirrored value (a stable reference between transitions).
 *
 * Bridge-absent (a partial test stub that omits the pull channel) settles to the
 * `fallback` snapshot rather than stranding on `initial`.
 */

export type BridgeStore<T> = {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => T;
};

export type BridgeStoreConfig<T> = {
  /**
   * Whether the main-process bridge is exposed. False only in unit-test
   * harnesses that stub a partial `window.desktopApi`.
   */
  hasBridge: () => boolean;
  /**
   * Initial pull of the current main-process value. Only invoked when
   * {@link hasBridge} is true.
   */
  pull: () => Promise<T>;
  /**
   * Subscribe to push transitions. May be absent (a harness stubbing the pull
   * but not the push channel), hence the optional return.
   */
  subscribe: (onChange: (next: T) => void) => (() => void) | undefined;
  /** Snapshot before the first pull settles, when the bridge is present. */
  initial: T;
  /** Settled snapshot when the bridge is absent. */
  fallback: T;
};

export function createBridgeStore<T>(
  config: BridgeStoreConfig<T>
): BridgeStore<T> {
  let snapshot: T = config.hasBridge() ? config.initial : config.fallback;
  const listeners = new Set<() => void>();
  let unwire: (() => void) | undefined;

  const setSnapshot = (next: T) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const wire = () => {
    if (!config.hasBridge()) {
      return;
    }
    let cancelled = false;
    config
      .pull()
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      })
      .catch(() => {
        // Main unreachable → stay on the current snapshot; a later push corrects it.
      });
    const unsubscribe = config.subscribe(setSnapshot);
    unwire = () => {
      cancelled = true;
      unsubscribe?.();
      unwire = undefined;
    };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (onStoreChange) => {
      if (listeners.size === 0) {
        wire();
      }
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0) {
          unwire?.();
        }
      };
    },
  };
}
