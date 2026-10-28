import {
  CacheConvergence,
  type CacheConvergenceContract,
  convergingPrefixes,
} from "../../shared/query/list-cache-convergence";
import { agentSessionKeys } from "./agent-session-keys";

/**
 * ISS-9553 — how every agent-session cache family behaves when a live change
 * event flushes. This restates the policy the AgentSessionsLiveBridge used to
 * carry as an inline list of prefixes; the bridge now derives its invalidation
 * set from here, so a family added to `agentSessionKeys` fails `tsc` until it is
 * classified rather than shipping as a settled-looking stale view.
 */
export const agentSessionCacheConvergence: CacheConvergenceContract<
  typeof agentSessionKeys
> = {
  all: { prefix: CacheConvergence.Root },

  // Any session change can shift the visible page and the aggregate summary, and
  // the two surfaces read them differently: web reads the standalone
  // `list`/`usage` keys while desktop reads the combined `pageData` (FEA-4157 /
  // FEA-4177). All three must move or one surface's table or cards stay stale.
  lists: { prefix: CacheConvergence.Always },
  list: { coveredBy: "lists" },
  usages: { prefix: CacheConvergence.Always },
  usage: { coveredBy: "usages" },
  pageDataRoot: { prefix: CacheConvergence.Always },
  pageData: { coveredBy: "pageDataRoot" },

  // A scoped `{ sessionId }` change refreshes only that detail; a broad change
  // (import/rebuild/backfill) can touch any session, so it sweeps the prefix.
  details: { prefix: CacheConvergence.BroadOnly },
  detail: { coveredBy: "details" },
  // ISS-9857: the pages walked past a detail's event prefix sit under the same
  // `details` prefix, so every sweep that reaches the detail marks them stale
  // with it. Marking is not enough on its own: the walk is `enabled: false`, so
  // an invalidation never refetches it, and a tail append that leaves the
  // prefix boundary (and so the first cursor) unchanged re-keys nothing — a walk
  // at exhaustion would keep reporting "no more" over rows it never saw. The
  // bridge therefore also RESETS `eventsPagesOf` for each changed session
  // (`agent-sessions-live-bridge.tsx`), which returns the walk to "nothing
  // loaded yet": the note and the control come back, and the next click starts
  // from the refetched prefix.
  eventsPagesOf: { coveredBy: "details" },
  // ISS-10737: one session's invocation tree is keyed under that session's
  // detail prefix, so every sweep that reaches the detail already reaches it.
  // Unlike `eventsPagesOf` it needs no reset: the read is a single enabled
  // query over the whole tree, so an invalidation refetches it.
  invocationTree: { coveredBy: "details" },
  // ISS-10796: one session's collaborator read, keyed under that session's
  // detail prefix, so every sweep that reaches the detail reaches it. Like
  // `invocationTree` and unlike `eventsPagesOf` it needs no reset — the read is
  // a single enabled query over the whole result, so an invalidation refetches
  // it rather than stranding a partial walk.
  collaborators: { coveredBy: "details" },
  // ISS-11004: one session's Activity feed, under its detail prefix. An
  // infinite query, but enabled, so an invalidation refetches every loaded page
  // in order rather than stranding a partial walk; no reset needed.
  activity: { coveredBy: "details" },
  eventsPages: { coveredBy: "details" },

  // The sessions list's Repository FACET, not just the web Monitoring view: the
  // desktop `SessionsView` reads this aggregate and feeds `byRepository` into
  // the list's own facet whenever the usage summary reports no repositories
  // (`needsAnalyticsRepositoryFallback`, ISS-5273).
  //
  // davetho review: this was classified `excluded` on the argument that
  // `usages` converging is enough, because a refreshed summary carrying
  // repositories retires the fallback. That argument only covers the case where
  // the summary GAINS repositories. While it persistently reports none, the
  // fallback stays the facet's only source of options, and desktop holds this
  // query settled (`staleTime: Infinity`, no focus/reconnect refetch), so the
  // facet showed pre-sync repository options until remount.
  //
  // Converging it is self-limiting rather than a blanket re-issue of an
  // expensive read. `invalidateQueries` refetches only queries that are ACTIVE,
  // and query-core reads `enabled` when deciding that (`Query.isActive`), so on
  // the summary-has-repositories path — where SessionsView disables this read —
  // the flush marks the entry stale and issues nothing. The aggregate (measured
  // at 27.1s on a real 4,285-session corpus) is re-read only in the state where
  // it is already the sole thing populating the facet. It also fixes the handoff
  // in the other direction: the entry is now marked invalidated while disabled,
  // so a later flip back to the fallback re-reads instead of serving a
  // `staleTime: Infinity` entry from before the sync.
  //
  // ISS-9741 narrowed the residual that shipped with this classification, on the
  // one surface where it could be narrowed honestly: `useAgentSessionAnalytics`
  // hands its read TanStack's `AbortSignal` when — and only when — the active
  // source reports `cancelsInFlightReads`, which is the web shell's browser
  // `fetch` and nothing else. A superseded flush is genuinely torn down there.
  //
  // ISS-9802 narrowed it on the desktop LOCAL transport too, by giving the abort
  // something that can cross the bridge: a cancellation token the store thread
  // observes at the `yieldDbHostLoop()` checkpoints inside the aggregate. A
  // superseded flush now abandons the scan's REMAINING statements — the one
  // already inside the libSQL driver finishes first, because nothing at that
  // layer can interrupt it — so the stacking is bounded by a statement rather
  // than by the whole 27s scan.
  //
  // Desktop CLOUD mode still stacks: `cloud-api-adapter` reports
  // `honorsAbortSignal: false` and the signal reaches nothing on the far side of
  // `cloudApiFetch`, so that source keeps withholding it rather than trading
  // query-core's in-flight dedupe for a cancellation that never happens.
  analyticsRoot: { prefix: CacheConvergence.Always },
  analytics: { coveredBy: "analyticsRoot" },

  transcripts: {
    prefix: CacheConvergence.Excluded,
    reason:
      "Content-addressed rather than corpus-derived: transcript bytes live in S3 and the parsed-file key folds in `rawSha256`, so a re-upload lands under a new key instead of needing the old one invalidated.",
  },
  transcriptAccess: { coveredBy: "transcripts" },
  transcriptFile: { coveredBy: "transcripts" },
};

/**
 * Prefixes the sessions bridge invalidates on every flush.
 *
 * Resolved on call rather than at module scope, and that is load-bearing rather
 * than stylistic. The bridge only ever touched `agentSessionKeys` from inside
 * `flush`, so a test that partially mocks `use-agent-sessions` — several desktop
 * renderer suites do, to stub the hooks without restating the key object — could
 * import the bridge safely. Deriving at module scope turned that partial mock
 * into a suite-level `No "agentSessionKeys" export is defined` throw at import
 * time, taking down whole files that never exercise this bridge. Resolving here
 * restores the original access timing; the work is a walk of ~14 entries, at
 * most once per throttle window.
 */
export function agentSessionAlwaysConvergePrefixes() {
  return convergingPrefixes(
    agentSessionKeys,
    agentSessionCacheConvergence,
    CacheConvergence.Always
  );
}

/** Prefixes the sessions bridge sweeps wholesale on a BROAD change. */
export function agentSessionBroadConvergePrefixes() {
  return convergingPrefixes(
    agentSessionKeys,
    agentSessionCacheConvergence,
    CacheConvergence.BroadOnly
  );
}
