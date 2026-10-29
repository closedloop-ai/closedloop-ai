"use client";

import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import {
  ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";

/**
 * Whether the sidebar takes the SHAPE that ISS-8759 and ISS-9891 move things
 * into — the regrouped nav destinations, Search and Your Teams, and the non-nav
 * dev-mode switch all belonging to Labs rather than to the nav — and, at the
 * same key, whether the Labs ROUTES resolve.
 *
 * IT IS NOT THE MENU MOUNT. That was split onto `enable-labs-nav-section` and is
 * owned by `useLabsMenuVisible`, which ANDs this predicate in. Reading THIS hook
 * to decide whether the Labs section renders is the bug the split exists to
 * prevent: `labs-nav-section` is going to 100%, so such a read would open the
 * internal menu for every viewer.
 *
 * ONE module owns this question. ISS-10244 retired `nav-labs-move`, so the Labs
 * container is the only remaining answer to it, and `sidebar.tsx` — which picks
 * the whole sidebar SHAPE and decides which group each destination belongs to —
 * asks here once rather than re-deriving it at each site. A drift shows up as a
 * duplicated destination or control, or as none at all.
 *
 * The `mounted` guard mirrors every other gate in this shell: an unresolved flag
 * must not disagree with the server render, and the pre-resolution answer is the
 * container-absent shape — which since ISS-11248 is also the narrower one, so an
 * unresolved read can never flash an internal-only surface at a customer.
 *
 * Your Teams has no second home to be placed in. ISS-11248 retired its pre-Labs
 * placement outright: a `false` here means it is ABSENT, not relocated, which is
 * what web owed desktop, where it has never rendered. This predicate still
 * answers PLACEMENT for the nav destinations, Search and the dev-mode switch.
 *
 * ONE TRANSITION IS WORTH STATING, because it looks alarming and is not.
 * The web port adapter reads through `useFeatureFlag`, which applies the
 * ISS-7477 customer-view suppression (`packages/analytics/client.ts`), and the
 * Labs container key is not in `DEV_MODE_EXEMPT_FLAG_KEYS`. So the moment an
 * eligible viewer turns dev mode OFF, it resolves to a settled `false`, this
 * predicate flips, and the Labs
 * section — with the dev-mode switch inside it — unmounts. That is the CORRECT
 * customer view: Labs is an internal-only surface and hiding it is the entire
 * point of the feature.
 *
 * It is not a dead end, and it is not a dead end BY CONSTRUCTION rather than by
 * luck — but the predicate that guarantees it is `useLabsMenuVisible`, not this
 * one. The frame that takes the switch out of Labs is the frame that puts it
 * back, into the sidebar footer row, because BOTH ends of that move ask whether
 * the MENU renders: this predicate going false unmounts the menu, and so does
 * `enable-labs-nav-section` being closed, and the footer row appears in either
 * case. That row is the only fallback left now that ISS-10195 retired the
 * account menu (PR #6961; without it, suppression stranded a viewer in the
 * customer view with no way back). The fallback's own gate (`DEV_MODE_FLAG_KEY`)
 * IS exempt and therefore still resolves, so the viewer always has exactly one
 * way back out, and the transition hands orphaned focus to that way out
 * (`dev-mode-escape-focus.ts`).
 */
export function useLabsNavMoveVisible(): boolean {
  const mounted = useIsMounted();
  const labsSectionEnabled = useFeatureFlagEnabled(
    LABS_NAV_SECTION_FEATURE_FLAG_KEY
  );

  return mounted && labsSectionEnabled;
}

/**
 * Whether the Labs MENU renders — the section header, its rows, and the
 * dev-mode switch inside it — on either sidebar implementation.
 *
 * ONE module owns this question, and it is deliberately the same module that
 * owns the SHAPE: the two answers are a pair, and splitting them across files is
 * how a site ends up asking the wrong one. Both sidebars mount the section
 * through this hook and both footers ask it whether the dev-mode switch needs
 * its fallback row, so the two ends of that move cannot settle differently.
 *
 * IT IS AN `AND`, AND THAT IS THE POINT. `enable-labs-nav-section` alone would
 * be satisfiable with `labs-nav-section` closed, and the menu would then list
 * Insights, Packs, Lost work, TokenOps waste, Judges and Help — every one of
 * which gates its ROUTE on `labs-nav-section` through `FeatureFlagRouteGate`.
 * The viewer would click a rendered row and land on a not-found. Requiring the
 * shape here makes that combination unreachable rather than documented: the menu
 * cannot render without the shape that populates it and keeps its destinations
 * resolvable.
 *
 * The converse is the rollout this split exists for and is fully supported:
 * shape ON with this key closed gives every viewer the moved layout — the moved
 * destinations leave the nav and stay reachable by URL — with no Labs menu.
 */
export function useLabsMenuVisible(): boolean {
  const labsShapeVisible = useLabsNavMoveVisible();
  const labsMenuEnabled = useFeatureFlagEnabled(
    ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY
  );

  return labsShapeVisible && labsMenuEnabled;
}
