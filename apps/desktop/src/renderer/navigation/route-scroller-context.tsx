import { createContext, type ReactNode, useContext } from "react";
import type { NavId } from "./route-table";

/**
 * ISS-12471: lets a route hand the App shell the element that actually scrolls
 * on it, so the shell's per-href scroll memory
 * (`use-content-scroll-restoration.ts`) measures that element as well as the
 * content viewport. On a `GridTableListSurface` list the viewport cannot
 * overflow -- the body pins itself to the window height and an inner band
 * scrolls -- so without this channel the shell remembers an offset that is
 * always 0 and restores into an element that refuses the write.
 *
 * Published rather than threaded as a prop for the same reason as
 * `detail-title-context.tsx`: the shell owns the viewport, the route owns the
 * node, and the views between them are lazily-loaded and have no business
 * carrying it.
 */
export type RegisterRouteScroller = (node: HTMLElement | null) => void;

const RouteScrollerContext = createContext<RegisterRouteScroller | null>(null);

/**
 * Binds one keep-alive panel's subtree to the shell's registrar, and only while
 * that panel's nav id is the live route's.
 *
 * ISS-12471 (marisol cid 4273664871): the shell holds ONE route-scroller slot, and
 * keep-alive leaves every visited view mounted and rendering. A second route
 * wiring `tableScrollRef` would therefore re-register its hidden band on every
 * render and take the visible band's scroll listener with it, so which of the
 * two the shell measures would come down to render order. Gating here means
 * only the live route ever reaches the slot, whatever registers.
 */
export function RouteScrollerProvider({
  activeNavId,
  children,
  navId,
  registerRouteScroller,
}: {
  activeNavId: NavId | null;
  children: ReactNode;
  navId: NavId;
  registerRouteScroller: RegisterRouteScroller;
}) {
  return (
    <RouteScrollerContext.Provider
      value={
        navId === activeNavId
          ? registerRouteScroller
          : noRouteScrollerRegistration
      }
    >
      {children}
    </RouteScrollerContext.Provider>
  );
}

/**
 * The shell's registrar for the calling route's scrolling element, or a no-op
 * outside the shell (Storybook, a unit test mounting the view alone), where
 * there is no scroll memory to publish to.
 */
export function useRouteScrollerRegistration(): RegisterRouteScroller {
  return useContext(RouteScrollerContext) ?? noRouteScrollerRegistration;
}

const noRouteScrollerRegistration: RegisterRouteScroller = () => undefined;
