/**
 * ISS-4946: telemetry metric names emitted by the desktop-sync upsert path.
 *
 * These are monitoring contract values, not free text — a monitor keys off the
 * exact string, so a typo at one site silently stops reporting rather than
 * failing. Defining them once means production and the tests that pin the
 * emission cannot drift, per AGENTS.md ("use shared constants for telemetry
 * keys", applied to tests as strictly as production code).
 *
 * Deliberately a lightweight module with no imports: the emission sites live
 * inside the per-session write path, and the tests that assert them should not
 * have to pull in the sync runtime to name a metric.
 *
 * NOTE: `emitTelemetryMetric` writes a structured log; turning one of these into
 * an alertable metric additionally requires a Datadog log-metric generator,
 * which lives out-of-repo. Adding a name here does not create a monitor.
 */
/*
 * ISS-5592 removed `RetiredStatusFolded` ("agent_sessions.sync.retired_status_folded")
 * and its `SessionSyncRetiredStatusFoldSource` split. It was ISS-4654's gate-3
 * producer-drain signal, counting how many `completed`/`abandoned` spellings the
 * ingest folded — and nothing folds them any more, so the counter could only ever
 * read zero.
 *
 * The skew it watched for is NOT unobserved: an inbound retired spelling is now
 * unrecognized, so it takes the fail-open branch and is counted by
 * `UnmodelledStatusFolded`, whose `unmodelledStatusSamples` carry the raw word.
 * A straggler producer therefore still shows up — under a different metric, with
 * more detail, and without a second counter to keep in step.
 */
export const SessionSyncMetric = {
  /**
   * A stored `sessionUpdatedAt` no clock could legitimately produce was replaced
   * by a plausible incoming value, unfreezing that row's guarded columns.
   */
  PoisonedWatermarkRepaired: "agent_sessions.sync.poisoned_watermark_repaired",
  /**
   * ISS-12552: a synced token event's stored agent owner
   * changed, a fill from no owner included, so the Desktop re-attributed usage
   * it had already sent.
   */
  TokenEventAgentOwnerChanged:
    "agent_sessions.sync.token_event_agent_owner_changed",
  /**
   * The equal-watermark tie-break preserved stored PR state against a snapshot
   * whose own evidence for that lane was empty. Usually correct (a stale
   * pre-link snapshot); indistinguishable on the wire from a genuine retraction,
   * which is why it is counted rather than absorbed.
   *
   * Counted only when the skip actually suppressed a write. A pre-link
   * -extraction snapshot carries neither `prs` nor `prRefs`, so both lanes were
   * going to write nothing and the tie costs nothing; including it would make
   * the metric measure traffic rather than the trade-off. See
   * `resolveSessionPullRequestWriteGate`'s `hasSuppressibleWrite`.
   */
  PrStatePreservedOnTie: "agent_sessions.sync.pr_state_preserved_on_tie",
  /**
   * ISS-11427: an ISS-8131 `sequence_assembling` hold reached its ceiling, so
   * the slice freed the staged chunk marker and applied the held payload
   * (`sequence-assembling-hold-ceiling.ts`). Non-zero means a staged sequence
   * stopped receiving chunks while its producer kept syncing the session.
   */
  SequenceAssemblingHoldExpired:
    "agent_sessions.sync.sequence_assembling_hold_expired",

  /**
   * ISS-8330 / ISS-8881: a component's usage bucket carried an invocation/error
   * count that the `int4` columns of `AgentComponentSessionUsage` cannot hold,
   * so that bucket was DROPPED rather than written.
   *
   * TWO ways to get here, and the wire can refuse neither. ISS-8330: folding a
   * shadowed-command rollup into the skill that survives it summed two addends
   * that were individually in range. ISS-8881: an un-merged single row arrived
   * over the wire already past the ceiling, on the arm the fold never touched —
   * and a rejecting bound there would 400 a whole 200-session batch (ISS-8051).
   *
   * Counted because the drop is a silent hole otherwise: the row is absent, and
   * these columns are `_sum`-ed into org rollups, so nothing downstream can
   * tell a dropped bucket from a component that was never used. The ceiling is
   * 2^31 invocations of one component in one session, so a non-zero count here
   * means a corrupt or synthetic payload, never real usage.
   *
   * ONE emission per REQUEST, from `upsertSessionsBatch`'s `finally`, never one
   * per session: the overflow is deterministic, so the desktop re-sends it on
   * every retry, and the wire caps neither `sessions` nor `components` — the
   * same amplification bound `SliceFailed` and the held-revision tally keep.
   */
  UsageCountOverflowDropped: "agent_sessions.sync.usage_count_overflow_dropped",

  /**
   * ISS-8881: a session carried a counter that its Postgres `int4` column cannot
   * hold — `turns` / `steeringEpisodes` on `SessionDetail`, or one of the five
   * counters on `AgentSessionUsageRollup` — so that FIELD was omitted from the
   * write rather than clamped to the ceiling.
   *
   * Distinct from `UsageCountOverflowDropped` above, which counts component
   * USAGE BUCKETS on a different table. Counted for the same reason: the omission
   * is a silent hole otherwise. A nullable `SessionDetail` column simply keeps
   * its previous value; the rollup case is sharper — its five counters are
   * `Int @default(0)`, so a row that would have been CREATED is withheld
   * entirely rather than written with a fabricated `0`, and that session's
   * latency falls back to the wall-clock estimate in
   * `agent-components/analytics-service.ts`.
   *
   * A non-zero count means a corrupt or synthetic payload, never real usage:
   * 2^31 turns in one session is not reachable. Before this, the write raised
   * `22003` and failed the slice on every retry, so the session never landed at
   * all.
   *
   * ONE emission per REQUEST, from `upsertSessionsBatch`'s `finally`, never one
   * per session — the same amplification bound `SliceFailed`, the held-revision
   * tally and `UsageCountOverflowDropped` keep.
   */
  UnstorableCounterDropped: "agent_sessions.sync.unstorable_counter_dropped",

  /**
   * ISS-8271: a session arrived carrying a revision outside the committable
   * window — a desktop sentinel (`-1` import-pending in any shape, `0`
   * maintenance-stale in chunked shape) or a revision above
   * `MAX_SUPPORTED_DATA_REVISION` — and the apply HELD it: nothing was written
   * and the id was left out of `persistedSessionIds`, so an opted-in desktop
   * re-sends it once the row heals. This replaces the batch-wide validation
   * 400 that permanently dead-lettered the session (and everything sharing its
   * batch). The event carries `reason` (`revision_pending` / `revision_too_new`).
   *
   * What a sustained non-zero rate MEANS: for `revision_pending`, one target's
   * import or maintenance pass is not healing (the session is held, not lost —
   * but held forever is a desktop bug to chase); for `revision_too_new`,
   * producer version skew ahead of this cloud build. Emitted ONCE per reason
   * per batch from the batch's `finally`, carrying the batch `count` — never
   * per row: held rows are re-sent by design, so a per-row emission would be
   * caller-drivable log amplification (whitlockk, #6120).
   */
  SentinelRevisionHeld: "agent_sessions.sync.sentinel_revision_held",

  UnmodelledStatusFolded: "agent_sessions.sync.unmodelled_status_folded",

  /**
   * ISS-8552 / ISS-8681: a payload carried a `sessionEndedAt` the apply refused
   * to persist — the row was written with no end rather than one it could not
   * stand behind. TWO refusals, counted together on purpose: the end
   * contradicted the row's own resolved status (ISS-8552), or it led server
   * receive time by more than `MAX_TRUSTED_FUTURE_SKEW_MS` and so came from a
   * badly wrong clock (ISS-8681). Both are the same actionable fact — a producer
   * is sending an end the ingest will not store — and splitting them would need
   * the diagnostic to know a reason it cannot see (it reads the payload's end
   * against the committed one).
   *
   * Separate from `UnmodelledStatusFolded` even though the commonest producer is
   * the same fail-open fold, because they describe different refusals and a
   * shared counter could not tell "this build cannot model the spelling" from
   * "the payload disagreed with itself". A batch can raise one, the other, or
   * both.
   *
   * What a non-zero value MEANS: a producer is emitting `{status: <non-terminal>,
   * endedAt: <instant>}` — either a version-skewed build whose spelling
   * `normalizeSessionStatus` fail-opens to `active`, or one that does not clear
   * `ended_at` when a run resumes — or (ISS-8681) it is emitting an `endedAt`
   * from a badly wrong clock, the same fleet condition
   * `PoisonedWatermarkRepaired` reports for `updatedAt`. Actionable at the
   * PRODUCER either way (the emission carries `computeTargetId`). A SUSTAINED
   * non-zero rate for one target is the shape worth chasing — a one-off is a
   * straggler delivery draining.
   *
   * Row repair differs by reason, so do not read this counter as "the fleet is
   * self-healing". The status contradiction heals on the row's own next sync
   * (that gate runs on every apply); a clock-skewed end that reached the column
   * BEFORE ISS-8681 stays there, because max-wins never walks `sessionEndedAt`
   * back — see `resolveStorableSessionEnd`.
   *
   * Batch-aggregated on the same amplification grounds as the status-fold
   * counter, and counted only where the gate actually dropped a non-null value,
   * so it measures contradictory payloads rather than sync traffic.
   *
   * NOT YET ALERTABLE — see this module's header.
   */
  ContradictorySessionEndDropped:
    "agent_sessions.sync.contradictory_session_end_dropped",

  ImplausibleCreatedAtDropped:
    "agent_sessions.sync.implausible_created_at_dropped",

  /**
   * Batch-level typed monitored-activity persistence, acknowledgement, and
   * held outcomes.
   *
   * ISS-9182: `targetRetryRequiredCount` is the held TOTAL and the four
   * `target*Count` disposition fields break it down, so a held candidate is in
   * two of those five fields and they do not sum to `count`. Splitting the
   * lump is what lets a monitor tell the four holds apart; before it,
   * attributing one took a production database query.
   */
  MonitoredActivityOutcomeRecorded:
    "agent_sessions.sync.monitored_activity_outcome_recorded",

  /**
   * How many of a batch's write slices threw while the batch continued past
   * them. ONE emission per batch — a 200-session payload would make a per-
   * session emission an amplification vector.
   *
   * A non-zero value means specific sessions the server cannot ingest, never a
   * server-wide fault: a batch where every slice threw is rejected as
   * `ingestion_failed` and emits nothing here. Only the sibling `Desktop agent
   * session slices failed` log says which rows and why.
   *
   * NOT YET ALERTABLE — see this module's header.
   */
  SliceFailed: "agent_sessions.sync.slice_failed",

  ObservedRepositoryRecorded:
    "agent_sessions.sync.observed_repository_recorded",

  /**
   * PLN-1775 M1: the post-commit discovery write for an already-COMMITTED batch
   * failed.
   *
   * Counted and swallowed because the sessions are durable by the time this
   * runs, and a discovery candidate is recoverable for free — the next sync of the same
   * session observes the same repositories again.
   */
  ObservedRepositoryWriteFailed:
    "agent_sessions.sync.observed_repository_write_failed",

  /**
   * ISS-8186: how many sessions a batch handed back to the next request because
   * it spent `SessionIngestWorkBudget.RuntimeMs` before reaching them.
   *
   * NOT a loss counter and not a rejection: the deferred ids are withheld from
   * the row-level ack echo, so the desktop's outbox keeps them queued and the
   * next request starts where this one stopped. Emitted only when the budget is
   * what ended the loop, so a zero is genuinely "no batch was over-long" rather
   * than "every batch fits" — the ObservedRepositoryRecorded precedent of never
   * counting a case the metric does not describe.
   *
   * What a non-zero value MEANS: a producer is batching more sessions into one
   * request than a request can apply. Sustained non-zero for the same compute
   * target is the actionable shape, because the desktop's `ack_omitted`
   * allowance is finite (5 consecutive omissions per row, 3 recoverable
   * dead-letter cycles): a batch needing more passes than that will dead-letter
   * its tail rather than converge, and the dead-letter is reported by the
   * desktop's own sync-failure diagnostic.
   *
   * NOT YET ALERTABLE — see this module's header.
   */
  IngestRuntimeBudgetDeferred:
    "agent_sessions.sync.ingest_runtime_budget_deferred",

  /**
   * ISS-8145: a session whose OWN write transaction could not finish inside its
   * deadline, so nothing it carried was committed.
   *
   * Distinct from `IngestRuntimeBudgetDeferred` above, which counts sessions a
   * request chose not to START because its per-REQUEST allowance was spent —
   * those are handed to the next request and converge. This one cannot converge
   * on its own: the payload and the deadline are both unchanged on the re-send,
   * so the desktop repeats it indefinitely until the session is split or the
   * write gets cheaper.
   *
   * Emitted from the paths that otherwise throw without a counter, which is the
   * single-session batch — `SliceFailed` fires only for a PARTIAL batch.
   *
   * NOT YET ALERTABLE — see this module's header.
   */
  IngestSessionDeadlineExceeded:
    "agent_sessions.sync.ingest_session_deadline_exceeded",

  SessionWithheldFromAck: "agent_sessions.sync.session_withheld_from_ack",

  ActivityTilingSliceRefused:
    "agent_sessions.sync.activity_tiling_slice_refused",

  OrphanedChunkMarkerCleared:
    "agent_sessions.sync.orphaned_chunk_marker_cleared",

  OrphanedChunkMarkerSkippedUnconfirmedAck:
    "agent_sessions.sync.orphaned_chunk_marker_skipped_unconfirmed_ack",

  /**
   * ISS-8622 (PRD-699 §8.3): a sync request arrived WITHOUT
   * `wantsAcceptedSessionIds`, so this batch is acked whole rather than row by
   * row.
   *
   * NOT a fault and nothing is degraded by it — the whole-batch ack is the
   * contract these builds were written against and the server honors it. What
   * it measures is PRODUCER BAND. `buildAgentSessionSyncBatch` is the one
   * envelope builder the desktop has (ISS-7775) and it sets the flag
   * unconditionally, so a request without it is a build older than #4862 and
   * nothing else — there is no in-fleet path that legitimately omits it. The
   * server cannot mistake a stripped field for an absent one either: the
   * `wantsAcceptedSessionIdsKeyCovered` guard in
   * `lib/desktop-agent-sessions-schema-guards.ts` fails `tsc` if the key ever
   * leaves the payload schema, which is the only other way absence could arise.
   *
   * What a sustained non-zero rate MEANS: desktop builds predating row-level ack
   * are still syncing, and everything gated on their absence is still blocked.
   * Those builds get whole-batch ack semantics — a no-echo 200 durably clears
   * every id they sent, which is why `assertHoldExpressible` rejects their batch
   * up front rather than holding a row, and why `reportSessionOmissions` stays
   * silent for them. PRD-699 §8.3's next step (the server REQUIRING the flag)
   * is gated on this reaching zero; do not take it while this is non-zero,
   * because taking it turns every counted request into a hard 400.
   *
   * A bucketed `sum(count)` IS the distinct-target reading, by construction
   * rather than by instruction (#7410 review). The question is how many legacy TARGETS remain,
   * never how many requests they sent: one chatty target would otherwise outrun
   * a hundred quiet ones, the same rows-versus-targets confusion the
   * `OrphanedChunkMarkerSkippedUnconfirmedAck` floor above invites. The emission
   * rides an (org, target) fixed window, so a target stamps `count: 1` at most
   * once per window and the repeats fold into a rollup carrying `occurrences`
   * and NO `count` — which is what keeps the two readings from contaminating
   * each other.
   *
   * Read it BUCKETED, at or above the 60s window: `sum(count)` per bucket is
   * the distinct legacy targets that synced in that bucket, which is the
   * fleet-upgrade time series. Summed across a WIDER range it is target-windows
   * and a target is counted once per minute it was active, so take the per-bucket
   * max or last, never the range sum. `sum(count) + sum(occurrences)` is request
   * volume on any range.
   *
   * `sessionCount` rides a first occurrence only, as the exposure a single
   * whole-batch ack covers, not as a second population — see the rollup in
   * `row-level-ack-contract-telemetry.ts` for why aggregating it would report
   * one stuck session once per retry.
   *
   * AT MOST ONE emission per (org, target) per window, from the single
   * `rowLevelAck` derivation in `upsertSessionsBatch` — never one per session
   * (`sessions` carries no cap since ISS-8051, so a per-row emission would be
   * caller-drivable log amplification, the bound `SliceFailed` and the
   * status-fold tally keep) and never from a second read of the field, so the
   * counter and the behavior it describes cannot diverge. Unlike its
   * anomaly-reporting neighbours, per-batch is NOT a sufficient bound here:
   * this fires on a normal expected request, so a legacy build would emit on
   * every sync for the entire migration window. Emitted BEFORE
   * `assertHoldExpressible`, which throws outside the batch `try`: a legacy
   * batch carrying a held revision is rejected there, and it is the population
   * most worth counting.
   *
   * NOT A DENOMINATOR, and there is no companion for one: this ingest emits no
   * per-request success metric, only `agent_sessions.sync.failed` on the reject
   * paths. So this answers "are legacy producers still out there" and cannot on
   * its own answer "what fraction of the fleet is legacy". It also counts only
   * requests that REACH the apply — a rate-limited, unparseable, or
   * policy-denied request is never seen here. And request volume read off the
   * rollups is a LOWER bound even among those: a suppressed count is
   * materialised by a later event on the same key, never by a clock, so a
   * target's final window stays pending until it syncs again or the keyspace
   * cap evicts it. The gating reading is unaffected — "did any record appear
   * for this target in this window" is answered by the first occurrence, which
   * is never suppressed.
   *
   * NOT YET ALERTABLE, on the same terms as every name in this family — see this
   * module's header. Do NOT read a zero as "the fleet is upgraded": an absent
   * log-metric generator and a fully upgraded fleet look identical.
   */
  RowLevelAckNotRequested: "agent_sessions.sync.row_level_ack_not_requested",

  /**
   * ISS-4965 (tamsinb review, #8391): a complete component-invocation
   * generation activated without its generation id being re-derived: a key was
   * projected (ISS-8736), or storage did not reproduce the id on rows carrying a
   * redaction marker (ISS-4965), and the generation has more than one part, so
   * no raw wire copy was left to check. Carried on the skip warn itself
   * (`completeGenerationIfReady`), once per completing request.
   *
   * Non-zero is expected for a projected key, and while Desktop builds older than
   * ISS-4965 sync secret-bearing definitions. On a marker-bearing generation it
   * can also be a real producer/cloud drift, which this check would otherwise
   * have rejected as `generation_conflict`.
   */
  InvocationGenerationHashUnverified:
    "agent_sessions.sync.invocation_generation_hash_unverified",

  /**
   * ISS-12781 (marisolashgrove review, #9039): a complete component-invocation
   * generation was activated. Carries what the row delta did
   * (`ActivationDelta`), once per activation, after the transaction commits.
   */
  InvocationGenerationActivated:
    "agent_sessions.sync.invocation_generation_activated",
} as const;

export type SessionSyncMetric =
  (typeof SessionSyncMetric)[keyof typeof SessionSyncMetric];

/**
 * ISS-8881 (marisolashgrove review): the table prefix a dropped counter is reported
 * under in `UnstorableCounterDropped`'s `fields`.
 *
 * ONE metric carries two very different outcomes, and the bare column name
 * cannot tell them apart. A `sessionDetail.*` field was omitted from a row that
 * still writes, leaving that nullable column at its previous value; a
 * `usageRollup.*` field withholds the ENTIRE rollup row — tokens, cost,
 * `runtimeMs`, and all five counters — because those columns are `Int @default(0)`
 * NOT NULL and can express neither absent nor unknown. An operator reading
 * `fields: ["eventCount"]` has to know which happened to know what is missing.
 *
 * Constants rather than literals for the reason the metric names above are: the
 * producer (`persist-session-children.ts`) and the tests that pin the emission
 * are different files, and a typo in either goes unnoticed.
 */
export const UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX = "sessionDetail.";

/** Rollup half of {@link UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}. */
export const UNSTORABLE_ROLLUP_FIELD_PREFIX = "usageRollup.";
