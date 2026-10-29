"use client";

import {
  useIdentityOrgPath,
  useInertNavigation,
  useNoPath,
  useNoRouteParams,
} from "@repo/navigation/inert-navigation";
import { useNavigationAdapterOptional } from "@repo/navigation/provider";
import { useCallback, useMemo } from "react";
import { PACKS_ROUTE_PATH, packDetailPath } from "../lib/pack-routes";

export type PacksRouteSelection = {
  /** The pack the current route addresses, or null on the discovery grid. */
  readonly selectedPackId: string | null;
  /** Navigates to a pack's detail route, or back to the grid on null. */
  readonly selectPack: (packId: string | null) => void;
  /** Href of the discovery grid, for the detail view's back affordance. */
  readonly backHref: string;
  /**
   * The current path is this shell's Packs surface.
   *
   * Routing is scoped to it on BOTH sides. The read side needs it because `id`
   * is not this route's param alone; the WRITE side needs it because the
   * desktop `PluginsPanel` is also mounted on the Agents view, where turning a
   * card click into a navigation would yank the reader onto another screen
   * instead of opening the detail in place.
   */
  readonly isPacksRoute: boolean;
};

/**
 * Pack-detail selection read from the ROUTE instead of component state
 * (ISS-6925).
 *
 * Shared by both shells because only the href shape is per-surface, and the
 * navigation port already owns that: `useOrgPath()` prefixes the org slug on
 * web and returns the path unchanged on desktop, whose route table maps
 * `/packs/:id` onto the same `id` param the web `[id]` segment produces. The
 * hook is called by each shell's HOST (the web catalog dashboard, the desktop
 * plugins panel) rather than by the shared workspace, so the workspace keeps
 * rendering under mount sites that have no real router — Storybook and the
 * component suites both mount a memory adapter whose params never change.
 */
export function usePacksRouteSelection(): PacksRouteSelection {
  // The adapter is referentially stable for the life of a mounted tree (the
  // port's own contract), so selecting each implementation from it keeps the
  // hook order fixed across renders — the same mechanism `useFeatureFlagResolved`
  // uses. Absent a provider every read degrades to an inert value instead of
  // throwing, because this hook renders inside the provider-free desktop mount
  // guard (FEA-4159).
  const adapter = useNavigationAdapterOptional();
  const readRouteParams = adapter?.useRouteParamsValue ?? useNoRouteParams;
  const readPath = adapter?.usePathValue ?? useNoPath;
  const readNavigation = adapter?.useNavigationActions ?? useInertNavigation;
  const readOrgPath = adapter?.useOrgPathBuilder ?? useIdentityOrgPath;

  const routeParams = readRouteParams();
  const path = readPath();
  const navigation = readNavigation();
  const buildOrgPath = readOrgPath();

  // A dynamic segment is typed `string | string[] | undefined`; only a single
  // non-empty segment addresses a pack.
  const rawId = routeParams.id;
  const candidateId = typeof rawId === "string" && rawId !== "" ? rawId : null;
  // `id` is not this route's param alone — `/agents/:id` produces one too, and
  // the desktop shell keeps visited views mounted. Confirming the current path
  // actually ENDS with this pack's detail segment is what stops a host that is
  // on screen under another route from reading that route's id as a pack id.
  // Compared as a suffix because the two shells disagree about the prefix: web
  // carries an org slug ("/acme/packs/x"), desktop does not ("/packs/x").
  const isPacksRoute =
    path === PACKS_ROUTE_PATH ||
    path.endsWith(PACKS_ROUTE_PATH) ||
    path.includes(`${PACKS_ROUTE_PATH}/`);
  const selectedPackId =
    candidateId && path.endsWith(packDetailPath(candidateId))
      ? candidateId
      : null;

  const selectPack = useCallback(
    (packId: string | null) => {
      navigation.navigate(
        buildOrgPath(packId ? packDetailPath(packId) : PACKS_ROUTE_PATH)
      );
    },
    [navigation, buildOrgPath]
  );

  const backHref = buildOrgPath(PACKS_ROUTE_PATH);

  return useMemo(
    () => ({ selectedPackId, selectPack, backHref, isPacksRoute }),
    [selectedPackId, selectPack, backHref, isPacksRoute]
  );
}
