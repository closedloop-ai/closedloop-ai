/**
 * ISS-12552 (PRD-800 "Rollout"): spend the one
 * owner-carrying re-walk a flip to on owes.
 *
 * The session lane's integrity rung reaches the owner rung only once owners
 * are derived under the attribution policy (`sendsTokenEventOwners`), and the
 * lane compares its durable cursor's stamp against that rung only when it
 * hydrates (`sqliteLoadSyncState`). A running lane hydrates once per identity,
 * so without this the next cursor persist would stamp the owner rung with no
 * re-walk, and a session already synced and unchanged would never reach the
 * cloud with its operation evidence or token-event owners.
 *
 * It fires when owners become derived, not when the flip settles: the flip
 * clears the latch, so a hydration then would still compare against the rung
 * below owners and find nothing stale. Arming covers a flip and a boot alike.
 * With owners not sent (the policy off, or a server that does not accept them)
 * it does nothing, so settling to off keeps the behavior it had.
 */
import { subscribeAttributionOwnersDerived } from "../parse-policy/attribution-owners-derived.js";
import { resolveSyncContractCapabilities } from "./agent-session-sync-capabilities.js";
import type { AgentSessionSyncService } from "./agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "./agent-session-sync-service-options.js";

export function rehydrateSessionCursorWhenOwnersDerive(
  service: Pick<AgentSessionSyncService, "resetSourceState" | "refresh">,
  options: AgentSessionSyncServiceOptions
): () => void {
  return subscribeAttributionOwnersDerived(() => {
    if (!resolveSyncContractCapabilities(options).tokenEventOwner) {
      return;
    }
    // The hard reset re-hydrates from the persisted cursor on the next pass,
    // which re-walks once if its stamp is below the owner rung.
    service.resetSourceState();
    service.refresh();
  });
}
