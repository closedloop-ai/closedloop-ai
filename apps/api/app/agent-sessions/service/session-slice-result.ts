/**
 * ISS-8619: the ingest slice's RESULT contract — what one session's apply
 * reports back to `upsert-sessions-batch.ts`.
 *
 * Its own module rather than a declaration inside `upsert-session-slice.ts`,
 * because BOTH the orchestrator and the phases it composes need it: the gating
 * phase's no-write arms ARE this shape, so leaving it in the composing file made
 * a leaf phase import back from the file that imports it (review: bug_hunter_b +
 * api-architect on #6798). A leaf type module has no such edge — nothing here
 * imports a phase, so the dependency arrow only ever points at this file.
 *
 * Every consumer of the type reads it here; `upsert-session-slice.ts` remains
 * the only export of the FUNCTION.
 */

import type { ActivityTilingSkipReason } from "./activity-segment-persistence";
import type { MonitoredActivityOutcomeCounts } from "./monitored-session-activity-persistence";
import type { SessionHoldReason } from "./wire-data-revision";

export type UpsertSessionSliceResult = {
  /** The slice reached the upsert, so its writes are part of this transaction. */
  persisted: boolean;
  /**
   * The slice committed, but an activity target is still unresolved and the
   * Desktop must retain this Session for a later idempotent retry.
   */
  retryRequired?: boolean;
  /** Typed candidate diagnostics retained through the batch acknowledgement decision. */
  monitoredActivityOutcomeCounts?: MonitoredActivityOutcomeCounts;
  /**
   * ISS-5981: the RAW spelling, when the payload carried one this build does not
   * model and the fold rewrote it to `active` — otherwise null.
   *
   * The value, not a boolean (whitlockk, #5047): the counter alone says skew is
   * happening but not what to do about it: the response is to fix the producer
   * (ISS-5592 retired the alias map, so there is no fold to teach). Without
   * carrying the spelling that decision cannot be made. The caller samples it under a bound; see
   * `status-fold-telemetry.ts`.
   */
  unmodelledStatus: string | null;
  /**
   * ISS-8552 / ISS-8681: THIS DELIVERY carried a `sessionEndedAt` the apply
   * refused to persist — because the end led receive time by more than the
   * trusted skew, or because the status the committing arm resolved is
   * non-terminal. The two are detected differently and neither detector can
   * stand in for the other: the skew refusal is read off the gate
   * ({@link didRefuseImplausibleSessionEnd}), because max-wins can preserve a
   * stored end and hide it from the read-back; the status refusal is read off
   * the committed row ({@link didDropContradictorySessionEnd}), because only the
   * database knows which arm ran. Both take the RAW payload end — never the
   * max-wins resolution, the gated value, or the pre-upsert `existing` read.
   *
   * REPORTED, not emitted, on exactly the grounds `unmodelledStatus` above
   * documents: one slice runs per session in a caller-supplied batch of up to
   * 200, so a per-row emit is the amplification `apps/api/AGENTS.md` forbids.
   * `status-fold-telemetry.ts` folds it into one count for the batch.
   *
   * A boolean, not the dropped Date: the actionable question is WHICH PRODUCER
   * is emitting the shape, which `computeTargetId` on the emission already
   * answers, and the instant itself is caller-supplied text with no bound.
   */
  droppedContradictorySessionEnd: boolean;
  /**
   * ISS-12251: THIS delivery carried a `createdAt` the apply refused to persist
   * because it did not parse or was implausible (`session-created-at.ts`).
   * Reported, not emitted, on the same amplification grounds as
   * `droppedContradictorySessionEnd`; the batch counts it. Optional so no-write
   * arms and older outcome shapes read as "nothing dropped".
   */
  droppedImplausibleCreatedAt?: boolean;
  /**
   * PLN-1775 M1: repositories this session named that the server holds no record
   * of — the discovery candidates of an org with no GitHub App installation
   * (ISS-7403).
   *
   * REPORTED, not written, from inside the transaction. The names are resolved
   * in the links phase because that is where the locked authority read already
   * happened, but the write belongs after the commit: an observation is a
   * derived convenience, and a Prisma interactive transaction cannot absorb a
   * failed write and carry on (AGENTS.md), so writing it there would let a
   * discovery row cost a durable session.
   */
  observedRepositoryFullNames: string[];
  /**
   * ISS-8069: how many of this slice's index-key columns had to be projected
   * down to `INDEX_KEY_MAX_BYTES` before they could be written.
   *
   * Counted only on the branch that actually WROTE — a foreign chunk reports
   * zero because it stored nothing, so the tally measures bound values that
   * landed rather than values the parser happened to see.
   */
  indexKeyProjections: number;
  /**
   * ISS-8330 / ISS-8881: the component keys whose usage bucket was DROPPED
   * because a count could not be stored in the `int4` ceiling of
   * `AgentComponentSessionUsage` — a phantom-fold merge since ISS-8330, and
   * since ISS-8881 an un-merged single row straight off the wire too.
   *
   * Carried rather than reported here for the same reason
   * `heldRevisionReason` is: the overflow is deterministic, so the desktop
   * re-sends it on every retry, and the `sessions` array carries no cap — a
   * per-slice emission would be caller-drivable log amplification. The batch
   * folds these into ONE emission per request.
   *
   * Optional like `heldRevisionReason` below, so partial fixtures and older
   * outcome shapes read as "nothing dropped" — the batch tally guards on
   * absence.
   */
  droppedOverflowUsageBuckets?: readonly string[];
  /**
   * ISS-8881: the counter fields this slice could not store — `turns` /
   * `steeringEpisodes` on `SessionDetail`, and the five `int4` counters on the
   * usage rollup. Each was OMITTED from its write rather than clamped, so the
   * column keeps its previous value (or, for a rollup that would have been
   * created, no row was written at all rather than one whose `@default(0)`
   * fabricates a measurement).
   *
   * Carried rather than reported here, and optional, for exactly the reasons
   * `droppedOverflowUsageBuckets` above is: the failure is deterministic and
   * re-sent on every retry, `sessions` carries no cap, and partial fixtures must
   * read as "nothing dropped".
   */
  unstorableCounterFields?: readonly string[];
  /**
   * ISS-8603: WHY this slice's activity-tiling append was refused — its spans
   * were dropped and the session committed a tiling short by that slice — or
   * `null`/absent when no refusal happened.
   *
   * A separate field rather than a reading of `persisted`, because the session
   * DID persist and only the tiling slice did not; and a separate field rather
   * than `persistSessionActivitySegments`' own return, because three distinct
   * refusals in that module share the one `false` it reports.
   *
   * The REASON rather than a boolean, so the metric stays facetable as the
   * guard's arms change — see `ActivityTilingSkipReason`, which ISS-10259 cut
   * back to one. The batch facets on it, the way `heldRevisionReason` below is
   * facetted.
   *
   * Carried rather than emitted here, and optional, for exactly the reasons
   * `unstorableCounterFields` above is: the refusal is deterministic, `sessions`
   * carries no cap, and partial fixtures must read as "nothing refused".
   */
  activityTilingSkipReason?: ActivityTilingSkipReason | null;
  /**
   * ISS-8271 / ISS-8781: non-null on EVERY no-write arm — nothing was written
   * and the id is withheld from the ack echo. It carried the revision-hold
   * reasons alone until ISS-8781 added `ForeignChunk`, which until then was
   * representable only as `persisted: false` with a NULL reason.
   *
   * TWO populations read it, and they are deliberately not the same set. The
   * `sentinel_revision_held` tally counts {@link SentinelHoldReason} only — a
   * foreign chunk is not a sentinel revision and must never enter that
   * monitoring contract. The ISS-8781 omission report attributes all of them.
   *
   * Tallied by the batch, never emitted per row: held rows are re-sent by design
   * (ack_omitted), so a per-row emission would be caller-drivable log
   * amplification (whitlockk, #6120). Optional like its neighbours so partial
   * fixtures and older outcome shapes read as "not held" — the batch tally
   * guards on truthiness.
   */
  heldRevisionReason?: SessionHoldReason | null;
  /**
   * ISS-12552: the session whose operation evidence this slice replaced. Its
   * evidence links are synced after the slice commits, outside the
   * transaction, because that sync waits on a remote flag read.
   */
  evidenceLinksSessionId?: string;
  /**
   * ISS-12552: other sessions whose receipt binding this slice changed, such
   * as a canonical copy that took the receipt or a displaced holder. Their
   * links are synced after the slice commits, with this session's.
   */
  evidenceBindingSessionIds?: readonly string[];
  /**
   * ISS-12552: the session whose implementation evidence is derived again
   * after the slice commits: its evidence snapshot changed or it names a
   * branch. Derived outside the transaction, behind the attribution flag.
   */
  implementationEvidenceSessionId?: string;
};
