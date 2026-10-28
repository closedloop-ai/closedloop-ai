/**
 * ISS-10667: the metrics the one-spelling-per-metric ruling governs, enumerated.
 *
 * The four canonical phrases and the three aliases already have owners — this
 * adds no spelling of its own, it imports every one. What it adds is a SHAPE
 * that cannot gain a metric silently: both maps below are exhaustive
 * `Record`s over the union, so a fifth metric fails `tsc` here before it can
 * reach a surface, and `metric-label-vocabulary.test.ts` derives its sets from
 * these rather than listing three constants it happened to know about
 * (marisolashgrove review on #7615).
 *
 * WHAT IT STILL DOES NOT CATCH: an alias constant declared beside its canonical
 * phrase and never joined to this union. Closing that needs the alias strings to
 * have no other declaration site, which is a wider move than this rollout.
 */

import {
  LOC_PER_DOLLAR_ALIAS_LABEL,
  MERGED_LOC_PER_DOLLAR_LABEL,
  PUSHED_LOC_PER_DOLLAR_LABEL,
} from "../utils/loc-per-dollar.ts";
import { TOTAL_ESTIMATED_COST_COPY } from "./total-estimated-cost-copy.ts";
import {
  TOTAL_TOKENS_ALIAS_LABEL,
  TOTAL_TOKENS_LABEL,
} from "./total-tokens-copy.ts";

export const CanonicalMetric = {
  TotalEstimatedCost: "total_estimated_cost",
  TotalTokens: "total_tokens",
  MergedLocPerDollar: "merged_loc_per_dollar",
  PushedLocPerDollar: "pushed_loc_per_dollar",
} as const;
export type CanonicalMetric =
  (typeof CanonicalMetric)[keyof typeof CanonicalMetric];

export const CANONICAL_METRIC_LABEL: Record<CanonicalMetric, string> = {
  [CanonicalMetric.TotalEstimatedCost]: TOTAL_ESTIMATED_COST_COPY.label,
  [CanonicalMetric.TotalTokens]: TOTAL_TOKENS_LABEL,
  [CanonicalMetric.MergedLocPerDollar]: MERGED_LOC_PER_DOLLAR_LABEL,
  [CanonicalMetric.PushedLocPerDollar]: PUSHED_LOC_PER_DOLLAR_LABEL,
};

/**
 * Ruling 7's short forms. The two ratio bases share one, which is the alias's
 * whole cost: it drops the basis R4a put first, so a surface rendering both
 * bases together may not reach for it.
 */
export const CANONICAL_METRIC_ALIAS_LABEL: Record<CanonicalMetric, string> = {
  [CanonicalMetric.TotalEstimatedCost]: TOTAL_ESTIMATED_COST_COPY.shortLabel,
  [CanonicalMetric.TotalTokens]: TOTAL_TOKENS_ALIAS_LABEL,
  [CanonicalMetric.MergedLocPerDollar]: LOC_PER_DOLLAR_ALIAS_LABEL,
  [CanonicalMetric.PushedLocPerDollar]: LOC_PER_DOLLAR_ALIAS_LABEL,
};
