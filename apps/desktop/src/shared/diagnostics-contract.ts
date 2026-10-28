export type DiagnosticsRepoRow = {
  id: string;
  gitDir: string;
  remoteUrl: string | null;
  repoFullName: string | null;
  defaultBranch: string | null;
  lastSeenAt: string;
  worktreeCount: number;
};

export type BackfillStats = {
  artifactLinks: { totalScanned: number; lastScannedAt: string | null };
  /** Absent ⇒ this producer cannot report PR backfill scans. */
  prBackfill?: { totalScanned: number; lastScannedAt: string | null };
};

export type LinkStatsRow = {
  relation: string;
  method: string;
  count: number;
};

export type LinkTotals = {
  totalLinks: number;
  linkedSessions: number;
  linkedArtifacts: number;
};

/**
 * ISS-5266: one OpenCode subagent subtree the collector WITHHELD because its
 * root row could not be parsed, and therefore one measured hole in the corpus.
 *
 * `withheldCount` is EXACT, not estimated: the withheld children parsed
 * successfully and only their root did not, so the size of the under-count is
 * known. The instant fields are nullable because a child can carry no timestamp
 * — `null` there means the affected window is UNKNOWN, and a consumer must not
 * render it as a zero-length window.
 *
 * The presence of a row is the whole point: an empty `opencodeWithheld` says
 * "nothing is currently withheld", which is a different claim from "no session
 * had subagents" and from "nothing has been imported yet".
 */
export type DiagnosticsWithheldRow = {
  /** Unique only together with `sourcePath` — see the store's composite key. */
  rootRawId: string;
  sourcePath: string;
  withheldCount: number;
  reason: string;
  /**
   * BILLABLE tokens (input + output), the same basis as the dashboard headline
   * total this shortfall is quoted against. `null` means UNAVAILABLE (the
   * aggregate left the JS-safe integer range) and must never render as zero.
   */
  withheldTokens: number | null;
  /** Cache tokens (read + write), on their own basis. `null` is UNAVAILABLE. */
  withheldCacheTokens: number | null;
  earliestChildStartedAt: string | null;
  latestChildEndedAt: string | null;
  /**
   * True when a withheld child carried no instants, so the window bounds are a
   * LOWER BOUND on what is affected rather than its exact extent.
   */
  windowPartial: boolean;
  observedAt: string;
};

/**
 * ISS-5266: proof that one OpenCode store completed a full scan.
 *
 * An empty `opencodeWithheld` on its own is ambiguous three ways: nothing was
 * withheld, nothing has been imported, or a reconcile failed. Only the first is
 * "complete". A scan entry is written in the same transaction as the reconcile,
 * so its presence is what licenses the completeness reading, and `observedAt`
 * is what makes a store that has stopped reporting visible as a stale claim
 * rather than a silent contributor to a total presented as current.
 */
export type DiagnosticsWithheldScan = {
  sourcePath: string;
  observedAt: string;
};

/**
 * ISS-6758 (PRD-488 FR-12): one Coverage cell — a cohort bucket's re-aggregated
 * spend, its coverage ratio, and the reported-confidence distribution over the
 * SEGMENT-ATTRIBUTED share of that spend.
 *
 * `spendLowConfUsd + spendMediumConfUsd + spendHighConfUsd` sums to the
 * attributed spend, NOT to `totalSpendUsd`: spend in turns covered by no segment
 * (implicit `other`) belongs to no confidence bucket by construction, so the
 * three tiers fall short of the total whenever a session had gap spend. A
 * consumer must not present the three tiers as a partition of the total.
 *
 * `lowSample` is the metric module's own `MIN_COHORT_CELL_SESSIONS` rule: the
 * cell has too few sessions to read as a cohort signal. It is NOT "no data" —
 * the numbers are real, they are just thin — so it must render as a caveat on a
 * shown value, never as a suppressed or zeroed one.
 */
export type ActivityCoverageCell = {
  /** Covered = confident, non-`other`, non-`idle` spend, per the metric module. */
  coveredSpendUsd: number;
  totalSpendUsd: number;
  /** coveredSpendUsd / totalSpendUsd; 0 when the cell has no spend (guarded). */
  coverage: number;
  sessionCount: number;
  lowSample: boolean;
  spendLowConfUsd: number;
  spendMediumConfUsd: number;
  spendHighConfUsd: number;
};

/** ISS-6758: one bucket on one cohort axis (e.g. `claude_code` on `harness`). */
export type ActivityCoverageBucket = {
  /** The metric module's bucket key for this axis — already normalized. */
  bucket: string;
  cell: ActivityCoverageCell;
};

/**
 * ISS-6758: the display label for each cohort axis.
 *
 * Lives in the shared contract rather than in the tab because the axis keys are
 * the metric module's `CohortAxis` values, and the renderer must not import that
 * main-process module (it would pull the cost-math runtime into the browser
 * bundle). `activity-coverage-axis-labels.test.ts` reconciles this map against
 * `COHORT_AXIS_VALUES` from the main side, so a fifth axis fails there instead of
 * rendering a raw column name as a heading.
 */
export const ACTIVITY_COVERAGE_AXIS_LABELS: Readonly<Record<string, string>> = {
  harness: "Harness",
  autonomy_band: "Autonomy",
  closedloop_user: "ClosedLoop user",
  length_band: "Session length",
};

/** ISS-6758: one cohort axis and every bucket observed on it, key-ascending. */
export type ActivityCoverageAxis = {
  /** A `CohortAxis` value: `harness` / `autonomy_band` / `closedloop_user` / `length_band`. */
  axis: string;
  buckets: ActivityCoverageBucket[];
};

/**
 * ISS-6758 (PRD-488 FR-12): Coverage overall and sliced per cohort, read at
 * request time with a GROUP BY over the persisted `session_activity_metrics`
 * rows. This is the read FEA-2273 built that table for and that nothing
 * implemented until ISS-6758.
 *
 * An `axes` entry with no buckets means the axis exists but no session has been
 * rolled up yet — distinct from the whole payload being absent, which means the
 * producer could not report at all.
 */
export type ActivityCoverageData = {
  overall: ActivityCoverageCell;
  axes: ActivityCoverageAxis[];
  /**
   * Sessions EXCLUDED from every cell above because their row was computed under
   * an OLDER Coverage formula (`ATTRIBUTION_METRIC_VERSION`, ISS-6759) and the
   * boot backfill has not re-derived them yet. Summing them in would produce a
   * ratio neither formula would have produced, so they are dropped — and counted
   * here, because a silently narrowed corpus is indistinguishable from a
   * complete one. These DO converge: the backfill selects exactly this set.
   */
  staleSessionCount: number;
  /**
   * Sessions excluded for the opposite reason: their row was written by a NEWER
   * build, under a Coverage formula this one does not implement. Kept apart from
   * `staleSessionCount` because the backfill only re-selects rows that are
   * BEHIND, so these never converge on their own — telling a user they will be
   * re-derived on the next start would be a promise that never comes true.
   */
  unrecognizedFormulaSessionCount: number;
};

/**
 * ISS-6758: what the renderer asks the diagnostics read to include.
 *
 * Everything else in {@link DiagnosticsData} is a cheap metadata aggregate, but
 * the activity-coverage read scans a per-session table, and the panel polls
 * every 5 seconds behind a tab that is closed by default. Opting IN keeps that
 * cost with the users who can actually see the result; an absent/false flag is
 * the default and simply omits the field.
 */
export type DiagnosticsRequest = {
  includeActivityCoverage?: boolean;
};

export type DiagnosticsData = {
  repos: DiagnosticsRepoRow[];
  backfill: BackfillStats;
  linkStats: LinkStatsRow[];
  linkTotals: LinkTotals;
  /**
   * ISS-5266. OPTIONAL on purpose. The current producer always sets it (empty
   * when nothing is withheld), but the renderer receives this payload over IPC
   * and a payload without the key is a real, distinct answer: "this producer
   * cannot tell you". Making it required would force every such payload to be
   * read as an empty array — i.e. as "nothing is withheld" — which is precisely
   * the unknown-rendered-as-a-real-zero conflation this ticket removes.
   */
  opencodeWithheld?: DiagnosticsWithheldRow[];
  /**
   * ISS-5266. OPTIONAL for the same version-skew reason as `opencodeWithheld`:
   * a producer that cannot report scans must not be read as having reported
   * none. An empty array is the real answer "no store has completed a scan
   * yet", which the consumer must render as UNKNOWN, never as complete.
   */
  opencodeWithheldScans?: DiagnosticsWithheldScan[];
  /**
   * ISS-6758 (PRD-488 FR-12). OPTIONAL for the same version-skew reason as the
   * two fields above, and for one more: this read can legitimately fail on a
   * store the rest of the payload is fine on, and the producer omits the key
   * rather than send a zeroed shape. An absent key is "this producer cannot tell
   * you"; a present payload whose `overall.sessionCount` is 0 is the real answer
   * "nothing has been rolled up yet". Rendering the first as the second would
   * report full-coverage-of-nothing as a measured result.
   */
  activityCoverage?: ActivityCoverageData;
};
