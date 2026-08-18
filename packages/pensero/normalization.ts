/**
 * Pensero → Closedloop normalization contract (FEA-4174 / PRD-545).
 *
 * Pensero exposes delivery metrics keyed to a PERSON (an engineer). Value
 * Numerator 2.0 must express delivery value against OUR primary entities —
 * a SESSION, a BRANCH, or a PR — never against a person. This module is the
 * single, EXHAUSTIVE contract for that projection:
 *
 *   1. `PenseroMetric` — the closed const-object enum of the Pensero metrics
 *      we consume. Adding/removing a consumed metric happens here.
 *   2. `PENSERO_METRIC_NORMALIZATION` — a `Record<PenseroMetric, …>` (exhaustive
 *      by construction: a missing key fails `tsc`) declaring, per metric, the
 *      target entity it attributes to and how its value contributes to the
 *      numerator.
 *   3. `normalizePersonMetrics` — folds a person-keyed Pensero response into a
 *      flat list of entity-attributed contributions, dropping any records that
 *      lack the attribution key required by their target entity.
 *
 * Attribution key: Pensero records carry optional correlation ids that link a
 * person's delivery work to one of our entities (`sessionId`, `branchId`,
 * `prId`). A metric is only emitted when the id its target entity requires is
 * present — value is attributed to the session/branch/PR that produced it, not
 * to the person, and un-correlated records are skipped rather than mis-charged
 * to a person.
 */

/**
 * The primary Closedloop entities the numerator attributes value to. Person is
 * deliberately NOT a member: Pensero's person dimension is an input we project
 * away, never an attribution target.
 */
export const NumeratorEntity = {
  Session: "session",
  Branch: "branch",
  Pr: "pr",
} as const;
export type NumeratorEntity =
  (typeof NumeratorEntity)[keyof typeof NumeratorEntity];

/**
 * How a metric's raw value folds into the numerator. `additive` metrics sum
 * (throughput-like: shipped features, merged PRs); `quality` metrics are
 * value-weighted signals kept as an average-able contribution (review depth,
 * defect-freedom) rather than summed. Kept as a closed union so a new fold
 * mode forces an explicit decision at every consumer.
 */
export const NumeratorContribution = {
  Additive: "additive",
  Quality: "quality",
} as const;
export type NumeratorContribution =
  (typeof NumeratorContribution)[keyof typeof NumeratorContribution];

/**
 * The Pensero delivery metrics Value Numerator 2.0 consumes. Const object (not
 * a TS `enum`, per repo style); values are Pensero's wire metric keys. This is
 * the closed set — the normalization Record and the boundary schema are both
 * keyed by exactly these members, so adding one here surfaces every place that
 * must handle it as a `tsc` error.
 */
export const PenseroMetric = {
  /** Count of features/stories the person shipped to a delivered state. */
  DeliveredFeatures: "delivered_features",
  /** Count of PRs the person authored that merged. */
  MergedPullRequests: "merged_pull_requests",
  /** Count of code-review comments the person's work resolved. */
  ResolvedReviewComments: "resolved_review_comments",
  /** Normalized 0..1 review-thoroughness score for the person's changes. */
  ReviewThoroughness: "review_thoroughness",
  /** Normalized 0..1 defect-freedom score (1 = no post-merge defects). */
  DefectFreedom: "defect_freedom",
  /** Cycle time in hours from first commit to merge for the person's work. */
  CycleTimeHours: "cycle_time_hours",
} as const;
export type PenseroMetric = (typeof PenseroMetric)[keyof typeof PenseroMetric];

/**
 * Per-metric normalization rule. `entity` is which of our records the metric's
 * value is charged to; `contribution` is how it folds into the numerator;
 * `invert` marks metrics where a LOWER raw value is BETTER (cycle time), so the
 * numerator layer can normalize direction consistently.
 */
export type MetricNormalizationRule = {
  readonly entity: NumeratorEntity;
  readonly contribution: NumeratorContribution;
  readonly invert: boolean;
};

/**
 * EXHAUSTIVE contract: every consumed `PenseroMetric` maps to exactly one rule.
 * Typed as `Record<PenseroMetric, …>` so removing/renaming a metric or adding a
 * new one without a rule fails typecheck rather than silently dropping value.
 */
export const PENSERO_METRIC_NORMALIZATION: Record<
  PenseroMetric,
  MetricNormalizationRule
> = {
  [PenseroMetric.DeliveredFeatures]: {
    entity: NumeratorEntity.Branch,
    contribution: NumeratorContribution.Additive,
    invert: false,
  },
  [PenseroMetric.MergedPullRequests]: {
    entity: NumeratorEntity.Pr,
    contribution: NumeratorContribution.Additive,
    invert: false,
  },
  [PenseroMetric.ResolvedReviewComments]: {
    entity: NumeratorEntity.Pr,
    contribution: NumeratorContribution.Additive,
    invert: false,
  },
  [PenseroMetric.ReviewThoroughness]: {
    entity: NumeratorEntity.Pr,
    contribution: NumeratorContribution.Quality,
    invert: false,
  },
  [PenseroMetric.DefectFreedom]: {
    entity: NumeratorEntity.Branch,
    contribution: NumeratorContribution.Quality,
    invert: false,
  },
  [PenseroMetric.CycleTimeHours]: {
    entity: NumeratorEntity.Session,
    contribution: NumeratorContribution.Quality,
    invert: true,
  },
};

/**
 * Which correlation id a target entity requires to attribute a metric. A record
 * lacking its target's id is un-correlated and skipped (never charged to the
 * person). Exhaustive over `NumeratorEntity`.
 */
const ENTITY_ID_FIELD: Record<
  NumeratorEntity,
  "sessionId" | "branchId" | "prId"
> = {
  [NumeratorEntity.Session]: "sessionId",
  [NumeratorEntity.Branch]: "branchId",
  [NumeratorEntity.Pr]: "prId",
};

/**
 * One person's delivery record from Pensero, already validated at the client
 * boundary. `metrics` is a partial map of consumed metric → raw value (Pensero
 * omits metrics it has no data for). The correlation ids are optional; only the
 * one matching a metric's target entity is required for that metric to emit.
 */
export type PenseroPersonDeliveryRecord = {
  readonly personId: string;
  readonly sessionId?: string;
  readonly branchId?: string;
  readonly prId?: string;
  readonly metrics: Partial<Record<PenseroMetric, number>>;
};

/**
 * A single normalized contribution attributed to one of our entities — the
 * person dimension has been projected away.
 */
export type NormalizedMetricContribution = {
  readonly metric: PenseroMetric;
  readonly entity: NumeratorEntity;
  readonly entityId: string;
  readonly contribution: NumeratorContribution;
  readonly value: number;
  readonly invert: boolean;
};

/**
 * Project person-keyed Pensero delivery records onto entity-attributed
 * numerator contributions. For each record, each present consumed metric is
 * charged to the session/branch/PR named by its rule — but only when that
 * entity's correlation id is present on the record. Un-correlated metrics are
 * skipped (returned in neither list), so value is never mis-attributed to a
 * person.
 */
export function normalizePersonMetrics(
  records: readonly PenseroPersonDeliveryRecord[]
): NormalizedMetricContribution[] {
  const contributions: NormalizedMetricContribution[] = [];
  for (const record of records) {
    for (const key of Object.keys(record.metrics)) {
      // Guard the dispatch-table lookup against keys that are not consumed
      // metrics — an un-validated caller (this is exported public API) or a
      // raw JSON key like `__proto__`/`constructor` would otherwise resolve
      // through the prototype chain and either crash on `rule.entity` or
      // mis-index the table. `Object.hasOwn` accepts only real own members.
      if (!Object.hasOwn(PENSERO_METRIC_NORMALIZATION, key)) {
        continue;
      }
      const metric = key as PenseroMetric;
      const value = record.metrics[metric];
      if (value === undefined) {
        continue;
      }
      const rule = PENSERO_METRIC_NORMALIZATION[metric];
      const idField = ENTITY_ID_FIELD[rule.entity];
      const entityId = record[idField];
      if (!entityId) {
        // Un-correlated for this metric's target entity — skip rather than
        // charge the value to the person.
        continue;
      }
      contributions.push({
        metric,
        entity: rule.entity,
        entityId,
        contribution: rule.contribution,
        value,
        invert: rule.invert,
      });
    }
  }
  return contributions;
}
