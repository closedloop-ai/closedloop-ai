export const FilterToken = {
  CommandQueued: "command_queued",
  CommandDispatched: "command_dispatched",
  WorkItemDroppedExpired: "work_item_dropped_expired",
  // session.ingestion.* metrics — cloud session-ingestion health (ISS-4543).
  // Detects an ingestion stall (a broken ingest boundary, a dead desktop fleet)
  // instead of the ~2 days ISS-4537 took to notice by manual inspection.
  // ISS-11449 retired `session.ingestion.policy_denied` and
  // `session.ingestion.org_lookup_miss` with the org session-sync policy they
  // were the only observers of.
  SessionIngestionStaleness: "session.ingestion.staleness",
  SessionIngestionStalledOrgs: "session.ingestion.stalled_orgs",
  SessionIngestionActiveOrgs: "session.ingestion.active_orgs",
  // session.fleet.* — platform-wide session and org totals for the Datadog
  // dashboard (ISS-12050), sampled by the same cron as session.ingestion.*.
  SessionFleetTotalSessions: "session.fleet.total_sessions",
  SessionFleetTotalOrgs: "session.fleet.total_orgs",
  // insights.dashboard.* — per-section dashboard read latency (ISS-7512).
  // `agent_sessions.dashboard.query_latency` covers the Sessions usage-summary
  // path only, so before this the /insights/* section routes had no success
  // latency signal and "which section is slow" could not be answered from
  // Datadog alone.
  InsightsDashboardSectionLatency: "insights.dashboard.section_latency",
  // The rollup that keeps the line above honest. The latency gauge is throttled
  // per (org, tag tuple) per window because an authenticated caller can drive
  // the path, so it is a SAMPLE; this counts the reads that sample stands for.
  // A separate token rather than a `count:` on the one above, because a
  // duration gauge and an occurrence count cannot share one metric name.
  InsightsDashboardSectionLatencySuppressed:
    "insights.dashboard.section_latency_suppressed",
  // api.github.delivery_coverage.* — per-repo PR data delivery coverage (PRD-683).
  // One structured repo-tick event carries the denominator, coverage numerator,
  // exclusions, fetch failures, budget deferrals, and unavailable/no-target
  // states that the Datadog monitor consumes.
  GitHubDeliveryCoverageRepoTick: "api.github.delivery_coverage.repo_tick",
  // data.invariant.* — recurring data-quality audit checks (ISS-4752).
  // Each invariant emits a gauge per cron run. Checks 1-5 are VIOLATION signals
  // (should be zero, and they page); 6-9 are steady-state gauges (anomaly
  // alerting only). The previous "1-4 / 5-6" split here was stale — corrected
  // with ISS-8515, which adds the ninth member below.
  // Companion datadog_logs_metric + datadog_monitor definitions required in
  // example-infrastructure before these produce queryable Datadog metrics.
  DataInvariantZeroCostSessions: "data.invariant.zero_cost_sessions",
  DataInvariantZeroCostBranches: "data.invariant.zero_cost_branches",
  DataInvariantUnbranchedPrs: "data.invariant.unbranched_prs",
  DataInvariantLinesFilesMismatch: "data.invariant.lines_files_mismatch",
  DataInvariantZeroEstimateWithReportedCost:
    "data.invariant.zero_estimate_with_reported_cost",
  DataInvariantDualLedgerBranches: "data.invariant.dual_ledger_branches",
  DataInvariantCostEstimateDivergence:
    "data.invariant.cost_estimate_divergence",
  DataInvariantEnrichmentPendingSessions:
    "data.invariant.enrichment_pending_sessions",
  DataInvariantEnrichmentPendingPrs: "data.invariant.enrichment_pending_prs",
  // ISS-8515: token-bearing sessions with NO stored cost, labelled by model. A
  // GAUGE — the cloud has no priceability list, so an unpriceable model and a
  // genuinely free session are indistinguishable here and neither may page.
  DataInvariantUnpricedTokenSessions: "data.invariant.unpriced_token_sessions",
  // ISS-9434: `artifacts` rows whose freeform `status` is outside the vocabulary
  // for their type/subtype. A GAUGE, and the replacement for the CHECK
  // constraint PLN-1978 §4 declined — with no storage-level guard this is the
  // only thing that catches the next cross-vocabulary write. Non-paging on
  // purpose: the census that sized the population covered one org, and a live
  // legacy `waiting` population is deliberately still in place, so a threshold
  // monitor here would fire every day.
  DataInvariantOffVocabularyArtifactStatuses:
    "data.invariant.off_vocabulary_artifact_statuses",
  // ISS-7781, re-pointed by ISS-11096: Google and Linear rows with no
  // access-token ciphertext, which fail every read closed now that the legacy
  // plaintext columns are dropped. A GAUGE, so it does not page through
  // `data_invariant_violations`. Its sibling `plaintext_retained` is retired.
  DataInvariantIntegrationTokensUnencrypted:
    "data.invariant.integration_tokens_unencrypted",
  // ISS-10989: projects whose assignee is a user in another organization. A
  // VIOLATION, like checks 1-5 — zero in production and the write is closed —
  // so it pages through `data_invariant_violations`, whose scope excludes only
  // the named steady-state gauges.
  DataInvariantCrossOrgProjectAssignees:
    "data.invariant.cross_org_project_assignees",
  // pensero.backfill.* — the scheduled delivery-points backfill (ISS-8761).
  // Before the scheduler existed, `runPenseroDeliveryBackfill` had no caller at
  // all: an org could configure a credential, see the settings card confirm it,
  // and never receive a delivery point. A scheduler that fails quietly is the
  // same bug wearing a cron entry, so every degraded outcome is emitted here
  // rather than left as a log line.
  //
  // Companion `datadog_logs_metric` + `datadog_monitor` definitions are
  // REQUIRED in `example-infrastructure` before these produce queryable metrics —
  // the same cross-repo dependency `data.invariant.*` carries above.
  PenseroBackfillRun: "pensero.backfill.run",
  PenseroBackfillDayFailed: "pensero.backfill.day_failed",
  PenseroBackfillDegraded: "pensero.backfill.degraded",
} as const;

export type FilterToken = (typeof FilterToken)[keyof typeof FilterToken];
