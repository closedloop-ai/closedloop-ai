"use client";

import { useScrollFade } from "@repo/app/shared/hooks/use-scroll-fade";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

type ScrollFadeTrackProps = {
  children?: ReactNode;
  /** Extra classes for the outer relative wrapper (e.g. sizing/flex). */
  className?: string;
  /** Extra classes for the inner scrolling track. */
  trackClassName?: string;
  /**
   * Accessible name for the track. Supply it when the scrolling content is NOT
   * itself keyboard-reachable — a table, a chart, plain text. While the track
   * can actually scroll it then becomes a named, focusable `group` so a
   * keyboard-only user can arrow-scroll to the clipped end (WCAG 2.1.1; axe
   * `scrollable-region-focusable`), and it reserves an end inset so no content
   * rests under the end fade — a half-faded number reads as a different number.
   *
   * Both are scoped to the can-actually-scroll state: at a width where nothing
   * overflows there is no tab stop to dead-end on and no inset to shift the
   * layout. Omit the prop entirely when the content is a row of buttons/links —
   * tabbing through those already scrolls the track, so an extra stop in front
   * of them is noise.
   */
  scrollableRegionLabel?: string;
};

/**
 * Horizontally scrolling track that fades its start/end edges only when the
 * content is genuinely clipped on that side. A bare `overflow-x-auto` gives no
 * cue that content is cut off, so segments that scroll off-screen (e.g. the
 * trailing type-tabs on a narrow toolbar) silently disappear; the edge
 * gradients signal there is more to scroll and fade in via
 * `useScrollFade("horizontal")`.
 *
 * Shared across the document-table toolbar (My Tasks filter-category
 * ToggleGroup), the Agents workspace type-tab strip — both feed a wide
 * ToggleGroup into a toolbar row that can run out of horizontal room — and the
 * session-detail Activity breakdown table, whose fixed columns cannot fit a
 * phone width (ISS-4674). Presentational only; consumers own the scrolling
 * content, including any `min-w-fit` that makes it overflow in the first place.
 */
export function ScrollFadeTrack({
  children,
  className,
  trackClassName,
  scrollableRegionLabel,
}: ScrollFadeTrackProps) {
  const {
    ref: scrollRef,
    showTopFade: showStartFade,
    showBottomFade: showEndFade,
    isScrollable,
  } = useScrollFade("horizontal");
  const regionProps = buildScrollableRegionProps(
    scrollableRegionLabel,
    isScrollable
  );

  return (
    <div
      className={cn("relative flex min-w-0 max-w-full items-center", className)}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent transition-opacity duration-200",
          showStartFade ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        className={cn(
          "flex min-w-0 max-w-full items-center gap-2 overflow-x-auto",
          // Focus ring on the same tokens as `Button` — a tab stop the user
          // cannot see land is worse than no tab stop. Only while the region
          // props are on, since that is the only time the track is focusable.
          regionProps &&
            "rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          // Keeps BOTH edge fades (`w-6` each) off the content: a value that
          // rests under a fade reads as a different value — a half-faded "1.2k"
          // as "1.2" — the UI lying about the number, not merely clipping it.
          // The end inset (`pr-6`) clears the trailing right-aligned numbers; the
          // matching start inset (`pl-6`) clears the leading phase names once the
          // user scrolls right and the start fade turns on (same argument, the
          // other edge). Both are gated on `regionProps` (real overflow), so at a
          // width where nothing scrolls neither fade shows and neither inset
          // shifts the layout.
          regionProps && "px-6",
          trackClassName
        )}
        ref={scrollRef}
        {...regionProps}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent transition-opacity duration-200",
          showEndFade ? "opacity-100" : "opacity-0"
        )}
      />
    </div>
  );
}

/**
 * The track's accessibility attributes, which only exist together: a named
 * `group` plus its own tab stop, so a keyboard-only user can reach and
 * arrow-scroll content that carries no focusable children. Built as one object
 * rather than three conditional JSX attributes because the role and the name
 * must never appear without each other (a bare `aria-label` on a `div` names
 * nothing, and a nameless focusable role is worse than none).
 *
 * `group`, not `region`: a named `region` is a LANDMARK, and these tracks are
 * nested inside a surface that usually already names itself (the Activity
 * breakdown track sits inside `<section aria-label="Activity breakdown">`), so a
 * landmark here would show up in the rotor as a near-duplicate of its own
 * parent. `group` gives the focusable element a role and a name without
 * claiming to be a top-level region. axe's `scrollable-region-focusable` only
 * requires the element be focusable, so this satisfies it either way.
 *
 * Returns nothing unless the track can ACTUALLY scroll. A tab stop on a div that
 * cannot move is a dead end the user has to tab back out of, and this component
 * renders on every session detail at every width.
 */
function buildScrollableRegionProps(
  scrollableRegionLabel: string | undefined,
  isScrollable: boolean
): { "aria-label": string; role: "group"; tabIndex: number } | undefined {
  if (scrollableRegionLabel == null || !isScrollable) {
    return;
  }
  return {
    "aria-label": scrollableRegionLabel,
    role: "group",
    tabIndex: 0,
  };
}
