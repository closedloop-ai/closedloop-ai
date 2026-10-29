"use client";

import type { InsightsSection } from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import type { ComponentProps } from "react";
import {
  AI_IMPACT_SECTIONS,
  AiImpactCard,
  type AiImpactSectionUnread,
  isAiImpactStale,
} from "./ai-impact-card";
import {
  DashboardRowState,
  resolveInsightsSectionsState,
} from "./dashboard-row-sections";
import { DashboardAiImpactSkeleton } from "./dashboard-skeletons";

/**
 * The AI Impact card plus the three states it can be in, as ONE component both
 * shells mount — so an Agents failure cannot draw a card on desktop and nothing
 * on web (ISS-10486 review). The card is shared; until this, the decision of
 * whether to draw it at all was not.
 *
 * The operator's ruling, 2026-09-19: a failed section costs its own TILES, never
 * the card. `cost-per-pr` and `top-repo` divide Delivery by Delivery, so an
 * Agents failure leaves every one of their operands present and sibling values
 * rendering beside them — withholding the card there deletes two computable
 * capabilities rather than caveating them. The two tiles that genuinely lose an
 * operand render `—`, and {@link AiImpactSectionUnread} keeps their captions off
 * a completed-lookup claim.
 *
 * LOADING IS NOT FAILED, which is the whole reason this is a component and not a
 * boolean at each call site: in flight draws a placeholder, so a reader can tell
 * "still arriving" from "arrived without this".
 */
export function AiImpactSlot({
  sections,
  sectionLoading,
  sectionFailed,
  sectionStale,
  getTileAvailability,
  githubConnect,
}: {
  getTileAvailability?: ComponentProps<
    typeof AiImpactCard
  >["getTileAvailability"];
  githubConnect?: ComponentProps<typeof AiImpactCard>["githubConnect"];
  sections: InsightsSectionData;
  sectionLoading: Record<InsightsSection, boolean>;
  sectionFailed: Record<InsightsSection, boolean>;
  sectionStale: Record<InsightsSection, boolean>;
}) {
  const state = resolveAiImpactState(sectionLoading, sectionFailed);
  if (state === DashboardRowState.Loading) {
    return <DashboardAiImpactSkeleton />;
  }
  return (
    <AiImpactCard
      getTileAvailability={getTileAvailability}
      githubConnect={githubConnect}
      sections={sections}
      sectionUnread={aiImpactSectionUnread(sectionLoading, sectionFailed)}
      stale={isAiImpactStale(sectionStale)}
    />
  );
}

/**
 * A section has not answered when it failed OR is still in flight, and the card
 * needs both folded into one fact: on a `Failed` verdict the OTHER section can
 * still be loading (Agents errored while Delivery is mid-flight), and reading
 * only `sectionFailed` there would caption Delivery's missing tiles as a
 * measured zero.
 */
function aiImpactSectionUnread(
  sectionLoading: Record<InsightsSection, boolean>,
  sectionFailed: Record<InsightsSection, boolean>
): AiImpactSectionUnread {
  const unread: AiImpactSectionUnread = {};
  for (const section of AI_IMPACT_SECTIONS) {
    unread[section] =
      sectionFailed[section] === true || sectionLoading[section] !== false;
  }
  return unread;
}

/**
 * The card's own verdict over {@link AI_IMPACT_SECTIONS}, exported so the host
 * that needs the same answer for the element AROUND the slot — the web shell's
 * tour anchor — reads it here instead of re-running the resolver over the same
 * section list. Two derivations of one verdict is how the anchor and the render
 * come to disagree about whether the card is showing anything to ring a beat
 * about.
 */
export function resolveAiImpactState(
  sectionLoading: Record<InsightsSection, boolean>,
  sectionFailed: Record<InsightsSection, boolean>
): DashboardRowState {
  return resolveInsightsSectionsState(
    AI_IMPACT_SECTIONS,
    sectionLoading,
    sectionFailed
  );
}
