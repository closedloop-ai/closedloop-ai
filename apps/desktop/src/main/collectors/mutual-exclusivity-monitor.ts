/**
 * @file mutual-exclusivity-monitor.ts
 * @description FEA-1839: runtime detector that enforces the collection-mode
 * INVARIANT (see `collection-mode.ts`). Both live-capture channels report the
 * sessions they emit; if the SAME harness session is ever emitted by BOTH the
 * hook handler and the live watcher within one process lifetime, that is a
 * mutual-exclusivity violation (a config or wiring bug that double-counts rows)
 * and fires `onViolation` exactly once for that `(harness, session)` key.
 *
 * Under correct configuration a watcher only exists in `"watcher"` mode and the
 * hook handler only fires in `"hooks"` mode, so the two channels are disjoint and
 * `onViolation` never fires.
 */
import type { Harness } from "./types.js";

/** The two live-capture channels that can emit a harness session. */
export type CollectionChannel = "hooks" | "watcher";

export type MutualExclusivityMonitor = {
  /**
   * Record that `channel` emitted `externalSessionId` for `harness`. Empty
   * session ids are ignored. The first time both channels are seen for one key,
   * `onViolation` fires once; subsequent records for that key are no-ops.
   */
  record(
    harness: Harness,
    externalSessionId: string | null | undefined,
    channel: CollectionChannel
  ): void;
  /**
   * Drop all recorded channel state. Call on a configuration change (e.g. a
   * hooks toggle that restarts collectors): a session legitimately captured by
   * the watcher under the old mode and by the hook handler under the new mode is
   * a mode transition, not a same-config double-count, and must not be flagged.
   */
  reset(): void;
};

export type MutualExclusivityMonitorOptions = {
  /** Invoked exactly once per `(harness, session)` on the first collision. */
  onViolation: (harness: Harness, externalSessionId: string) => void;
  /** Key-free diagnostic sink. */
  log?: (message: string) => void;
};

// NUL — illegal in any harness/session id — separates the two key components so
// the `(harness, sessionId)` map key can never alias across boundaries.
const KEY_SEPARATOR = "\u0000";

export function createMutualExclusivityMonitor(
  options: MutualExclusivityMonitorOptions
): MutualExclusivityMonitor {
  // These accumulate one small entry per `(harness, session)` seen and are only
  // cleared by `reset()`. The caller MUST call `reset()` whenever the active
  // collection mode can change (the runtime does so in `restartCollectors`, the
  // hooks-toggle boundary): otherwise a session captured by the watcher under
  // the old mode and re-captured by the hook handler under the new mode would be
  // misread as a same-config double-count rather than a deliberate transition.
  const channelsByKey = new Map<string, Set<CollectionChannel>>();
  const reported = new Set<string>();

  return {
    record(harness, externalSessionId, channel) {
      if (!externalSessionId) {
        return;
      }
      const key = `${harness}${KEY_SEPARATOR}${externalSessionId}`;
      let channels = channelsByKey.get(key);
      if (!channels) {
        channels = new Set<CollectionChannel>();
        channelsByKey.set(key, channels);
      }
      channels.add(channel);

      if (
        channels.has("hooks") &&
        channels.has("watcher") &&
        !reported.has(key)
      ) {
        reported.add(key);
        options.log?.(
          `mutual-exclusivity violation: harness=${harness} session=${externalSessionId} emitted via both hooks and watcher`
        );
        options.onViolation(harness, externalSessionId);
      }
    },
    reset() {
      channelsByKey.clear();
      reported.clear();
    },
  };
}
