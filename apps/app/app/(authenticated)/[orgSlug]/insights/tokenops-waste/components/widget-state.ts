import type { TokenOpsWidget } from "@repo/api/src/types/session-analytics";

/**
 * The three states this screen must never conflate.
 *
 * `Loading` is a skeleton that reserves the real geometry. `Unavailable` is a
 * SETTLED read that produced no value, and renders a quiet dash plus the reason
 * it settled that way. `Ready` renders the value, including a real `0`.
 *
 * On a screen whose whole subject is waste, a fabricated `$0` reads as "nothing
 * was wasted here", so the unavailable case has to be visibly its own thing
 * rather than a zero or a perpetual skeleton.
 */
export const WidgetState = {
  Loading: "loading",
  Unavailable: "unavailable",
  Ready: "ready",
} as const;
export type WidgetState = (typeof WidgetState)[keyof typeof WidgetState];

/**
 * Resolve one widget's state from the query plus the response's own
 * `unavailableWidgets`. Loading is checked first, so an in-flight read can
 * never be reported as settled-unavailable.
 *
 * A failed query settles every widget as unavailable: there is no response to
 * read a per-widget verdict from, and the zeros the response type would carry
 * are not measurements.
 */
export function resolveWidgetState({
  isPending,
  isError,
  unavailableWidgets,
  widget,
}: {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly unavailableWidgets: readonly TokenOpsWidget[] | undefined;
  readonly widget: TokenOpsWidget;
}): WidgetState {
  if (isPending) {
    return WidgetState.Loading;
  }
  if (isError || unavailableWidgets === undefined) {
    return WidgetState.Unavailable;
  }
  return unavailableWidgets.includes(widget)
    ? WidgetState.Unavailable
    : WidgetState.Ready;
}
