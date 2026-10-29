/**
 * ISS-10004 — what a diagnostics probe hands `DiagnosticsSurfaceV2` to render.
 *
 * Declared here rather than imported from a shell: `packages/app` must not
 * import `apps/*`, and the desktop wire contract
 * (`apps/desktop/src/shared/diagnostics-contract.ts`) is compiled into the main
 * process too. `diagnostics-payload-parity.test.ts` holds the two to one shape.
 *
 * Every OPTIONAL field below means the same thing: an absent key is "this
 * producer cannot tell you", which is not the empty value. Sections distinguish
 * the two rather than defaulting.
 */

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
 * ISS-5266: one measured hole in the corpus. A `null` instant means the window is
 * UNKNOWN, not zero-length; `null` tokens mean UNAVAILABLE, never zero.
 */
export type DiagnosticsWithheldRow = {
  rootRawId: string;
  sourcePath: string;
  withheldCount: number;
  reason: string;
  withheldTokens: number | null;
  withheldCacheTokens: number | null;
  earliestChildStartedAt: string | null;
  latestChildEndedAt: string | null;
  /** True when a withheld child carried no instants, so the bounds are a LOWER bound. */
  windowPartial: boolean;
  observedAt: string;
};

/**
 * ISS-5266: proof one store completed a full scan — what licenses reading an
 * empty `opencodeWithheld` as "nothing is withheld" rather than "nothing has
 * been imported" or "a reconcile failed".
 */
export type DiagnosticsWithheldScan = {
  sourcePath: string;
  observedAt: string;
};

/**
 * ISS-6758: the three confidence tiers sum to the SEGMENT-ATTRIBUTED share, never
 * to `totalSpendUsd`. `lowSample` is a caveat on a shown value, never a
 * suppressed or zeroed one.
 */
export type ActivityCoverageCell = {
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

export type ActivityCoverageBucket = {
  bucket: string;
  cell: ActivityCoverageCell;
};

export type ActivityCoverageAxis = {
  axis: string;
  buckets: ActivityCoverageBucket[];
};

/**
 * ISS-6758. An `axes` entry with no buckets means the axis exists but nothing has
 * rolled up on it — distinct from the payload being absent, which means the
 * producer could not report at all.
 */
export type ActivityCoverageData = {
  overall: ActivityCoverageCell;
  axes: ActivityCoverageAxis[];
  /** Excluded under an OLDER formula, pending backfill. These DO converge. */
  staleSessionCount: number;
  /** Excluded under a NEWER formula. The backfill re-selects only rows that are
   * BEHIND, so these never converge on their own. */
  unrecognizedFormulaSessionCount: number;
};

/** What one settled diagnostics probe reported. */
export type DiagnosticsPayload = {
  repos: DiagnosticsRepoRow[];
  backfill: BackfillStats;
  linkStats: LinkStatsRow[];
  linkTotals: LinkTotals;
  /** Absent ⇒ this producer cannot report withheld rows. Empty ⇒ none are. */
  opencodeWithheld?: DiagnosticsWithheldRow[];
  /** Absent ⇒ cannot report scans. Empty ⇒ no store has completed one yet. */
  opencodeWithheldScans?: DiagnosticsWithheldScan[];
  /**
   * Absent ⇒ the coverage read did not run or could not answer. Present with
   * `overall.sessionCount === 0` ⇒ nothing has been rolled up yet.
   */
  activityCoverage?: ActivityCoverageData;
};

/**
 * Cohort-axis headings, resolved by the HOST — the keys are its own metric
 * module's `CohortAxis` vocabulary, and only that producer's suite can keep the
 * map honest (desktop: `test/activity-coverage-axis-labels.test.ts`). A map
 * declared here would drift into rendering a raw column name as a heading.
 */
export type ActivityCoverageAxisLabels = Readonly<Record<string, string>>;
