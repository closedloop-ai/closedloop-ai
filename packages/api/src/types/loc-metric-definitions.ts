/**
 * ISS-9097: the one registry of record for every shipped LOC-per-dollar
 * definition — the label a surface renders AND the numerator, denominator and
 * population that label claims.
 *
 * The join is the point. Before this the two halves lived apart and keyed on
 * different things: the label constants (`../utils/loc-per-dollar.ts`) carried
 * no definition at all, `BRANCH_METRIC_DICTIONARY` carried a formula keyed on
 * `BranchMetricId`, and the Sessions sentences carried one keyed on
 * `MergedLocPerDollarBasis`. Nothing tied a rendered label to either, so the
 * Agents card, the Agents column, Agent detail, Session detail and Pack detail
 * all rendered the metric while naming no definition anywhere.
 *
 * Every string below is IMPORTED from the owner that already held it. This
 * module introduces no spelling of its own, which is what makes it a join
 * rather than a fifth place the words can drift; `no-unnamed-loc-metric-definition`
 * is the gate that keeps it the only one.
 *
 * It deliberately does NOT decide whether a label should state its scope — that
 * question is ISS-9097 item 3 and belongs to the CEO definition session. Both
 * spellings a surface can render today are carried side by side so the
 * `ONE_LABEL_PER_METRIC_FLAG_KEY` swap keeps choosing between them unchanged.
 */

import {
  LOC_PER_DOLLAR_LABEL,
  SESSION_DETAIL_LOC_PER_DOLLAR_DENOMINATOR,
  SESSION_DETAIL_LOC_PER_DOLLAR_POPULATION,
} from "../utils/loc-per-dollar.ts";
import {
  COMPONENT_LOC_PER_DOLLAR_DENOMINATOR,
  COMPONENT_LOC_PER_DOLLAR_NUMERATOR,
  COMPONENT_LOC_PER_DOLLAR_POPULATION,
} from "./agent-component.ts";
import { BRANCH_METRIC_DICTIONARY, BranchMetricId } from "./branch-metrics.ts";
import {
  CANONICAL_METRIC_LABEL,
  CanonicalMetric,
} from "./canonical-metric-vocabulary.ts";
import {
  MERGED_LOC_PER_DOLLAR_DENOMINATOR,
  MERGED_LOC_PER_DOLLAR_DETAIL_WITHOUT_BASIS,
  MERGED_LOC_PER_DOLLAR_NUMERATOR,
} from "./merged-loc-per-dollar-basis.ts";
import {
  NumeratorProvider,
  perDollarUnitLabelFor,
} from "./numerator-provider.ts";

/**
 * Every distinct LOC/$ definition this product ships, one member per FORMULA.
 *
 * Four branch members rather than one because the Branches surfaces divide four
 * different quantities, exactly as `BRANCH_METRIC_DICTIONARY` already records;
 * collapsing them here would file a surface under a formula it does not compute.
 */
export const LocMetricDefinitionId = {
  SessionMergedLoc: "session_merged_loc",
  SessionDetailMergedLoc: "session_detail_merged_loc",
  ComponentLinesChanged: "component_lines_changed",
  BranchListPublicationLoc: "branch_list_publication_loc",
  BranchDetailPublicationLoc: "branch_detail_publication_loc",
  BranchCanonicalPublicationLoc: "branch_canonical_publication_loc",
  BranchPushedLoc: "branch_pushed_loc",
} as const;
export type LocMetricDefinitionId =
  (typeof LocMetricDefinitionId)[keyof typeof LocMetricDefinitionId];

export type LocMetricDefinition = {
  id: LocMetricDefinitionId;
  /** The spelling shipped to every reader today. */
  label: string;
  /**
   * ISS-10667's one-phrase-per-metric spelling, rendered only where
   * `ONE_LABEL_PER_METRIC_FLAG_KEY` is on. Equal to {@link label} for a
   * definition that ruling did not move.
   */
  canonicalLabel: string;
  /** The compact unit a dense card prints beside the number. */
  unitLabel: string;
  numerator: string;
  denominator: string;
  population: string;
};

const BRANCH_LIST = BRANCH_METRIC_DICTIONARY[BranchMetricId.ListLocPerDollar];
const BRANCH_DETAIL =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.DetailLocPerDollar];
const BRANCH_CANONICAL =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.CanonicalLocPerDollar];
const BRANCH_PUSHED =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.PushedLocPerDollar];

/**
 * The compact `LOC/$` suffix, imported rather than respelled.
 *
 * `numerator-provider.ts` says its LOC arm "reproduces `LOC_PER_DOLLAR_LABEL`
 * exactly; that agreement is pinned by a test rather than by an import". A test
 * cannot stop a fourth spelling reaching a card, and the Branches card renders
 * this suffix beside a label the ticket measured as a different spelling of the
 * same metric — so the join takes the import.
 */
const LOC_UNIT_LABEL = perDollarUnitLabelFor(NumeratorProvider.Loc);

export const LOC_METRIC_DEFINITION = {
  [LocMetricDefinitionId.SessionMergedLoc]: {
    id: LocMetricDefinitionId.SessionMergedLoc,
    label: LOC_PER_DOLLAR_LABEL,
    canonicalLabel: CANONICAL_METRIC_LABEL[CanonicalMetric.MergedLocPerDollar],
    unitLabel: LOC_UNIT_LABEL,
    numerator: MERGED_LOC_PER_DOLLAR_NUMERATOR,
    denominator: MERGED_LOC_PER_DOLLAR_DENOMINATOR,
    population: MERGED_LOC_PER_DOLLAR_DETAIL_WITHOUT_BASIS,
  },
  /**
   * ONE session's ratio, which is NOT the summary one above.
   *
   * The Session detail Properties row and the detail KPI strip divide
   * `AgentSessionDetail.locPerDollar` — that session's merged authored lines
   * over that session's OWN estimated cost (ISS-9964 / ISS-9980, ruled
   * 2026-09-11). {@link LocMetricDefinitionId.SessionMergedLoc} takes its
   * denominator and population from `merged-loc-per-dollar-basis.ts`, whose
   * header scopes itself to the summary's `mergedLocPerDollar` "and nothing
   * else", so filing this row there records a formula it does not compute.
   *
   * BOTH LABELS are the summary's, deliberately. ISS-10667 moved this row to
   * "Merged LOC per $" too, and splitting the FORMULA must not withdraw that
   * ruling — what differs between the two entries is the denominator and the
   * population, never the words. The NUMERATOR is likewise the summary's
   * constant, not a copy: both count the session's merged gross lines, and one
   * owner is what stops the pair drifting.
   */
  [LocMetricDefinitionId.SessionDetailMergedLoc]: {
    id: LocMetricDefinitionId.SessionDetailMergedLoc,
    label: LOC_PER_DOLLAR_LABEL,
    canonicalLabel: CANONICAL_METRIC_LABEL[CanonicalMetric.MergedLocPerDollar],
    unitLabel: LOC_UNIT_LABEL,
    numerator: MERGED_LOC_PER_DOLLAR_NUMERATOR,
    denominator: SESSION_DETAIL_LOC_PER_DOLLAR_DENOMINATOR,
    population: SESSION_DETAIL_LOC_PER_DOLLAR_POPULATION,
  },
  /**
   * The Agents and Packs ratio, which is NOT the merged one above.
   *
   * `apps/api/app/agent-components/loc-per-dollar.ts` sums every session that
   * used the component and divides by those sessions' estimated cost — no merge
   * predicate anywhere in that path. Its own surfaces say so and refuse the
   * word: `agents-table.tsx` and `detail-data.ts` both carry an ISS-5366 note
   * that this column is "changed", not "merged", because the two populations
   * differ. A separate member because filing it under
   * {@link LocMetricDefinitionId.SessionMergedLoc} would record the merged
   * definition against a number nothing merge-gates, which is the exact drift
   * ISS-9097 exists to end.
   *
   * ISS-10667 moved no label here, so the canonical spelling is the shipped one.
   */
  [LocMetricDefinitionId.ComponentLinesChanged]: {
    id: LocMetricDefinitionId.ComponentLinesChanged,
    label: LOC_PER_DOLLAR_LABEL,
    canonicalLabel: LOC_PER_DOLLAR_LABEL,
    unitLabel: LOC_UNIT_LABEL,
    numerator: COMPONENT_LOC_PER_DOLLAR_NUMERATOR,
    denominator: COMPONENT_LOC_PER_DOLLAR_DENOMINATOR,
    population: COMPONENT_LOC_PER_DOLLAR_POPULATION,
  },
  [LocMetricDefinitionId.BranchListPublicationLoc]: {
    id: LocMetricDefinitionId.BranchListPublicationLoc,
    label: BRANCH_LIST.label,
    canonicalLabel: CANONICAL_METRIC_LABEL[CanonicalMetric.PushedLocPerDollar],
    unitLabel: LOC_UNIT_LABEL,
    numerator: BRANCH_LIST.numerator,
    denominator: BRANCH_LIST.denominator,
    population: BRANCH_LIST.population,
  },
  [LocMetricDefinitionId.BranchDetailPublicationLoc]: {
    id: LocMetricDefinitionId.BranchDetailPublicationLoc,
    label: BRANCH_DETAIL.label,
    canonicalLabel: CANONICAL_METRIC_LABEL[CanonicalMetric.PushedLocPerDollar],
    unitLabel: LOC_UNIT_LABEL,
    numerator: BRANCH_DETAIL.numerator,
    denominator: BRANCH_DETAIL.denominator,
    population: BRANCH_DETAIL.population,
  },
  [LocMetricDefinitionId.BranchCanonicalPublicationLoc]: {
    id: LocMetricDefinitionId.BranchCanonicalPublicationLoc,
    label: BRANCH_CANONICAL.label,
    canonicalLabel: CANONICAL_METRIC_LABEL[CanonicalMetric.PushedLocPerDollar],
    unitLabel: LOC_UNIT_LABEL,
    numerator: BRANCH_CANONICAL.numerator,
    denominator: BRANCH_CANONICAL.denominator,
    population: BRANCH_CANONICAL.population,
  },
  /**
   * ISS-10667 moved the three publication ratios and not this one, so its
   * canonical spelling is its dictionary label — which is still "LOC per $",
   * NOT the "Pushed LOC per $" phrase its sole-push numerator would suggest.
   * That asymmetry is ISS-10667's and predates this registry; recording it here
   * makes it legible rather than settling it, which is ISS-9097 item 3.
   */
  [LocMetricDefinitionId.BranchPushedLoc]: {
    id: LocMetricDefinitionId.BranchPushedLoc,
    label: BRANCH_PUSHED.label,
    canonicalLabel: BRANCH_PUSHED.label,
    unitLabel: LOC_UNIT_LABEL,
    numerator: BRANCH_PUSHED.numerator,
    denominator: BRANCH_PUSHED.denominator,
    population: BRANCH_PUSHED.population,
  },
} as const satisfies Record<LocMetricDefinitionId, LocMetricDefinition>;

/** The definition of record for `id`. Total over the closed set. */
export function locMetricDefinition(
  id: LocMetricDefinitionId
): LocMetricDefinition {
  return LOC_METRIC_DEFINITION[id];
}
