/**
 * @file summary-bars.ts
 * @description Which windows the compact sidebar summary shows, in order.
 *
 * Extracted so the rendered bars and the trigger's accessible name are computed
 * from ONE selection. They were drifting apart by construction: the button
 * carried a static label while the figures lived in its subtree, and an
 * `aria-label` on a button replaces that subtree for name computation — so a
 * screen-reader user heard "View session limits" and none of the percentages a
 * sighted user reads at a glance.
 */

import type { RateLimit, SessionLimits } from "../types";
import {
  SessionLimitWindowLabel,
  SessionLimitWindowShortLabel,
} from "./window-labels";

export type SummaryBar = { title: string; limit: RateLimit };

/**
 * The two primary windows ("Current session", "Current week") when present.
 *
 * A plan that exposes neither still gets one bar from the windows it does have,
 * so the drawer stays reachable rather than hanging off a blank, unclickable
 * trigger — the nav mounts on exactly those windows, so the summary has to be
 * able to render them too. Returns an empty array when there is nothing to draw.
 *
 * Titles come from {@link SessionLimitWindowLabel} and its short forms rather
 * than being spelled out here, so a window cannot end up with one name in this
 * summary and a different one in the drawer a click later.
 */
export function selectSummaryBars(limits: SessionLimits): SummaryBar[] {
  const bars: SummaryBar[] = [];
  if (limits.fiveHour) {
    bars.push({
      title: SessionLimitWindowShortLabel.FiveHour,
      limit: limits.fiveHour,
    });
  }
  if (limits.sevenDay) {
    bars.push({
      title: SessionLimitWindowShortLabel.SevenDay,
      limit: limits.sevenDay,
    });
  }
  if (bars.length > 0) {
    return bars;
  }

  // Subset-window plans (per-model week, or extra-usage credits only). These
  // keep their full names: with no sibling bar beside them there is nothing to
  // infer the model from, so a short form would be a second name, not a
  // shortening.
  if (limits.sevenDaySonnet) {
    bars.push({
      title: SessionLimitWindowLabel.SevenDaySonnet,
      limit: limits.sevenDaySonnet,
    });
    return bars;
  }
  if (limits.sevenDayOpus) {
    bars.push({
      title: SessionLimitWindowLabel.SevenDayOpus,
      limit: limits.sevenDayOpus,
    });
    return bars;
  }
  if (limits.extraUsage?.isEnabled && limits.extraUsage.utilization !== null) {
    bars.push({
      title: SessionLimitWindowLabel.ExtraUsage,
      limit: { utilization: limits.extraUsage.utilization, resetsAt: null },
    });
  }
  return bars;
}
