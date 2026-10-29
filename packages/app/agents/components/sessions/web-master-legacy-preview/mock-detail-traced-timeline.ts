/**
 * @file mock-detail-traced-timeline.ts
 * @description The Sessions detail timeline for the ONE session whose
 * invocations this sandbox actually holds.
 *
 * Split from `./mock-detail.ts` because the two timelines answer different
 * questions and must not be read as one. Every other row on that screen gets
 * `buildCostEvents`, which spreads a session TOTAL over a fixed weight profile
 * — the only honest thing to draw for a row whose internals the sandbox does
 * not hold. This session's internals are held, so a spread would be inventing a
 * silhouette on top of a real one.
 *
 * The type import below is type-only and therefore erased, so pairing this
 * module with `./mock-detail.ts` costs no runtime cycle.
 */

import {
  previewTracedSessionPhaseAt,
  previewTracedSessionTrace,
} from "@repo/app/agents/components/detail/trace/preview/preview-traced-session";
import { flattenSpans } from "@repo/app/agents/lib/session-trace/build-session-trace";
import {
  priceTokens,
  TRACED_SESSION,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session-identity";
import { TracedSessionActivityPhase } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session-model";
import type { TimelineCostEvent } from "./mock-detail";

const MS_PER_MINUTE = 60_000;

const TRACED_PHASE_LABEL: Record<
  TracedSessionActivityPhase,
  TimelineCostEvent["phase"]
> = {
  [TracedSessionActivityPhase.Explore]: "Research",
  [TracedSessionActivityPhase.Plan]: "Planning",
  [TracedSessionActivityPhase.Implement]: "Implementation",
  [TracedSessionActivityPhase.Rework]: "Implementation",
  [TracedSessionActivityPhase.Validate]: "Verification",
  [TracedSessionActivityPhase.Review]: "Verification",
  [TracedSessionActivityPhase.Other]: "Implementation",
  [TracedSessionActivityPhase.Idle]: "Planning",
};

/**
 * The traced session's cost dots, taken off its OWN invocations.
 *
 * Every other row on this screen gets `buildCostEvents`, which spreads the
 * session total over a fixed weight profile — a plausible silhouette for a row
 * whose internals the sandbox does not hold. This session's internals ARE held,
 * so spreading them would be inventing a shape on top of a real one: the dots
 * here sit at the instant the span actually billed, carry that span's own
 * input/output/cache split priced at the same rates the fixture bills at, and
 * take their phase from the same segment model the Trace tab's bands read.
 *
 * The sum therefore reconciles to the session total by construction rather than
 * by normalisation, which is the property the Trace tab's header depends on.
 */
export function buildTracedCostEvents(
  durationMinutes: number,
  traceRows: number
): TimelineCostEvent[] {
  const lastRow = Math.max(0, traceRows - 1);
  const events: TimelineCostEvent[] = [];
  for (const span of flattenSpans(previewTracedSessionTrace.roots)) {
    const { invocation } = span;
    if (invocation.estimatedCost === undefined) {
      continue;
    }
    const atMinutes = span.startMs / MS_PER_MINUTE;
    events.push({
      atMinutes,
      model: invocation.model ?? TRACED_SESSION.model,
      phase: TRACED_PHASE_LABEL[previewTracedSessionPhaseAt(span.startMs)],
      cIn: priceTokens({
        inputTokens: invocation.inputTokens ?? 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      }),
      cOut: priceTokens({
        inputTokens: 0,
        outputTokens: invocation.outputTokens ?? 0,
        cacheReadTokens: 0,
      }),
      cCache: priceTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: invocation.cacheReadTokens ?? 0,
        cacheWriteTokens: invocation.cacheWriteTokens,
      }),
      traceRow:
        durationMinutes <= 0
          ? 0
          : Math.min(
              lastRow,
              Math.floor((atMinutes / durationMinutes) * traceRows)
            ),
    });
  }
  return events;
}

/**
 * Move each marker onto the billed instant nearest to it.
 *
 * `buildTimelineMarkers` places its markers at proportions of the session's
 * duration — the only thing it can do for a row whose internals are unknown.
 * For THIS session the internals are known, and a marker at 55% of the clock
 * generally lands in an idle stretch where nothing billed, which contradicts
 * what a marker asserts: that a prompt, a commit or a delivery event happened,
 * and therefore that the agent was spending tokens around it.
 *
 * Snapping the SYNTHETIC thing onto the REAL one is the honest direction. The
 * alternative — emitting a cost dot at the marker's invented timestamp — would
 * be inventing spend the session never billed, and `buildTracedCostEvents`
 * exists precisely so that cannot happen here.
 */
export function snapTracedMarkers<
  Marker extends { atMinutes: number; traceRow: number },
>(markers: readonly Marker[], events: readonly TimelineCostEvent[]): Marker[] {
  const [first] = events;
  if (first === undefined) {
    return [...markers];
  }
  return markers.map((marker) => {
    let nearest = first;
    for (const event of events) {
      if (
        Math.abs(event.atMinutes - marker.atMinutes) <
        Math.abs(nearest.atMinutes - marker.atMinutes)
      ) {
        nearest = event;
      }
    }
    return {
      ...marker,
      atMinutes: nearest.atMinutes,
      traceRow: nearest.traceRow,
    };
  });
}
