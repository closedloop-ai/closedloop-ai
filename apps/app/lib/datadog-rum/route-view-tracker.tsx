"use client";

import { DatadogAppRouter } from "@datadog/browser-rum-nextjs";
import { getSelectedParams } from "next/dist/client/components/router-reducer/compute-changed-path";
import { GlobalLayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { FlightRouterState } from "next/dist/shared/lib/app-router-types";
import {
  NavigationPromisesContext,
  PathParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import {
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { usePathValue } from "@/lib/navigation/next-adapter";

/**
 * ISS-6383. `DatadogAppRouter` starts a RUM view from its RENDER BODY, guarded
 * only by a `useRef`. A ref lives on one component instance, so any render React
 * starts with a fresh instance — a remount, or a render it begins and then
 * discards — finds the guard reset and starts another view for the SAME
 * pathname. Production emitted 13,918 duplicate `/[orgSlug]/branches` views in
 * 28 seconds this way, and the same signature appears on `/sessions`,
 * `/issues/[slug]`, `/prds/[slug]` and others: it is a root-layout defect, not a
 * per-page one. Upstream 7.9.0 is identical, so the guard has to live here.
 *
 * The latch is module-scoped precisely because it must outlive the remounts the
 * vendor's ref could not. It is a telemetry de-dup latch, never read during
 * render and never rendered, so nothing subscribes to it and it is not the
 * client UI state `apps/app/AGENTS.md` requires a `useSyncExternalStore` for.
 *
 * Mounting the vendor component is what starts the view, so it is mounted only
 * for a pathname the latch has not already reported. That keeps view NAMING
 * (`computeViewNameFromParams`) vendor-owned — it is not part of the package's
 * public API and its internal path already moved between 7.2 and 7.9, so
 * copying or deep-importing it would drift.
 *
 * DO NOT collapse this into a single render pass by deriving the mount from a
 * render-time read of the latch (`startedPathname !== pathname`). That looks
 * tidier and reintroduces the bug: it puts the vendor's render body — and so
 * `startView` — back inside the pre-commit window, where a render React starts
 * and discards fires the side effect while leaving the latch unwritten, so the
 * retry fires it again. The vendor must only ever mount from a COMMITTED render.
 *
 * The effect is a LAYOUT effect, and that is load-bearing rather than taste. The
 * nextjs plugin sets `trackViewsManually`, and rum-core's `tryStartRum` returns
 * early until the first `startView` arrives — so RUM does not start collecting
 * AT ALL until this component mounts the vendor. A passive effect would schedule
 * that mount behind the whole commit's passive-effect flush, so every provider's
 * and page's `useEffect` would run with RUM not yet started and
 * `trackRuntimeError` not yet installed: anything thrown in that window would go
 * unrecorded and read as "no errors" rather than "not observed". A layout effect
 * flushes inside the commit, before paint and before any passive effect, and —
 * like a passive effect — never runs for a render React discards, so it buys the
 * timing back without giving up the guarantee above.
 */
let startedPathname: string | null = null;

// `useLayoutEffect` is a no-op on the server and warns there, and this component
// is server-rendered as part of the root layout.
const useViewStartEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;

export function DatadogRouteViewTracker() {
  const pathname = usePathValue();
  const [trackedPathname, setTrackedPathname] = useState<string | null>(null);

  useViewStartEffect(() => {
    if (startedPathname === pathname) {
      return;
    }
    startedPathname = pathname;
    setTrackedPathname(pathname);
  }, [pathname]);

  return trackedPathname === pathname ? (
    <PageRouteParams>
      <DatadogAppRouter />
    </PageRouteParams>
  ) : null;
}

/**
 * ISS-11164. The vendor names a view from `useParams()`, and Next builds
 * `useParams()` from EVERY parallel route in the tree (`getSelectedParams`).
 * Unless the intercepted Settings modal is open, the `@settings` slot matches
 * its `[...unmatched]` catch-all on every org URL below the org root, so
 * `/acme/issues/ISS-1` arrives as
 * `{ orgSlug, slug, unmatched: ["issues", "ISS-1"] }`. The vendor splices
 * catch-alls first, so those views were all named `/[orgSlug]/[...unmatched]`.
 *
 * The page's route is the `children` chain alone, so the vendor sees Next's
 * own params computed over that chain: the naming stays vendor-owned and only
 * a slot's params are left out. A real catch-all page (the org 404, sign-up)
 * sits on that chain and keeps its `[...name]`.
 *
 * `NavigationPromisesContext` is cleared because dev-mode `useParams()` reads
 * it before `PathParamsContext`; production never sets it.
 *
 * These are Next's private `next/dist` modules, used on purpose: the public
 * `useSelectedLayoutSegments()` reads the same tree but returns bare values,
 * so a static `/branches` and a one-segment catch-all look identical. A Next
 * upgrade that moves them fails the build.
 * `__tests__/lib/datadog-rum-route-view-name.test.tsx` runs the real
 * `useParams()` and `getSelectedParams`, but over hand-built trees, so a Next
 * upgrade that changes the router tree's shape needs this re-checked by hand.
 */
function PageRouteParams({ children }: { children: ReactNode }) {
  const tree = useContext(GlobalLayoutRouterContext)?.tree;
  if (!tree) {
    return children;
  }
  return (
    <NavigationPromisesContext.Provider value={null}>
      <PathParamsContext.Provider
        value={getSelectedParams(childrenChain(tree))}
      >
        {children}
      </PathParamsContext.Provider>
    </NavigationPromisesContext.Provider>
  );
}

function childrenChain([
  segment,
  { children },
]: FlightRouterState): FlightRouterState {
  return [segment, children ? { children: childrenChain(children) } : {}];
}
