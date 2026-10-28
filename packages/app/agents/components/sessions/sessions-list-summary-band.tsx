import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { SUMMARY_CARD_SURFACE_BAND_PROPS } from "@repo/app/shared/components/summary-card-row";
import type { ComponentProps, ReactNode } from "react";
import { SessionsSummaryCards } from "./sessions-summary-cards";

/** @see SessionsListSurfaceV2's `summaryCards` — named so helpers can take it. */
export type SessionsSummaryCardsPassthrough = Omit<
  ComponentProps<typeof SessionsSummaryCards>,
  | "cardClassName"
  | "className"
  | "hiddenCardIds"
  | "isLoading"
  | "usage"
  | "wrapBelow"
>;

/**
 * The metric band, or `undefined` when the reader has hidden every card.
 *
 * `undefined` and not an empty element: `GridTableListSurface` renders its
 * padded band on truthiness, so returning a node here would keep the band's
 * vertical rhythm around a strip drawing nothing — the FEA-4217 defect.
 *
 * Module-level rather than inline so the branch is scored against this function
 * instead of the surface, which sits near the cognitive-complexity ceiling.
 */
export function renderSummaryMetricBand({
  allHidden,
  hiddenSummaryCards,
  isLoading,
  summaryCards,
  usage,
}: {
  allHidden: boolean;
  hiddenSummaryCards: ReadonlySet<string> | undefined;
  isLoading: boolean;
  summaryCards: SessionsSummaryCardsPassthrough | undefined;
  usage: AgentSessionUsageSummary | undefined;
}): ReactNode {
  if (allHidden) {
    return;
  }
  // ISS-7052 Part A: `SessionsSummaryCards` IS the strip — `SummaryCardRow` owns
  // the row's display, its `--summary-card-min` tracks and the FEA-3865
  // `wrapBelow` mode. It used to be nested inside `GridTableMetricStrip`, which
  // is a SECOND strip (`display: flex`), and two layout owners do not compose:
  // the row's `md:grid-cols-[repeat(auto-fit,minmax(…,1fr))]` grid sized to
  // max-content as a bare flex child, which for auto-fit is ONE track. All five
  // cards stacked into a 225px column ~900px tall, the band cannot shrink below
  // its own content, and `GridTableListSurface`'s `min-h-0 flex-1` table band —
  // the only other thing in the column — was starved to ZERO height. On the web
  // Sessions route that is the whole listing gone, with its rows still in the
  // DOM and unreachable. The `cardClassName` override went with it for the same
  // reason: `GRID_TABLE_METRIC_CARD_CLASS` replaced `summaryCardClass(wrapBelow)`
  // outright, so the host asking for `wrapBelow` got flex-basis sizing the grid
  // ignores.
  // ISS-11472 (operator ruling, Marisol, 2026-09-28): every metric bar gets ONE
  // treatment and it is not configurable, so this band spreads the shared set
  // rather than choosing its own. That set carries the stretch class — cards
  // take the band's spare width instead of pinning to `--summary-card-min` and
  // stranding the remainder as a dead gutter right of the last card, the
  // reported defect — so Sessions now spans its row the way Branches already
  // did. Every key it carries is Omitted from the passthrough above, so a host
  // cannot quietly re-open one of them: "not configurable" fails `tsc` rather
  // than being a sentence.
  //
  // What the shared set does NOT do is start wrapping: it pins `wrapBelow: false`
  // for the reason ISS-10314 measured on this exact band — a rank it gains is a
  // rank `GridTableListSurface`'s table loses, to 0px at phone width. ISS-10314's
  // scroll class in the same set is where the cards go instead.
  return (
    <SessionsSummaryCards
      {...summaryCards}
      {...SUMMARY_CARD_SURFACE_BAND_PROPS}
      hiddenCardIds={hiddenSummaryCards}
      isLoading={isLoading}
      usage={usage}
    />
  );
}
