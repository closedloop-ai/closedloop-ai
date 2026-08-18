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
   * ISS-5981: the ingest received a status spelling this build does not model
   * and rewrote it to `active`.
   *
   * The rewrite is deliberate — an unmodelled value is not a terminal claim, so
   * the row stays live and the reaper plus the display staleness cutoff decide
   * whether it really is running. But it is still a value the code could not
   * interpret, coerced at the column, and the root `AGENTS.md` rule on bad data
   * is that such a coercion goes to a monitor rather than being absorbed. Before
   * the total fold this case was self-reporting: the raw spelling survived on
   * the column and rendered as the honest "Unknown" badge. It no longer does, so
   * without this counter a NEWER desktop introducing a status this cloud build
   * has never seen is silently recorded as running, forever, with no signal on
   * the column or in telemetry.
   *
   * ISS-5592 made this the ONLY status-fold metric: the retired counter it was
   * deliberately kept separate from is gone, along with the fold it measured.
   * A retired spelling now lands here like any other unmodelled one.
   *
   * What a non-zero value MEANS: version skew in the producer fleet, not
   * corruption. The actionable response is to decide whether the new spelling
   * should be modelled at all — ISS-5592 retired the alias map, so the choice is
   * a canonical member of `SESSION_STATUS` or nothing — not to repair rows — the fail-open already kept them reapable. The
   * event carries `unmodelledStatusSamples`, a bounded set of the raw spellings,
   * because that instruction is unactionable without them (wongk, #5047). They
   * are a LOG FIELD and must never become a metric tag — see the bound in
   * `status-fold-telemetry.ts`. Batch-aggregated on the same terms as
   * the batch, so an authenticated caller cannot drive one log per session.
   *
   * NOT YET ALERTABLE (wongk, #5047), and worth stating plainly because the root `AGENTS.md`
   * bad-data rule asks for a monitor rather than a log: per this module's header,
   * `emitTelemetryMetric` writes a structured log and nothing more. Making this
   * queryable needs a paired `datadog_logs_metric` generator and a
   * `datadog_monitor` in `closedloop-ai/cl-tofu-aws-live` (PRD-159), which is not
   * declarable from this repo and does not ship with this change. There is also
   * no already-monitored event in this family to point at instead — the whole
   * `SessionSyncMetric` set carries the same gap.
   *
   * So this closes the "silently coerced, no record anywhere" half of the rule
   * and leaves the alerting half open. Until the generator exists, do NOT read a
   * zero as evidence that no producer is sending an unmodelled status — an absent
   * generator and a clean fleet look identical. The signal is answerable only by
   * querying the logs directly.
   */
  UnmodelledStatusFolded: "agent_sessions.sync.unmodelled_status_folded",

  /**
   * FEA-1718: the `Loop.sessionArtifactId` back-link for an already-COMMITTED
   * session could not be applied — a lost unique race, or any transient database
   * failure in the post-commit claim.
   *
   * Counted and swallowed on purpose. The session itself is durable by the time
   * this runs, and the payload may carry further sessions; letting a derived
   * convenience edge abort the rest of a version-skewed multi-session batch is
   * exactly the "never block core flows because a peer is on a different
   * version" break the cross-repo rule forbids (wongk, review). The next sync of
   * the same session re-attempts the claim for free, so the loss is recoverable
   * as well as bounded.
   */
  LoopSessionBacklinkFailed: "agent_sessions.sync.loop_session_backlink_failed",
} as const;

export type SessionSyncMetric =
  (typeof SessionSyncMetric)[keyof typeof SessionSyncMetric];
