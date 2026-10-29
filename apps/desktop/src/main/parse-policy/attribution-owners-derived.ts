/**
 * ISS-12552 (PRD-800 "Rollout"): whether this
 * process's stored token-event owners were derived under the attribution
 * policy it runs now. Until they are, sessions an off period stored carry NULL
 * owners, and syncing one with the owner capability on sends the parent marker
 * for every event, which can overwrite subagent ownership the server already
 * holds. Sync therefore sends owners only once this is true.
 *
 * Starts false, so after a boot owners wait for that boot's rebuild too: an
 * earlier process may have flipped on and quit before its rebuild finished.
 * Every flip clears it. A data-revision rebuild that began after the latest
 * flip and completed without failing sets it; under the base policy that has
 * no effect, since sync sends no owners then whatever this says.
 */

let flips = 0;
let derived = false;

export function attributionOwnersDerived(): boolean {
  return derived;
}

/** Called by the controller on every settled flip, before it is announced. */
export function noteParsePolicyFlipForOwners(): void {
  flips += 1;
  derived = false;
}

/**
 * Snapshot taken when a rebuild starts. Call the returned function only when
 * that rebuild completed; it arms owners if no flip came in between.
 */
export function beginAttributionOwnersRebuild(): () => void {
  const at = flips;
  return () => {
    if (at !== flips || derived) {
      return;
    }
    derived = true;
    for (const listener of derivedListeners) {
      try {
        listener();
      } catch {
        // A subscriber's own failure must not strand the others.
      }
    }
  };
}

const derivedListeners = new Set<() => void>();

/**
 * Called each time owners become derived. This is when the session sync
 * lane's integrity rung can rise to the owner rung, and the lane reads its
 * durable cursor only when it hydrates, so it re-hydrates here
 * (`agent-sync/owner-rung-cursor-rehydration.ts`).
 */
export function subscribeAttributionOwnersDerived(
  listener: () => void
): () => void {
  derivedListeners.add(listener);
  return () => {
    derivedListeners.delete(listener);
  };
}
