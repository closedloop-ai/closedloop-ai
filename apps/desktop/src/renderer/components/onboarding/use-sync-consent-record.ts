import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncConsentRecord } from "../../../shared/sync-consent";

/**
 * The consent record plus whether that answer is SETTLED.
 *
 * Split for the same reason {@link DesktopIdentityResolution} splits its own:
 * this hook feeds a decision that mounts something IRREVERSIBLE — a blocking,
 * non-dismissible modal. "Not read yet" and "read, and there is no consent" are
 * different answers, and collapsing them would flash the takeover over the app on
 * every launch during the IPC round trip, including for users who answered months
 * ago. The gate withholds until `isResolved`.
 */
type ConsentReadState = Readonly<{
  record: SyncConsentRecord | null;
  isResolved: boolean;
}>;

export type SyncConsentResolution = ConsentReadState &
  Readonly<{
    /**
     * Re-read the record from disk.
     *
     * Called after a successful write, because this hook re-reads on a change of
     * USER and an org switch is not one. Without it the in-memory record stays at
     * its mount-time value while disk moves on, and A → B → A suppresses the
     * takeover for A from a record that is now bound to B.
     */
    refresh: () => void;
  }>;

const UNRESOLVED: ConsentReadState = { record: null, isResolved: false };

/**
 * A settled "we could not read it": no bridge, or a rejected read.
 *
 * `tier: null` reads as "never consented", which would OPEN the takeover — the
 * wrong direction for a failure. The gate therefore treats a null `record` with
 * `isResolved: true` as "do not show", so a transport failure leaves the app
 * usable instead of walling it off behind a modal whose Save would also fail.
 */
const UNREADABLE: ConsentReadState = { record: null, isResolved: true };

/**
 * ISS-5489 — read whether this device has already answered the sync-consent
 * question, and for which org.
 *
 * Re-reads whenever `authedUserId` changes so a sign-out/sign-in with a different
 * account does not answer from the previous user's record.
 */
export function useSyncConsentRecord(
  authedUserId: string | null
): SyncConsentResolution {
  const [resolution, setResolution] = useState<ConsentReadState>(UNRESOLVED);
  /**
   * Which read owns the state. Bumped by every load and by unmount, so a read
   * superseded by a refresh (or by a user change) cannot land late and overwrite
   * the newer answer with a staler one.
   */
  const generationRef = useRef(0);

  const load = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    const read = window.desktopApi?.getSyncConsentRecord;
    if (!(authedUserId && read)) {
      // Signed out is a settled absence: there is no takeover to show and no
      // fetch to wait for, so callers must not hold a pending state here. No
      // bridge is settled too — see UNREADABLE.
      setResolution(UNREADABLE);
      return;
    }
    setResolution(UNRESOLVED);
    read()
      .then((record) => {
        if (isCurrent()) {
          setResolution({ record, isResolved: true });
        }
      })
      .catch(() => {
        if (isCurrent()) {
          setResolution(UNREADABLE);
        }
      });
  }, [authedUserId]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  return { ...resolution, refresh: load };
}
