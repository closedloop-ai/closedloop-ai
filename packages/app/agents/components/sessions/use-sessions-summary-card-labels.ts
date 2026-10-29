"use client";

import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { SessionsSummaryCardId } from "./sessions-summary-card-visibility";
import {
  ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS,
  SESSIONS_SUMMARY_CARD_LABELS,
} from "./sessions-summary-card-visibility";

/**
 * ISS-10667: the Options menu, the settled strip and the loading shell spell
 * every card the same way — with ONE exception, the Cost row. Its card renders
 * ruling 7's alias while this map keeps the canonical phrase for the menu, which
 * shares one menu with a Cost COLUMN toggle already called "Cost".
 * The loading shell resolves that card's word for itself; see
 * `sessions-summary-cards-loading.tsx`.
 *
 * The gate is READ HERE and branches HERE, picking between whole label maps;
 * what leaves this module is the map, never a boolean
 * (`scripts/lint/rules/no-threaded-feature-flag.ts`). ISS-10667 made the toolbar
 * and the loading shell share this hook — each carried its own copy of the
 * ternary, and two places would have been two ways to disagree about one card's
 * name.
 *
 * ISS-10636 retired the basis gate this hook also used to read. The dollar row
 * is the canonical phrase in BOTH maps, so this gate moves only the token and
 * ratio rows.
 */
export function useSessionsSummaryCardLabels(): Readonly<
  Record<SessionsSummaryCardId, string>
> {
  return useFeatureFlagEnabledOptional(ONE_LABEL_PER_METRIC_FLAG_KEY)
    ? ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS
    : SESSIONS_SUMMARY_CARD_LABELS;
}
