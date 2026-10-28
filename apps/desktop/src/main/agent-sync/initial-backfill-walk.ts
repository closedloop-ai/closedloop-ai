/**
 * @file initial-backfill-walk.ts
 * @description FEA-2733 / FEA-3473 — the once-per-identity full-corpus
 * enumeration, its durable outbox seed, and the cursor persist that follows it.
 *
 * Hoisted out of `agent-session-sync-service.ts` by ISS-8116 for the reason its
 * siblings were (`backfill-queue-feed.ts`, `incremental-cursor-feed.ts`,
 * `agent-session-payload-preparation.ts`): that file is a shrink-only
 * grandfathered hotspot, and the guard this ticket adds is worth more behind an
 * injected-dependency seam, where it can be executed against synthetic inputs
 * rather than merely inspected. Behavior is unchanged by the move; the service
 * keeps a thin delegate that hands its own fields through.
 */

import type { SessionCursorRow } from "./agent-session-read-model.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";

/** The service state one initial walk reads and seeds, injected rather than reached for. */
export type InitialBackfillWalkDeps = {
  /** The source this pass opened; the enumeration reads it directly. */
  source: AgentSessionSyncSource;
  /**
   * ISS-8116: the pass guard, carrying the source-state generation AND the LIVE
   * source key. A compute-target/account switch moves identity without bumping
   * the generation, so the generation half alone cannot see it.
   */
  isCurrentSourceState: () => boolean;
  /**
   * ISS-8116 (davetho review): the same guard WITHOUT `shouldRun()`, for the
   * one site that must survive a readiness blip and must not survive an identity
   * move — the post-seed cursor persist.
   */
  isCurrentSourceIdentity: () => boolean;
  /** FEA-2733: false defers the historical walk to a top-slice cursor only. */
  historicalBackfillEnabled: boolean;
  /** Non-null when a cursor is already established for this identity. */
  readObservedTopUpdatedAt: () => string | null;
  markInitialPassRun: () => void;
  /** Adopt the enumerated watermark and the id set observed at it. */
  seedObservedTop: (rows: readonly SessionCursorRow[]) => number;
  /**
   * Append the enumerated ids to the backfill queue, returning the genuinely-new
   * ones. Deliberately NOT `feedIdsIntoBackfillQueue`: this walk dedups on the
   * backfill queue alone, where that feed also skips ids the incremental lane or
   * the dead-letter set is tracking.
   */
  enqueueBackfillRows: (rows: readonly SessionCursorRow[]) => string[];
  /** New backfill work preempts dead-letter retries. */
  resetDeadLetterRevisit: () => void;
  /** `hydratedSourceKey ?? live`, the precedence every durable writer uses. */
  resolveSourceKey: () => string | null;
  /**
   * ISS-8041: the durable seed and the cursor persist it orders, as the ONE call
   * `agent-session-sync-cursor-persist.ts` owns — splitting them let the identity
   * flip inside the seed's await and the persist then read the next identity's
   * watermark while writing under the previous one's key.
   *
   * ISS-8116: `isCurrentIdentity` is this pass's own predicate, handed down so the
   * persist half is refused when the LIVE source key moved. The persister's
   * internal generation counter catches a `stop()`/`start()` or a hydration-time
   * identity clear; it cannot see a bare compute-target flip that no pass has
   * observed yet, which is the case these guards exist for.
   */
  seedThenPersistInitialBackfill: (
    sourceKey: string,
    ids: string[],
    isCurrentIdentity: () => boolean
  ) => Promise<void>;
  logInfo: (message: string) => void;
};

/**
 * FEA-2733: enumerate the local corpus once per identity, seed the cursor, and
 * queue the historical backfill.
 *
 * ISS-8116: the enumeration is an AWAIT, and everything after it was
 * unconditional. It seeds `observedTopUpdatedAt` — the watermark a later
 * identity inherits when it is left unattributed — and durably seeds the outbox
 * under a key resolved from this same read, so a superseded enumeration queues
 * one account's corpus under another. Discarding re-arms nothing and costs
 * nothing: the watermark is still null, so the next pass re-walks.
 */
export async function runInitialBackfillWalk(
  deps: InitialBackfillWalkDeps
): Promise<void> {
  if (deps.readObservedTopUpdatedAt() !== null) {
    // FEA-2733: a cursor is already established for this identity — either a
    // prior tick's walk (which set the flag below) or a persisted cursor the
    // hydration just resumed on an already-synced restart (it seeds
    // `observedTopUpdatedAt` and skips this walk). Mark the initial pass complete
    // so a resumed session settles to "up to date" instead of latching on
    // "checking" forever.
    deps.markInitialPassRun();
    return;
  }

  const rows = await listInitialCursorRows(deps);
  if (!deps.isCurrentSourceState()) {
    return;
  }
  // FEA-2733: the initial enumeration has now run for this identity — even on an
  // empty store (no rows) — so `getSyncProgress()` can report "caught up" rather
  // than latching on a pre-walk "checking" state.
  deps.markInitialPassRun();
  if (rows.length === 0) {
    return;
  }

  const topIdCount = deps.seedObservedTop(rows);
  if (!deps.historicalBackfillEnabled) {
    deps.logInfo(
      `deferred historical backfill; initialized incremental cursor at ${rows[0].updated_at} with ${topIdCount} top session(s)`
    );
    return;
  }

  const newlyQueued = deps.enqueueBackfillRows(rows);
  deps.resetDeadLetterRevisit();
  deps.logInfo(`queued historical backfill for ${rows.length} agent sessions`);

  // ISS-8116 (davetho review): the persist half is re-guarded across the
  // durable seed, on the IDENTITY-only predicate.
  //
  // The earlier reasoning — that `sourceKey` and the cursor state were both
  // established under one identity, so a mid-seed move still persists
  // `sourceKey`'s OWN watermark — does not survive `stop()` → `start()`.
  // `stop()` clears the watermark, but a NEW pass under identity B can then
  // reseed `observedTopUpdatedAt` from B's corpus while A's seed is still
  // outstanding. A's continuation resumes, finds the watermark non-null again,
  // and writes B's cursor state under A's captured `sourceKey` — which on A's
  // next startup skips every A session below B's watermark.
  //
  // `isCurrentSourceIdentity` and not `isCurrentSourceState`: `shouldRun()` in
  // front of this durable write would drop the cursor on a readiness blip for no
  // benefit, which is the FEA-3473 anti-stranding ordering this call exists to
  // hold. It gates the PERSIST only — the seed itself lands under the key it was
  // called with and is correct either way.
  const sourceKey = deps.resolveSourceKey();
  if (sourceKey) {
    await deps.seedThenPersistInitialBackfill(
      sourceKey,
      newlyQueued,
      deps.isCurrentSourceIdentity
    );
  }
}

function listInitialCursorRows(
  deps: InitialBackfillWalkDeps
): SessionCursorRow[] | Promise<SessionCursorRow[]> {
  const { source } = deps;
  if (deps.historicalBackfillEnabled || !source.listTopSessionCursorRows) {
    return source.listAllSessionCursorRows();
  }
  return source.listTopSessionCursorRows();
}
