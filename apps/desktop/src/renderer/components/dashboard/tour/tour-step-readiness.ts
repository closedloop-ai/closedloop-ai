import type { InsightsSection } from "@repo/api/src/types/insights";
import { resolveAiImpactState } from "@repo/app/insights/components/overview/ai-impact-slot";
import {
  DashboardRowState,
  ROW_SECTIONS,
  resolveInsightsSectionsState,
} from "@repo/app/insights/components/overview/dashboard-row-sections";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors";

/**
 * Whether the panel a tour beat rings has finished its first load, for Marisol
 * Ashgrove's ISS-12110 ruling (2026-10-07): "We can start the 1st beat as soon
 * as the 1st row of metrics cards is filled with data; then go to the next beat
 * once the data for that beat is ready."
 *
 * Only LOADING holds a beat. A panel that loaded with zero points is ready, and
 * a failed read is not waited on, so a failure keeps the behaviour it had
 * before the ruling: a failed insights section replaces this page's whole body,
 * and a failed Recent Sessions read draws its error inside the card the
 * `sessions` beat still rings.
 */
export function isDashboardTourStepReady(
  anchor: DashboardTourAnchor,
  {
    sectionLoading,
    sectionFailed,
    sessionsLoading,
  }: {
    sectionLoading: Record<InsightsSection, boolean>;
    sectionFailed: Record<InsightsSection, boolean>;
    sessionsLoading: boolean;
  }
): boolean {
  switch (anchor) {
    case DashboardTourAnchor.Sessions:
      return !sessionsLoading;
    case DashboardTourAnchor.Impact:
      return (
        resolveAiImpactState(sectionLoading, sectionFailed) !==
        DashboardRowState.Loading
      );
    case DashboardTourAnchor.GettingStarted:
      return true;
    default:
      return (
        resolveInsightsSectionsState(
          ROW_SECTIONS[anchor],
          sectionLoading,
          sectionFailed
        ) !== DashboardRowState.Loading
      );
  }
}
