import { agentSessionAlwaysConvergePrefixes } from "@repo/app/agents/hooks/agent-session-cache-convergence";
import { useLiveQueryBridge } from "@repo/app/shared/hooks/use-live-query-bridge";
import { isQueryKeyPrefixOf } from "@repo/app/shared/query/list-cache-convergence";
import {
  notifyManager,
  type Query,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  deliveredSessions,
  pendingSessions,
} from "../components/sessions/cloud-sync-pending-sessions";
import {
  type CloudSyncProgress,
  useCloudSyncProgress,
} from "../hooks/use-cloud-sync-progress";

/**
 * Refreshes the CLOUD Sessions reads while this machine's upsync is landing
 * rows — and only then.
 *
 * In cloud mode the Sessions views read the HTTP source, which exposes no
 * `subscribe`, so `AgentSessionsLiveBridge` is inert and nothing on the page
 * ever refetched: a user who signed in and watched their own history upload saw
 * an empty list until they changed a filter (which swapped the query key) or hit
 * Refresh. The missing piece is not a server signal — THIS app drives the sync,
 * so it already knows. `AgentSessionSyncProgress` rides the shared
 * runtime-status poll that the Sessions sync banner on the same page reads, and
 * a move in it is the trigger.
 *
 * MOVEMENT, not a cadence: a quiet lane produces a constant sample and this
 * bridge emits nothing, so an idle desktop makes no periodic cloud reads. Any
 * change to the measured tuple — sessions delivered, owed sessions, backfill
 * draining, caught-up — means the cloud copy may have moved, so every Sessions
 * read the convergence contract classifies `always` is invalidated (only
 * queries with mounted observers refetch; an unmounted Sessions view is merely
 * marked stale).
 *
 * ISS-9553: which reads those are is NOT written here. This bridge is a third
 * consumer of `agentSessionCacheConvergence`, alongside AgentSessionsLiveBridge
 * and its own observed-read gate below, so a family added to the contract
 * converges in cloud mode without this file changing. It previously restated the
 * three prefixes inline, which is the same hand-maintained list that shipped
 * each newly added family uninvalidated.
 *
 * A rise in owed work is a trigger too, not just a fall: the lane is sampled
 * once a second, so a small burst can be queued and drained between two samples,
 * and waiting for a fall alone would miss it.
 *
 * The DELIVERED count is what makes the tuple a delivery signal rather than a
 * queue-depth one, and it is load-bearing (ISS-9184). The owed count is a LEVEL:
 * during an import the parser refills the queue as fast as the lane drains it,
 * so batch after batch lands in the cloud while the depth reads the same number
 * and the two samples compare equal. On the fresh-install run that found this,
 * 201 of 331 delivering batches — 296 of 769 sessions — arrived under an
 * unchanged tuple, including a five-minute stretch pinned at zero owed while 67
 * sessions landed. Owed depth only tracks delivery while a queue drains
 * monotonically, which is the tail of a backfill and not the part where rows are
 * actually arriving. `deliveredSessions` is counted at the verified ack — the
 * one place delivery is proven — and is monotone under an identity, so it moves
 * once per landed batch and never on a backoff, a withhold, or a dead-letter.
 *
 * Throttling and the tab-visibility gate are NOT reimplemented here — the
 * movement is emitted into {@link useLiveQueryBridge}, the same engine the push
 * bridges run on, so a burst collapses into one trailing flush and a hidden
 * window defers its refresh until it is shown again instead of refetching the
 * cloud API every throttle window behind the user's back.
 *
 * The runtime-status subscription is gated on a Sessions read actually being
 * observed (see {@link useSessionsReadsObserved}). This component is mounted at
 * the app-core root, and that poll is a 1s IPC round-trip whose handler does
 * real work on main, so subscribing unconditionally would hold it open for the
 * whole signed-in session on every screen — the thing every other consumer of
 * this poll deliberately bounds. There is deliberately NO caught-up latch: the
 * lane moves again on every later incremental sync, which is exactly what this
 * bridge exists to show.
 *
 * Unmeasured is not zero: `pendingSessions` returns null for an unidentified
 * device, an older main process, or a corrupt count, and a null sample is not a
 * movement — it never triggers a refresh, in either direction.
 *
 * Renders nothing.
 */
export function CloudSessionsSyncBridge() {
  const queryClient = useQueryClient();
  const observed = useSessionsReadsObserved(queryClient);
  const progress = useCloudSyncProgress(observed);
  const signal = syncMovementSignal(progress);
  const emitRef = useRef<((movement: SyncLaneMovement) => void) | null>(null);
  const lastSignalRef = useRef<string | null>(null);

  const subscribe = useCallback(
    (onMovement: (movement: SyncLaneMovement) => void) => {
      emitRef.current = onMovement;
      return () => {
        emitRef.current = null;
      };
    },
    []
  );

  useLiveQueryBridge<SyncLaneMovement>({
    subscribe,
    // The lane reports counts, never which session moved, so every movement is
    // broad. Details are left alone: this bridge refreshes the list surfaces.
    getChangeId: () => undefined,
    flush: () => {
      // `flush` is synchronous, so these refreshes are fire-and-forget; a failed
      // refetch surfaces through the invalidated query's own error state.
      for (const queryKey of agentSessionAlwaysConvergePrefixes()) {
        queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
      }
    },
  });

  useEffect(() => {
    if (signal === null) {
      // Nothing measured — including the case where the poll is not subscribed
      // at all. Drop the baseline so re-arming compares two live samples rather
      // than reading the gap as movement.
      lastSignalRef.current = null;
      return;
    }
    const previous = lastSignalRef.current;
    lastSignalRef.current = signal;
    // The first measured sample is the baseline, not a movement: the queries
    // this would refresh have just fetched.
    if (previous === null || previous === signal) {
      return;
    }
    emitRef.current?.({});
  }, [signal]);

  return null;
}

/** One movement of the sync lane. Carries no id — the lane reports counts. */
type SyncLaneMovement = Record<string, never>;

/**
 * Whether any Sessions list read currently has a mounted observer — i.e.
 * whether a refresh would reach a screen.
 *
 * Subscribing to the query cache rather than a route or a mount site keeps the
 * answer honest for the surfaces that actually read these keys, on both the
 * Sessions view and anything else that mounts one, without this app-root
 * component having to know which those are.
 */
function useSessionsReadsObserved(queryClient: QueryClient): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient
        .getQueryCache()
        .subscribe(notifyManager.batchCalls(onStoreChange)),
    [queryClient]
  );
  const getSnapshot = useCallback(
    () =>
      queryClient
        .getQueryCache()
        .getAll()
        .some(
          (query) => query.getObserversCount() > 0 && isSessionsListQuery(query)
        ),
    [queryClient]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * True when `query` is one of the Sessions reads this bridge converges.
 *
 * Read from the same declaration the flush above uses, not a second hand-written
 * list (whitlockk review). The gate and the flush answer one question — "which
 * Sessions reads does a lane movement move?" — so a family added to
 * `agentSessionCacheConvergence` as `always` must widen BOTH. Two lists drift in
 * the direction that looks safe and is not: a family the gate omits keeps the
 * runtime-status poll unsubscribed while that read is the only one on screen, so
 * the flush that would have refreshed it never fires.
 *
 * The prefixes are still built per call rather than at module scope: this module
 * is imported by the app-core provider, so an import-time read of
 * `agentSessionKeys` would run inside every suite that mocks that module and
 * throw on the missing export before a single test executed.
 */
function isSessionsListQuery(query: Query): boolean {
  return agentSessionAlwaysConvergePrefixes().some((prefix) =>
    isQueryKeyPrefixOf(prefix, query.queryKey)
  );
}

/** The delivered segment for a sample whose lane cannot report deliveries. */
const UNMEASURED_DELIVERED = "-";

/**
 * The lane's measured state as one comparable value, or `null` when this sample
 * measured nothing. Two equal signals mean the lane did not move.
 *
 * THREE absences fold onto the placeholder, because `deliveredSessions` runs the
 * value through `optionalCountOrNull` -> `countOrNull`: the field is missing (a
 * main process predating ISS-7099), it is `null` (counts not yet attributable to
 * the current compute target, mid-identity-switch), or it carries a value that
 * cannot be a count (NaN, negative, non-finite). All three take the placeholder
 * rather than collapsing the whole sample to `null`, so an older main process
 * keeps exactly the owed-depth behaviour it had before this segment existed
 * instead of losing its refresh channel outright. The one edge that follows is
 * deliberate: the placeholder giving way to a number is itself a change, and a
 * newly hydrated identity is precisely when the list is missing rows.
 *
 * That is the OPPOSITE call from `pendingSessions` two files over, which
 * discards the whole sample on a corrupt count. The two differ because the
 * consequence differs: an unusable owed count makes the total unknowable and a
 * half-trusted total would be fabricated, whereas an unusable delivered count
 * costs only this one segment's contribution to a change detector that still has
 * three other segments. Refusing to refresh is the worse failure here.
 */
function syncMovementSignal(progress: CloudSyncProgress | null): string | null {
  const pending = pendingSessions(progress);
  if (progress === null || pending === null) {
    return null;
  }
  const delivered = deliveredSessions(progress) ?? UNMEASURED_DELIVERED;
  return `${pending}:${progress.backfilling}:${progress.caughtUp}:${delivered}`;
}
