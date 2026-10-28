"use client";

import { CompleteSurfaceState } from "../../../shared/lib/complete-surface-contract";
import type { AgentsListSurfaceV2ViewModel } from "../../hooks/use-agents-list-surface-v2-view-model";
import { AgentsSummaryCards } from "./agents-summary-cards";

/**
 * What the KPI strip does with one {@link CompleteSurfaceState}.
 *
 * Three treatments, not seven, because the strip has exactly three things it can
 * say: "still counting", "the count is unavailable", and a number. The mapping
 * from state to treatment is the interesting part and is declared once, below.
 */
type StripTreatment = "counted" | "failed" | "loading";

/**
 * Every state, named, with the treatment it gets (tamsinb review on PR #7528).
 *
 * A `Record` over the union rather than two `===` comparisons, so the EIGHTH
 * member of {@link CompleteSurfaceState} fails at `tsc` here the way it already
 * does in the sibling `agents-list-surface-v2-states.tsx`. The ladder this
 * replaces named two of seven and let the other five fall through to the settled
 * cards — which for a non-population state is the confident zero over an
 * uncounted population that ISS-9931 exists to stop, reproduced one prop over.
 *
 * `Unavailable` is `"failed"` rather than `"counted"` because it sits in
 * `NON_POPULATION_STATES` beside `Loading` and `Error`, and that set may not
 * render as a zero. No producer reaches it today — `selectAgentsListSurfaceState`
 * folds it into `Error` — so this is the gate on whoever wires one up, not a
 * live behaviour change.
 *
 * `Partial` is `"counted"` deliberately: a partial aggregate is a real count of
 * what was read, not an absence of one, so the honest strip prints it. Saying
 * WHAT is missing is the surface's job and there is no producer or copy for it
 * here yet — inventing one would be this file making a product decision it has
 * no design for, the same position the sibling states file takes.
 */
const STRIP_TREATMENT: Record<CompleteSurfaceState, StripTreatment> = {
  [CompleteSurfaceState.Loading]: "loading",
  [CompleteSurfaceState.Unavailable]: "failed",
  [CompleteSurfaceState.Error]: "failed",
  [CompleteSurfaceState.Partial]: "counted",
  [CompleteSurfaceState.FilteredEmpty]: "counted",
  [CompleteSurfaceState.GenuineEmpty]: "counted",
  [CompleteSurfaceState.Ready]: "counted",
};

/**
 * `AgentsListSurfaceV2`'s KPI strip (ISS-9398).
 *
 * The aggregate describes the WHOLE filtered population across every page, never
 * the visible slice, so the numbers do not move as the reader pages.
 *
 * The read's own state is forwarded because the honest aggregate over an
 * unfetched population is a real `0`, and a `0` under "matched by the current
 * filters" is a count nobody took. Since ISS-9931 forwarding it is also
 * SUFFICIENT: the strip swaps on these two props alone, with no gate left to
 * withhold the swap. Mapping them is therefore this component's whole
 * contribution to the contract — and the mapping is the part to keep honest,
 * because a state this view model does not translate falls through to the
 * settled cards. {@link STRIP_TREATMENT} is that mapping, and it covers every
 * NON-POPULATION state rather than every state: `Ready`, `FilteredEmpty` and
 * `GenuineEmpty` are population claims and are correctly left to the cards.
 */
export function AgentsListSurfaceV2Metrics({
  model,
}: {
  model: AgentsListSurfaceV2ViewModel;
}) {
  const treatment = STRIP_TREATMENT[model.state];

  return (
    <AgentsSummaryCards
      current={model.summaryCurrent}
      dedupePluginRollups={model.invocationsDedupeApplied}
      deltaLabel={model.deltaLabel}
      isError={treatment === "failed"}
      isLoading={treatment === "loading"}
      previous={model.summaryPrevious}
    />
  );
}
