import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";
import { createContext, type ReactNode, useContext } from "react";

/**
 * ISS-5489 (PLN-1694 M2) — what the post-auth takeover just committed, carried
 * to the Sessions landing so it can acknowledge the sync it authorized.
 *
 * The level travels from the WRITE that succeeded rather than being re-read on
 * Sessions. Two reasons, and the second is the load-bearing one:
 *
 *  - The persisted signal is the `SyncObservabilityTier` (`full` /
 *    `metadata` / `local`), which is a different value set from the
 *    `DataSyncLevel` the consent copy is keyed by. Re-reading it would mean a
 *    second mapping between the two, and a second place for them to disagree.
 *  - "Which level is stored" and "which level did this user just choose" are
 *    different questions, and only the second one this banner is answering.
 *    Sessions must acknowledge an ARRIVAL, not report standing configuration —
 *    Settings → Connection Status is the permanent home for the latter.
 */
export type SyncConsentArrival = {
  level: SyncConsentLevel;
  /**
   * The org name the takeover itself named, or null when it did not resolve.
   * Taken from the takeover rather than re-derived so the two screens cannot
   * name different destinations for one answer.
   */
  workspaceName: string | null;
  /**
   * WHO answered. An arrival is only ever valid for one identity, and desktop
   * sign-out/sign-in is reachable in-session from Settings → Account — so
   * without this an arrival outlives the user who produced it and the landing
   * greets the next signed-in user with the previous one's org name and
   * consent level. The same reason `ConsentIdentity` exists on the gate.
   */
  userId: string | null;
  organizationId: string | null;
};

/** Whether an arrival was produced by the identity that is signed in now. */
export function isArrivalForIdentity(
  arrival: SyncConsentArrival | null,
  identity: { userId: string | null; organizationId: string | null }
): boolean {
  return (
    arrival !== null &&
    arrival.userId === identity.userId &&
    arrival.organizationId === identity.organizationId
  );
}

/**
 * `null` is the resting value and the honest one for every mount site without a
 * provider: the takeover's gate is the only thing that mounts one, and it only
 * mounts behind the `guest-onboarding` flag. So an install with the flag off —
 * and every app-shell suite that renders Sessions without the onboarding
 * chrome — reads "no arrival" and renders no banner, with no flag check of its
 * own to keep in step with the gate's.
 */
const SyncConsentArrivalContext = createContext<SyncConsentArrival | null>(
  null
);

export function SyncConsentArrivalProvider({
  arrival,
  children,
}: {
  arrival: SyncConsentArrival | null;
  children: ReactNode;
}) {
  return (
    <SyncConsentArrivalContext.Provider value={arrival}>
      {children}
    </SyncConsentArrivalContext.Provider>
  );
}

/** The consent answer given during THIS run, or null if none was. */
export function useSyncConsentArrival(): SyncConsentArrival | null {
  return useContext(SyncConsentArrivalContext);
}
