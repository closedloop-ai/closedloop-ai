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
  /**
   * Re-run the initial pull and adopt its result.
   *
   * The wiring above only pulls on the FIRST listener, which is enough for state
   * that main pushes on every transition. It is not enough for a store whose
   * value can go stale for a reason main does not push — a preload old enough to
   * have no push channel, or an input the pull depends on (the signed-in user)
   * changing while listeners stay subscribed. A refresh is generation-guarded
   * like the initial pull, so a superseded read cannot land late over a newer
   * answer.
   */
  refresh: () => void;
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
  /**
   * Which pull owns the snapshot. Bumped by every pull and by teardown, so a read
   * superseded by a refresh (or by an unwire) cannot land late and overwrite the
   * newer answer with a staler one.
   */
  let pullGeneration = 0;

  const setSnapshot = (next: T) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const pull = () => {
    if (!config.hasBridge()) {
      return;
    }
    pullGeneration += 1;
    const generation = pullGeneration;
    config
      .pull()
      .then((next) => {
        if (generation === pullGeneration) {
          setSnapshot(next);
        }
      })
      .catch(() => {
        // Main unreachable → stay on the current snapshot; a later push corrects it.
      });
  };

  const wire = () => {
    if (!config.hasBridge()) {
      return;
    }
    pull();
    const unsubscribe = config.subscribe(setSnapshot);
    unwire = () => {
      pullGeneration += 1;
      unsubscribe?.();
      unwire = undefined;
    };
  };

  return {
    getSnapshot: () => snapshot,
    refresh: pull,
    subscribe: (onStoreChange) => {
      if (listeners.size === 0) {
        wire();
      }
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0) {
          unwire?.();
          // Back to the pre-pull snapshot. A torn-down bridge receives no
          // pushes, so a value kept across teardown is one nothing can correct
          // — and re-wiring pulls again anyway, so holding it only buys a first
          // frame rendered from an arbitrarily old answer. Matters for a store
          // shared at module scope, where teardown is the only reset there is.
          snapshot = config.hasBridge() ? config.initial : config.fallback;
        }
      };
    },
  };
}
