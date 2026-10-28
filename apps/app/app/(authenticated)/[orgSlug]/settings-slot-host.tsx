"use client";

import { SETTINGS_CLOSE_ROUTE } from "@repo/api/src/types/settings-panel";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { type ReactNode, useCallback, useRef } from "react";
import { useSettingsSlotSegments } from "@/lib/navigation/next-adapter";
import { SettingsSlotOverlayProvider } from "./settings-slot-overlay";

/** The slot's segment while `@settings/(.)settings` is intercepting. */
const INTERCEPTED_SETTINGS_SEGMENT = "(.)settings";
/** The `children` path when the full Settings page is what is mounted. */
const SETTINGS_CHILD_SEGMENT = "settings";

/**
 * Exactly `/settings` — not a retained route beneath it. A Settings link from
 * `/settings/integrations/desktop/…` is intercepted too, and that page is a
 * surface to overlay, not a stale copy of the modal's own page.
 */
function isSettingsPage(childSegments: readonly string[]): boolean {
  return (
    childSegments.length === 1 && childSegments[0] === SETTINGS_CHILD_SEGMENT
  );
}

export type SettingsSlotHostProps = {
  /** The `@settings` parallel slot the layout received. */
  slot: ReactNode;
  children: ReactNode;
};

/**
 * Decides what the `@settings` slot MEANS (ISS-8370 D2). A soft navigation to
 * `/settings` is intercepted for EVERY user, so:
 *
 * - intercepting: `children` stays mounted and the slot renders over it as an
 *   overlay modal, so the surface keeps its state. Dismissing puts the URL back
 *   to the surface's own href with a `replace`, which returns the slot to its
 *   inert catch-all without unmounting anything.
 * - intercepting, when `children` IS the full Settings page (`proxy.ts` keeps a
 *   soft navigation from a hard-loaded `/settings` to `/settings?panel=…` from
 *   being intercepted, ISS-10323; if one is, the page underneath keeps its stale
 *   params): the slot alone, with no
 *   overlay context, so it presents cold and a dismiss is the navigation it
 *   would have been. Only `/settings` itself: a retained subroute such as
 *   `/settings/integrations/desktop/…` is an ordinary surface and gets the
 *   overlay.
 * - slot inactive: `children`.
 *
 * Whether the slot is active is read off the slot's own segment, not off
 * `null`: the `@settings/[...unmatched]` page is what deactivates it on any other
 * navigation, and it reports the matched path as the segment.
 *
 * `children` sits at ONE fixed position in the returned tree and only the
 * overlay node beside it comes and goes. React reconciles by element type per
 * position, so had `children` moved in and out while intercepting, every open
 * and every close would have remounted the surface behind the modal and thrown
 * its state away — the opposite of what the overlay is for.
 */
export function SettingsSlotHost({ slot, children }: SettingsSlotHostProps) {
  const { slotSegment, childSegments } = useSettingsSlotSegments();
  const intercepting = slotSegment === INTERCEPTED_SETTINGS_SEGMENT;
  const underlyingHref = useUnderlyingHref(intercepting);
  const { replace } = useNavigation();
  const buildOrgPath = useOrgPath();

  const dismissOverlay = useCallback(() => {
    replace(underlyingHref ?? buildOrgPath(SETTINGS_CLOSE_ROUTE));
  }, [buildOrgPath, replace, underlyingHref]);

  const overlaying = intercepting && !isSettingsPage(childSegments);
  const surfaceMounted = !intercepting || overlaying;

  return (
    <>
      {surfaceMounted ? children : null}
      {renderSettingsSlot({ dismissOverlay, intercepting, overlaying, slot })}
    </>
  );
}

/**
 * The href of the surface behind the modal: the last URL seen while the slot
 * was NOT intercepting. Captured during render because the intercept can only
 * be entered from an in-app navigation, so by the time it is active the value
 * is already held; while it is active the router reports `/settings`, which is
 * exactly the URL a dismiss has to move away from.
 */
function useUnderlyingHref(intercepting: boolean): string | null {
  const pathname = usePath();
  const search = useSearchParamsValue();
  const href = useRef<string | null>(null);
  if (!intercepting) {
    const query = search.toString();
    href.current = query.length > 0 ? `${pathname}?${query}` : pathname;
  }
  return href.current;
}

/** The intercepted slot: an overlay over a retained surface, or the slot cold. */
function renderSettingsSlot({
  dismissOverlay,
  intercepting,
  overlaying,
  slot,
}: {
  dismissOverlay: () => void;
  intercepting: boolean;
  overlaying: boolean;
  slot: ReactNode;
}): ReactNode {
  if (!intercepting) {
    return null;
  }
  if (overlaying) {
    return (
      <SettingsSlotOverlayProvider onDismiss={dismissOverlay}>
        {slot}
      </SettingsSlotOverlayProvider>
    );
  }
  return slot;
}
