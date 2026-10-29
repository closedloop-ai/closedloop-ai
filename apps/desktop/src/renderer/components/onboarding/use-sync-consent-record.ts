import { useCallback, useSyncExternalStore } from "react";
import type { SyncConsentRecord } from "../../../shared/sync-consent";
import { parseSyncConsentRecord } from "../../shared/sync-consent-record-boundary";
import {
  type BridgeStore,
  createBridgeStore,
} from "../../shared-agent-sessions/bridge-store";

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
     * The COMPATIBILITY path, kept deliberately. Main pushes every write on
     * {@link DESKTOP_SYNC_CONSENT_CHANGED_CHANNEL}, but an installed build's
     * preload may predate that channel — `onSyncConsentRecordChanged` is
     * optional for exactly that reason — and then a caller that just wrote is
     * the only thing that knows the answer moved. Calling it when the push
     * exists is harmless: both settle on the same record.
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

function settledSyncConsentRecord(raw: unknown): ConsentReadState {
  const record = parseSyncConsentRecord(raw);
  return record ? { record, isResolved: true } : UNREADABLE;
}

/** Whether the main-process consent bridge is exposed (false in partial test stubs). */
function hasSyncConsentBridge(): boolean {
  return typeof window.desktopApi?.getSyncConsentRecord === "function";
}

/**
 * ONE store for the whole renderer (see {@link createBridgeStore} for the shared
 * wiring/teardown contract).
 *
 * Module scope is the load-bearing part. Several surfaces read this record — the
 * consent takeover gate, the arrival invite nudge, and the Settings sync panel
 * through the host adapter's `refresh` — and while each held its own `useState`
 * the takeover's write reached only its own instance. A user who answered "Full"
 * kept being told sync was off for the rest of the run.
 *
 * Reading existing local database rows remains independent of consent, so
 * `resolveDesktopAppCoreMode` takes no consent term. Collection startup waits
 * for an explicit saved choice; cloud egress requires consent for the active org.
 *
 * A rejected pull resolves to {@link UNREADABLE} rather than rejecting: the store
 * stays on its current snapshot when a pull rejects, which would leave the
 * takeover's gate pending forever on a bridge that is simply broken.
 */
function createSyncConsentStore(): BridgeStore<ConsentReadState> {
  return createBridgeStore<ConsentReadState>({
    hasBridge: hasSyncConsentBridge,
    pull: () =>
      window.desktopApi
        .getSyncConsentRecord()
        .then(settledSyncConsentRecord)
        .catch((): ConsentReadState => UNREADABLE),
    // Optional-chained: an older preload has no push channel at all, and the
    // `refresh` above is what covers that build.
    subscribe: (onChange) =>
      window.desktopApi.onSyncConsentRecordChanged?.((record) =>
        onChange(settledSyncConsentRecord(record))
      ),
    initial: UNRESOLVED,
    fallback: UNREADABLE,
  });
}

let syncConsentStoreInstance: BridgeStore<ConsentReadState> | null = null;

/**
 * Built on first use, not at import: `hasBridge` is sampled when the store is
 * constructed, and a module evaluated before the preload has published
 * `window.desktopApi` would settle to the bridge-absent snapshot for good.
 */
function syncConsentStore(): BridgeStore<ConsentReadState> {
  syncConsentStoreInstance ??= createSyncConsentStore();
  return syncConsentStoreInstance;
}

const subscribeToSyncConsent = (onStoreChange: () => void) =>
  syncConsentStore().subscribe(onStoreChange);

const getSyncConsentSnapshot = () => syncConsentStore().getSnapshot();

/**
 * ISS-5489 — read whether this device has already answered the sync-consent
 * question, and for which org.
 *
 * Every call site shares one snapshot, kept current by main's push on each
 * write, so the answer the takeover commits is the answer every other surface
 * reads in the same run.
 *
 * The record is DEVICE-scoped, so `authedUserId` no longer keys a re-read: it
 * selects the signed-out short-circuit, and whether the recorded answer covers
 * the user's org is the caller's comparison (`hasRecordedSyncConsent`) against
 * the org, not the user. A sign-out/sign-in therefore cannot answer from the
 * previous account's record — the org moved, and the predicate sees it.
 */
export function useSyncConsentRecord(
  authedUserId: string | null
): SyncConsentResolution {
  const device = useDeviceSyncConsentRecord();
  // Account-scoped consumers must not inherit a signed-out device's answer.
  return authedUserId ? device : { ...UNREADABLE, refresh: device.refresh };
}

/** Read the settled device-local choice, including before an account exists. */
export function useDeviceSyncConsentRecord(): SyncConsentResolution {
  const shared = useSyncExternalStore(
    subscribeToSyncConsent,
    getSyncConsentSnapshot
  );
  const refresh = useCallback(() => {
    syncConsentStore().refresh();
  }, []);
  return { ...shared, refresh };
}
