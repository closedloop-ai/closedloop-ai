import { log } from "@repo/observability/log";
import type { LimitFunction } from "p-limit";

/**
 * Per-widget fan-out for the session-analytics rollups.
 *
 * Two rules, both learned the hard way:
 *
 * 1. **Bounded.** Every read goes through a shared `p-limit` limiter, so a
 *    screen with six widgets can never put six concurrent queries into a pool
 *    that has fewer connections to spare. An unbounded per-widget scan is what
 *    crash-looped the desktop db-host worker (FEA-3056). Bounds compose by
 *    ADDITION, so a screen builds ONE limiter and passes it to every widget
 *    rather than letting each read build its own.
 *
 * 2. **Independent.** A widget that fails settles as UNAVAILABLE and the rest of
 *    the page still renders. The failure is not swallowed — it is logged under
 *    the existing `insights.*_failed` event family so it reaches the same
 *    monitor as any other insights failure — but it never blanks a page or, far
 *    worse, degrades into a fabricated `0` on a surface whose whole subject is
 *    failure.
 */

export type WidgetOutcome<TKey extends string, TValue> =
  | { key: TKey; ok: true; value: TValue }
  | { key: TKey; ok: false };

/**
 * Run one widget's read under the shared limiter, converting a failure into a
 * settled "unavailable" outcome rather than a rejection. Because the rejection
 * is handled inside the limited task, a sibling widget's failure can never
 * leave an already-dispatched read running unawaited.
 */
export function runWidget<TKey extends string, TValue>(
  limiter: LimitFunction,
  key: TKey,
  read: () => Promise<TValue>,
  correlation: Record<string, unknown>
): Promise<WidgetOutcome<TKey, TValue>> {
  return limiter(async (): Promise<WidgetOutcome<TKey, TValue>> => {
    try {
      return { key, ok: true, value: await read() };
    } catch (error) {
      log.error("insights.session_analytics_widget_failed", {
        error,
        widget: key,
        ...correlation,
      });
      return { key, ok: false };
    }
  });
}

/**
 * Collect the widgets that settled without a value, in the order given. The
 * caller renders a quiet dash and a reason for each — never a zero.
 */
export function unavailableKeysOf<TKey extends string>(
  outcomes: readonly WidgetOutcome<TKey, unknown>[]
): TKey[] {
  return outcomes
    .filter((outcome) => !outcome.ok)
    .map((outcome) => outcome.key);
}

/** The value a widget resolved, or the given fallback when it did not. */
export function valueOr<TKey extends string, TValue>(
  outcome: WidgetOutcome<TKey, TValue>,
  fallback: TValue
): TValue {
  return outcome.ok ? outcome.value : fallback;
}
