/**
 * Desktop's producer-side displayed-status projection. It shares the canonical
 * three-value fold with cloud; the Status facet reads stored lifecycle evidence.
 */

import {
  type DisplayedSessionStatus,
  resolveDisplayedSessionStatus,
} from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { canonicalSharedStatus } from "./session-status-filter-match.js";

/** Fold local stored status to the canonical value a new list row serves. */
export function projectDisplayedSharedStatus(
  session: SyncedAgentSession,
  now?: Date
): DisplayedSessionStatus {
  const canonical = canonicalSharedStatus(session.status);
  return resolveDisplayedSessionStatus({
    status: canonical,
    now,
  });
}

/** The canonical value `mapListItem` puts on the Desktop list wire. */
export function servedSharedSessionStatus(
  session: SyncedAgentSession,
  now?: Date
): DisplayedSessionStatus {
  return projectDisplayedSharedStatus(session, now);
}

/** Compatibility mirror for the displayed status; ISS-10364 made it idempotent. */
export function resolveDisplayedSharedSessionStatus(
  session: SyncedAgentSession,
  now?: Date
): DisplayedSessionStatus {
  return servedSharedSessionStatus(session, now);
}
