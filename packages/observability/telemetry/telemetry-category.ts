/**
 * @file telemetry-category.ts
 * @description The telemetry event-name vocabulary and its severity scale — the
 * names every producer and every Datadog monitor agree on.
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { INVOCATION_SYNC_MISSING_PARENTS_CATEGORY } from "@repo/api/src/types/invocation-sync-diagnostics";

// ---------------------------------------------------------------------------
// TelemetryCategory — grouped by origin
// ---------------------------------------------------------------------------

export const TelemetryCategory = {
  // Server-side categories
  CommandQueued: "command.queued",
  CommandDispatched: "command.dispatched",
  CommandAcknowledged: "command.acknowledged",
  CommandCompleted: "command.completed",
  CommandFailed: "command.failed",
  CommandTimedOut: "command.timed_out",
  CommandReplayed: "command.replayed",
  ConnectionSocketAccepted: "connection.socket_accepted",
  ConnectionRegistered: "connection.registered",
  ConnectionReconnecting: "connection.reconnecting",
  ConnectionResumed: "connection.resumed",
  ConnectionDegraded: "connection.degraded",
  ConnectionDisconnected: "connection.disconnected",
  ConnectionStaleHeartbeat: "connection.stale_heartbeat",
  TelemetryValidationFailed: "telemetry.validation_failed",
  InvocationSyncMissingParents: INVOCATION_SYNC_MISSING_PARENTS_CATEGORY,
  // Desktop-side categories
  JobStarted: "job.started",
  JobPlanSourceResolved: "job.plan_source_resolved",
  JobDecisionTableVerification: "job.decision_table_verification",
  JobCompleted: "job.completed",
  JobFailed: "job.failed",
  CommandTimeout: "command.timeout",
  CommandCancelled: "command.cancelled",
  CommandGatewayError: "command.gateway_error",
  DesktopOutboundNetworkDecision: "desktop.outbound_network_decision",
  DesktopShutdownFailed: "desktop.shutdown_failed",
  DesktopSupportUpload: "desktop.support_upload",
  PreflightBinaryNotFound: "preflight.binary_not_found",
  PreflightScriptNotFound: "preflight.script_not_found",
  PreflightSpawnFailed: "preflight.spawn_failed",
  ElectronUpdateInitiated: "electron_update.initiated",
  // ElectronUpdateSucceeded is emitted by Desktop update producers in apps/desktop.
  ElectronUpdateSucceeded: "electron_update.succeeded",
  // ElectronUpdateFailed is emitted by Desktop update producers in apps/desktop.
  ElectronUpdateFailed: "electron_update.failed",
  // ISS-6170 — a cloud-assigned distribution names a pack THIS desktop build can
  // never install, so the installer gave up retrying it. The device will not
  // converge until the user updates Desktop, and nothing else says so: the
  // per-distribution `failed` status the installer POSTs is a per-assignment
  // field nobody alerts on, and `gatewayLog` only reaches whoever is already
  // sitting at that machine — the same argument `collector-records-dropped-
  // telemetry.ts` makes.
  //
  // NOT A RATE. This is a STATE — an install whose compiled-in catalog seed is
  // behind what its org distributes — so the producer latches to at most ONE
  // event per permanent error code per process
  // (`apps/desktop/src/main/telemetry/distribution-install-terminal-telemetry.ts`).
  // A count or rate monitor is therefore unsound: one uninstallable pack and
  // twenty emit the same single event. Alert on PRESENCE.
  //
  // Same alerting note as `DbHostExitedUnexpectedly` below: alerting needs a
  // `datadog_monitor` in `example-infrastructure` querying
  // `service:cl-api env:prod @category:distribution.install_gave_up`. Not yet
  // landed.
  DistributionInstallGaveUp: "distribution.install_gave_up",
  PluginUpdateAttempted: "plugin_update.attempted",
  PluginUpdateSucceeded: "plugin_update.succeeded",
  PluginUpdateFailed: "plugin_update.failed",
  // Desktop onboarding popup events (AC-001)
  OnboardingPopupShown: "onboarding.popup_shown",
  OnboardingPopupCtaClicked: "onboarding.popup_cta_clicked",
  OnboardingPopupDismissedSession: "onboarding.popup_dismissed_session",
  OnboardingPopupDismissedPermanent: "onboarding.popup_dismissed_permanent",
  OnboardingPopupSuppressedAuto: "onboarding.popup_suppressed_auto",
  // PRD-254 — loop.perf.* telemetry categories (one outer category per
  // perf.jsonl event type plus a parse-failure warning channel).
  LoopPerfRun: "loop.perf.run",
  LoopPerfPhase: "loop.perf.phase",
  LoopPerfIteration: "loop.perf.iteration",
  LoopPerfPipelineStep: "loop.perf.pipeline_step",
  LoopPerfAgent: "loop.perf.agent",
  LoopPerfTool: "loop.perf.tool",
  LoopPerfSkill: "loop.perf.skill",
  LoopPerfSpawn: "loop.perf.spawn",
  LoopPerfParseFailure: "loop.perf.parse_failure",
  // FEA-1969 — desktop genai-prices could not price a model's token usage.
  TokenCostPricingMiss: "token_cost.pricing_miss",
  // FEA-1999 — desktop SQLite store integrity-health signal.
  StoreIntegrityFailureDetected: "store.integrity.failure_detected",
  StoreIntegrityFailurePersistent: "store.integrity.failure_persistent",
  StoreIntegrityRecovered: "store.integrity.recovered",
  StoreIntegrityHealthy: "store.integrity.healthy",
  // ISS-5387 — a desktop→cloud sync lane completed work while its DURABLE
  // cursor did not move. Reads and uploads keep succeeding; only persistence is
  // dead, so nothing else in the lane reports a failure (ISS-5347 ran this way
  // for three days behind 1,713 successful-looking log lines). Emitted at
  // `error` severity by the burn-down reporter, rate-limited per lane.
  SyncDurableCursorStalled: "sync.durable_cursor.stalled",
  // ISS-7496 — a desktop→cloud sync batch the server CONFIRMED could not be
  // measured for freshness, because no delivered row carried a readable
  // `updated_at` or the freshest one was ahead of the clock that acked it. The
  // `sync.freshest_session_lag_ms` span attribute is omitted in that case rather
  // than clamped, so without this category the install simply stops reporting
  // freshness and nothing says why. Emitted at `error` severity, carrying one of
  // two fixed content-free sentences.
  //
  // NOT A RATE. Both conditions are a STATE — a store whose rows carry no
  // readable `updated_at`, or a machine whose clock stepped backwards — so the
  // producer latches to at most ONE event per anomaly kind per process
  // (`apps/desktop/src/main/telemetry/sync-freshness-lag-telemetry.ts`). A count
  // or rate monitor on this category is therefore unsound: one bad batch and a
  // month of bad batches emit the same single event. Alert on PRESENCE, and read
  // it as "this install cannot measure freshness for this reason".
  //
  // Same alerting note as `DbHostExitedUnexpectedly` below: alerting needs a
  // `datadog_monitor` in `example-infrastructure` on
  // `@category:sync.freshest_session_lag.unmeasurable`. Not yet landed.
  SyncFreshestSessionLagUnmeasurable: "sync.freshest_session_lag.unmeasurable",
  // ISS-7730 — an untrustworthy persisted `lane_stalled_since`. Rationale, latching cadence, and alert wiring: `apps/desktop/src/main/telemetry/sync-lane-stall-clock-telemetry.ts`.
  SyncLaneStallClockInvalid: "sync.lane_stall_clock.invalid",
  // ISS-8179 — a durable agent-session outbox clear COMMITTED and then reported
  // a `deletedRowCount` its own boundary schema rejects: db-host IPC corruption
  // or a producer defect, which before this category was indistinguishable from
  // the expected version-skew reply that carries no count at all. Rationale,
  // latching cadence, and alert wiring:
  // `apps/desktop/src/main/telemetry/sync-outbox-clear-count-telemetry.ts`.
  SyncOutboxClearCountInvalid: "sync.outbox_clear_count.invalid",
  // ISS-5715 — the desktop db-host utility process exited while consumers were
  // still attached and nobody had asked it to stop. It takes ingestion (the
  // collectors, transcript sync) and the Sessions read path down together, and
  // only the read half is visible to a user, so ingestion can stop for the life
  // of the process behind a single log line. Emitted at `error` severity by the
  // db-host supervisor on the restart branch only — an intentional shutdown
  // exit is expected and stays off this channel.
  //
  // `severity` here is a queryable FIELD, not a log level: the api handler logs
  // every desktop telemetry event at `log.info`. Alerting on this category
  // therefore needs a `datadog_monitor` in `example-infrastructure` querying
  // `service:cl-api env:prod @category:desktop.db_host.exited_unexpectedly`,
  // exactly as the token-cost pricing-miss monitors do. Not yet landed.
  DbHostExitedUnexpectedly: "desktop.db_host.exited_unexpectedly",
  // ISS-8776 — the db-host restart ladder GAVE UP. Strictly rarer and strictly
  // worse than `DbHostExitedUnexpectedly` above, which says a replacement fork
  // is coming; this says none is, and the local store is gone for the rest of
  // that session. Kept as its own category precisely so a monitor on the
  // unrecoverable case is not diluted by the ordinary self-healing bounce.
  // Carries the same `diagnostics.dbHostExit` counters. Same alerting note as
  // `DbHostExitedUnexpectedly`: needs a `datadog_monitor` in `example-infrastructure`
  // on `@category:desktop.db_host.restart_exhausted`. Not yet landed, so until
  // it does this category is QUERYABLE AND NOT ALERTING — a permanently dead
  // local store shows up in a search nobody is running and pages nobody
  // (whitlockk, #6432). ISS-8242 owns landing the monitors for this family; the
  // user-facing half is not deferred with it — `onRestartExhausted` tells the
  // user directly through the Agent Monitor notification and the runtime status.
  DbHostRestartExhausted: "desktop.db_host.restart_exhausted",
  // ISS-7201 — main REFUSED a telemetry event the db-host child relayed, so what
  // that child was reporting is lost. Carries a bounded reason naming the
  // unroutable field and nothing else. Same alerting note as
  // `DbHostExitedUnexpectedly`: needs a `datadog_monitor` in `example-infrastructure`
  // on `@category:desktop.db_host.telemetry_refused`, grouped by
  // `@diagnostics.dbHostTelemetryRefused.reason`. Not yet landed.
  DbHostTelemetryRefused: "desktop.db_host.telemetry_refused",
  // ISS-8115 — main REFUSED a db-host child's reply to an `invoke` because it
  // did not match the boundary schema for that op. The reply path delivers the
  // child's structured clone verbatim and the main side is a forwarding Proxy
  // behind a single cast, so without this the wrong value simply travels: a
  // version-skewed child, a partially written reply, or a field that changed
  // type produces a wrong value deep in main with no context about where it came
  // from. Carries the bounded op path and nothing else — the rejected value is
  // precisely what could not be trusted. Same alerting note as
  // `DbHostExitedUnexpectedly`: needs a `datadog_monitor` in `example-infrastructure`
  // on `@category:desktop.db_host.reply_rejected`, grouped by
  // `@diagnostics.dbHostReplyRejected.op`. Not yet landed.
  DbHostReplyRejected: "desktop.db_host.reply_rejected",
  // ISS-6417 — a desktop collector permanently DROPPED records it had already
  // read off a harness transcript, because they carry a value the row cannot be
  // persisted without. Nothing throws and the local store stays healthy, so no
  // other signal fires: the records simply never exist, locally or upstream.
  // Emitted at `error` severity AFTER the commit that left them out, carrying a
  // bounded reason and a count only — the session, agent, and transcript path
  // stay in the desktop-local log, where an operator on that machine can act on
  // them.
  //
  // ISS-6999 widened the SCOPE this name implies: the category covers any
  // desktop-side record the process read and then permanently failed to
  // persist-or-ship, which includes the SYNC PRODUCER dropping component-usage
  // rows no payload part can carry — not only the ingestion collectors the name
  // was coined for. The reason is what identifies the stage, so triage by
  // `@diagnostics.collectorRecordsDropped.reason` rather than assuming the
  // category is collector-only.
  //
  // Same alerting note as `DbHostExitedUnexpectedly` above: alerting on this
  // category needs a `datadog_monitor` in `example-infrastructure` querying
  // `service:cl-api env:prod @category:collector.records_dropped`, grouped by
  // `@diagnostics.collectorRecordsDropped.reason` exactly as the token-cost
  // pricing-miss monitors group by their reason. Not yet landed.
  CollectorRecordsDropped: "collector.records_dropped",
  // ISS-7332 — persisted raw harness result envelopes dropped on load as corrupt:
  // silent, permanent loss of Claude's authoritative cost. Same alerting note as
  // above: the `example-infrastructure` monitor for this category is NOT yet landed.
  HarnessResultEnvelopesDropped: "cost.harness_result_envelopes_dropped",
  // ISS-9723 — the Desktop branch-trace builder dropped items the merged-trace
  // contract refused, so the trace it served is a SUBSET of what it built. A
  // separate category from `CollectorRecordsDropped` above because nothing was
  // lost: the source events are still in the local store and the same read
  // rebuilds the same drop next time. What is wrong is the PRODUCER that wrote
  // an item this contract cannot parse, and the remedy is to find it, not to
  // recover rows.
  //
  // PRESENCE, not rate — the reporter latches once per process, for the reason
  // its own module documents: branch detail is a polled read path, so a
  // per-occurrence emit would bill one corrupt session as a flood. A count or
  // rate monitor on this category is unsound.
  //
  // Same alerting note as `CollectorRecordsDropped` above: alerting needs a
  // `datadog_monitor` in `example-infrastructure` querying
  // `service:cl-api env:prod @category:branch_trace.items_unreadable`. Not yet
  // landed — that repository is outside this change.
  BranchTraceItemsUnreadable: "branch_trace.items_unreadable",
  // ISS-11351 — a local durable read the desktop depends on failed: the Sessions
  // usage/analytics aggregates, or the component lane's cursor and row reads.
  // Each degrades safely, so without this the failure reached only the local
  // log. PRESENCE, not rate: the producer latches once per read per process
  // (`apps/desktop/src/main/telemetry/local-read-failed-telemetry.ts`), and
  // cancellations, db-host lifecycle failures and store-op deadlines never
  // emit. The presence
  // monitor (`_modules/datadog/monitors/desktop-local-read-failed.tf` in
  // `example-infrastructure`) counts the category alone and is deliberately NOT
  // grouped by `@diagnostics.localReadFailed.read`: a `.by()` drops every event
  // that carries no `read` (a desktop newer than cl-api, or the enrichment
  // fallback in `apps/api/lib/desktop-telemetry-handler.ts`, which emits no
  // diagnostics). The read is in the log sample, not a monitor dimension.
  LocalReadFailed: "desktop.local_read.failed",
  // ISS-6331 — renderer-health signals. Three SEPARATE categories, because they
  // are three different conditions with three different remedies and a reader
  // must not have to unpack a field to tell them apart: the window hung with a
  // document loaded; the document never loaded at all; the reload breaker spent
  // its budget and stopped trying. Heartbeats keep reporting "healthy" through
  // all three, so without these the fleet dashboard reports a dead window as
  // live. Diagnostics ride `rendererHealth` below — counts and closed enums
  // only, plus one sanitizer-scrubbed detail string.
  RendererUnresponsive: "desktop.renderer.unresponsive",
  RendererLoadFailed: "desktop.renderer.load_failed",
  RendererReloadBudgetExhausted: "desktop.renderer.reload_budget_exhausted",
  // ISS-6339 — desktop SQLite PERFORMANCE, the axis the store-integrity family
  // above deliberately does not cover: an intact store can be unusably slow, and
  // until now nothing measured that. `StorePerfSample` is a periodic sample
  // carrying the statement-duration histogram bucketed by statement FAMILY plus
  // the store/WAL size gauges; `StoreMigrationStep` is one event per migration
  // executed at boot. Diagnostics ride `storePerf` / `migrationStep` below.
  //
  // Same alerting note as `CollectorRecordsDropped` above: alerting on a rising
  // slow-query rate needs a `datadog_monitor` in `example-infrastructure` querying
  // `service:cl-api env:prod @category:store.perf.sample` grouped by
  // `@diagnostics.storePerf.families.family`. Not yet landed.
  StorePerfSample: "store.perf.sample",
  StoreMigrationStep: "store.migration.step",
  // ISS-9418 (PRD-699 Appendix A) - a desktop sync lane crossed its 24h
  // ENVIRONMENTAL wall clock, and the paired event that says the give-up ended.
  // Distinct from `SyncDurableCursorStalled` above: that one reports a lane still
  // working whose progress is not being recorded, this one reports a lane that
  // deliberately abandoned work.
  //
  // TWO GIVE-UP SHAPES, and since PLN-2028 it is the (lane, PRODUCER) pair that
  // says which. `component_inventory` has one producer and is TERMINAL - the
  // give-up is the lane's stopping point, the tick returns and nothing is
  // attempted until a recovery door opens. `session_metadata` has two: its
  // environmental gate is terminal in that same sense, while its per-row ceiling
  // dead-letters the rows whose own clocks expired and terminates nothing
  // lane-wide, so the lane keeps attempting on its ordinary retry cadence. Each
  // shape follows its producer's architecture rather than anybody's opinion, so
  // it is derived from the pair at the producer and never passed in - `source`
  // carries the half `lane` cannot, which is why the grouping below names both.
  // The `message` spells out which shape it is either way.
  //
  // THIS IS THE ONLY CHANNEL. The give-up has no user-facing surface by explicit
  // decision (PLN-1961 D-a: background collection the user never asked for, and
  // the condition self-heals on the next sign-in, org-policy change, machine
  // switch, or backoff window), so nobody learns a lane stopped collecting
  // except through these two categories.
  //
  // A PAIR, and read them as a pair. Every `sync.lane.gave_up` is answered by
  // exactly one `sync.lane.rearmed` for that lane; an unanswered give-up on
  // `component_inventory` is a lane that is still stopped right now, and on
  // `session_metadata` it is whichever of the two `source` names - a gate
  // give-up still holding the whole lane, or a ceiling still abandoning rows
  // past their own budgets. The
  // latch is PROCESS-scoped, so an install that relaunches mid-outage resumes
  // the give-up from its durable row and announces it again - carrying the
  // persisted `reason` and `source` since PLN-2028, and omitting whichever of
  // them a pre-0091 row cannot supply - so a second `gave_up` before a `rearmed`
  // is that relaunch and not a second outage. The
  // producer latches once per
  // TRANSITION, not once per tick
  // (`apps/desktop/src/main/telemetry/sync-lane-give-up-telemetry.ts`), because a
  // given-up lane is asked whether it may attempt on every 5s tick and a
  // per-tick emit would be both a flood and a wrong count. So a rate monitor on
  // `gave_up` counts GIVE-UPS, which is what you want, and is sound.
  //
  // Same alerting note as `CollectorRecordsDropped` above: alerting needs a
  // `datadog_monitor` in `example-infrastructure` querying
  // `service:cl-api env:prod @category:sync.lane.gave_up`, grouped by
  // `@diagnostics.syncLaneGaveUp.lane` AND `.source` - PLN-2028: the session
  // lane has two producers, and `lane` alone puts a terminal outage and a
  // routine per-row ceiling in one bucket. Not yet landed - and note that the one
  // existing sync monitor (`sync.durable_cursor.stalled`, id 315255487) is MUTED
  // behind an indefinite `obs2_baseline:pending` downtime, so a companion PR
  // that lands this one muted buys nothing.
  SyncLaneGaveUp: "sync.lane.gave_up",
  SyncLaneReArmed: "sync.lane.rearmed",
} as const;

export type TelemetryCategory =
  (typeof TelemetryCategory)[keyof typeof TelemetryCategory];

// ---------------------------------------------------------------------------
// TelemetrySeverity
// ---------------------------------------------------------------------------

export const TelemetrySeverity = {
  Info: "info",
  Warn: "warn",
  Error: "error",
} as const;

export type TelemetrySeverity =
  (typeof TelemetrySeverity)[keyof typeof TelemetrySeverity];
