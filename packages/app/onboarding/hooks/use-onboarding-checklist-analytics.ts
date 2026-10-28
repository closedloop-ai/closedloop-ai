"use client";

import type {
  ChecklistItemId,
  OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { useCallback, useEffect, useRef } from "react";
import { useSurfaceAnalytics } from "../../shared/observability/surface-analytics-context";

/**
 * Direct `onboarding_checklist_item_completed` capture, for the surfaces that
 * complete an item themselves (the web setup wizard's create-team and
 * create-project steps) rather than observing the server-derived status.
 */
export function useChecklistItemCompletedCapture(): {
  captureChecklistItemCompleted: (itemId: ChecklistItemId) => void;
} {
  const { capture } = useSurfaceAnalytics();
  const captureChecklistItemCompleted = useCallback(
    (itemId: ChecklistItemId) => {
      capture(OnboardingAnalyticsEvent.ChecklistItemCompleted, {
        [OnboardingAnalyticsProperty.ItemId]: itemId,
      });
    },
    [capture]
  );
  return { captureChecklistItemCompleted };
}

/**
 * PRD-736 checklist events for the status-derived checklist card: emits
 * `onboarding_checklist_item_completed` when a rendered item FLIPS from
 * incomplete to complete while mounted, and `onboarding_checklist_completed`
 * when the last open item flips. The initial render is a baseline, never an
 * emission — an item that was already complete when the card mounted was not
 * completed in this session, and re-emitting it on every visit would count
 * one completion once per page load.
 */
export function useOnboardingChecklistCompletionEvents(
  items: readonly OnboardingChecklistItem[]
): void {
  const { capture } = useSurfaceAnalytics();
  const baselineRef = useRef<Map<ChecklistItemId, boolean> | null>(null);

  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    if (baselineRef.current === null) {
      baselineRef.current = toCompletionMap(items);
      return;
    }
    const previous = baselineRef.current;
    const wasComplete = [...previous.values()].every(Boolean);
    let itemFlippedThisTick = false;
    for (const item of items) {
      if (item.completed && previous.get(item.id) === false) {
        itemFlippedThisTick = true;
        capture(OnboardingAnalyticsEvent.ChecklistItemCompleted, {
          [OnboardingAnalyticsProperty.ItemId]: item.id,
        });
      }
    }
    const completedCount = items.filter((item) => item.completed).length;
    // Gated on an actual flip this tick: `items` MEMBERSHIP changes at runtime
    // (useOnboardingChecklist filters ConnectGoogle on an async feature-flag
    // read), so a baseline of N with one incomplete collapsing to N-1
    // all-complete would otherwise report a completion nobody performed.
    if (
      itemFlippedThisTick &&
      !wasComplete &&
      completedCount === items.length
    ) {
      capture(OnboardingAnalyticsEvent.ChecklistCompleted, {
        [OnboardingAnalyticsProperty.ItemsCompletedCount]: completedCount,
      });
    }
    baselineRef.current = toCompletionMap(items);
  }, [capture, items]);
}

function toCompletionMap(
  items: readonly OnboardingChecklistItem[]
): Map<ChecklistItemId, boolean> {
  return new Map(items.map((item) => [item.id, item.completed]));
}
