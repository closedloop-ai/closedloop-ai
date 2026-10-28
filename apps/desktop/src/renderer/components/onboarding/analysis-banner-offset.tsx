"use client";

/**
 * @file The shell offset the ambient analysis bar reserves (ISS-10492).
 *
 * The bar is `position: fixed` at the top of the viewport, so it is out of flow
 * and nothing beneath it moves on its own. The shell has to reserve the space,
 * and the two are not neighbours in the tree — the bar is rendered by
 * `DesktopGuidedOnboardingDialogHost` (inside `Sidebar`, because that host owns
 * the onboarding run) while the element that must move is `App`'s
 * `SidebarInset`. This carries the measured height from the one to the other.
 *
 * The provider takes a RENDER PROP rather than plain children so the same
 * component can hand the reporter down and the height back out, which is what
 * lets `App` keep the offset on the real `SidebarInset` instead of a wrapper.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

const AnalysisBannerOffsetContext = createContext<
  ((height: number) => void) | null
>(null);

export function AnalysisBannerOffsetProvider({
  children,
}: {
  children: (offsetPx: number) => ReactNode;
}) {
  const [offsetPx, setOffsetPx] = useState(0);
  // Referentially stable, which the banner's layout effect requires: a new
  // identity every render would re-arm that effect every render, which is the
  // ISS-10492 feedback loop. The functional update also refuses to re-render on
  // an unchanged height, so a spurious report costs nothing.
  const report = useCallback((height: number) => {
    setOffsetPx((previous) => (previous === height ? previous : height));
  }, []);
  return (
    <AnalysisBannerOffsetContext.Provider value={report}>
      {children(offsetPx)}
    </AnalysisBannerOffsetContext.Provider>
  );
}

/**
 * Where a mounted bar reports its height, or `undefined` where no shell is
 * reserving space for one.
 *
 * `undefined` is what stops the bar mounting at all in that case, and that is
 * deliberate: a fixed bar with nothing offset beneath it overlaps the content
 * it is reporting about.
 */
export function useAnalysisBannerHeightReporter():
  | ((height: number) => void)
  | undefined {
  return useContext(AnalysisBannerOffsetContext) ?? undefined;
}
