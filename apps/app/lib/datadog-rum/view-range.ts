"use client";

import { datadogRum } from "@datadog/browser-rum";
import type { InsightsPeriod } from "@repo/api/src/types/insights";
import {
  RUM_VIEW_RANGE_UNTAGGED,
  type RumViewRange,
} from "@repo/app/insights/lib/dashboard-range";
import { useEffect } from "react";

/**
 * ISS-7250. Datadog's own attribute name, so snake_case rather than the repo's
 * camelCase identifier convention.
 */
export const RUM_VIEW_RANGE_ATTRIBUTE = "range_days";

/**
 * Attaches the selected time window to the current RUM view so page-load
 * percentiles are sliceable by route x range: `/dashboard` over 90 days is a
 * different query with different latency than the same page over 7 days, and
 * averaged together a 90d regression hides behind the 7d majority.
 *
 * `InsightsPeriod` IS the closed set this attribute may carry ("7" | "30" |
 * "90" | "all") — the vocabulary the insights engine already speaks, reused
 * rather than re-declared. That closure is what keeps the attribute PII-free:
 * it is a bounded bucket label, so no literal dates, org, user, slug, or query
 * text can reach Datadog through it. Route comes free from the RUM view itself.
 */
export function setRumViewRange(period: InsightsPeriod): void {
  try {
    datadogRum.setViewContextProperty(RUM_VIEW_RANGE_ATTRIBUTE, period);
  } catch {
    // Telemetry must never affect app behavior.
  }
}

/**
 * An Effect because this synchronizes an external system (the RUM view) with a
 * value that can arrive from a URL param, a persisted store, or the picker — so
 * it must fire on mount as well as on change, which an event handler cannot do.
 *
 * `null` means the window is NOT KNOWN YET and nothing is written (ISS-7250,
 * whitlockk review). A surface whose range comes from a persisted view renders its
 * first commit on the DEFAULT — the restore is a post-mount effect by design
 * (FEA-4125) — so a saved 90d view would otherwise tag that commit `7` and
 * bucket any view/update in the window under a window the user never selected.
 * Callers pass the same readiness signal they already gate their data read on
 * (`isViewReady`) rather than a second gate of their own.
 *
 * Writing nothing is deliberate, and is not the same choice as writing a
 * placeholder. Every member of this attribute's domain names a range the user
 * SELECTED; none of them means "not yet known", and minting one would both
 * re-open the closed set that makes the no-PII property hold by construction
 * and still have to be excluded from every panel. An untagged view simply drops
 * out of a range-sliced query, which under-reports a bucket; a wrongly tagged
 * one inflates the wrong bucket, which is the averaging defect this attribute
 * exists to remove.
 *
 * {@link RUM_VIEW_RANGE_UNTAGGED} is therefore NOT the same input as `null`
 * (ISS-12660, tamsinb review): a range this attribute cannot name has to clear
 * whatever the view already carries, because skipping the write is what leaves
 * a reader who moved from 7d to 60d inflating the `7` bucket for the rest of
 * the view — the very defect the paragraph above describes.
 */
export function useRumViewRange(period: RumViewRange | null): void {
  useEffect(() => {
    if (period === null) {
      return;
    }
    if (period === RUM_VIEW_RANGE_UNTAGGED) {
      clearRumViewRange();
      return;
    }
    setRumViewRange(period);
  }, [period]);
}

/**
 * Drops the attribute from the current view. The RUM public API has no
 * remove-property call, so the property is overwritten with `undefined`, which
 * `@datadog/browser-core`'s sanitizer drops when the event is serialized
 * (verified in 7.2.0's `sanitize.js`).
 */
export function clearRumViewRange(): void {
  try {
    datadogRum.setViewContextProperty(RUM_VIEW_RANGE_ATTRIBUTE, undefined);
  } catch {
    // Telemetry must never affect app behavior.
  }
}
