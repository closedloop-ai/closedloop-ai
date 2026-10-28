/**
 * ISS-9395: the complete-surface registry checked against the two maps the
 * production shells actually navigate by, `WEB_SHELL_ROUTE_HREFS` and
 * `DESKTOP_SHELL_ROUTE_NAV_IDS`.
 *
 * This is what makes the registry's reachability half a CHECK rather than a
 * claim. A `SingleHost` entry names the host it is present on; if someone wires
 * a desktop nav id for a web-only route and forgets the registry, the shell maps
 * disagree and this suite reddens. That is the ISS-9218 lesson applied one level
 * up: an assertion verified against another entry beats a sentence a reader has
 * to grade.
 *
 * It lives in the desktop app because the desktop route table is app code:
 * `@repo/app` may not load it (`packages-never-import-apps` in
 * scripts/lint/layer-manifest.ts), and the desktop app may load both maps
 * (ISS-11433). The registry's own classification against a hand-written table
 * stays beside the registry in
 * `packages/app/shared/lib/__tests__/complete-surface-registry.test.ts`.
 */

import {
  COMPLETE_SURFACE_REGISTRY,
  SurfaceMastery,
} from "@repo/app/shared/lib/complete-surface-registry";
import { WEB_SHELL_ROUTE_HREFS } from "@repo/app/shared/lib/primary-nav-destinations";
import {
  ShellNavigationRouteId,
  ShellNavigationSurface,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { describe, expect, it } from "vitest";
import { DESKTOP_SHELL_ROUTE_NAV_IDS } from "../route-table";

/**
 * The single-host routes and the host each one IS reachable on, written
 * independently of both the registry and the two shell maps. Diagnostics and
 * Help left this table in ISS-10006, when web gained both routes.
 */
const EXPECTED_SINGLE_HOST_SIDE = {
  [ShellNavigationRouteId.Inbox]: ShellNavigationSurface.Web,
  [ShellNavigationRouteId.MyTasks]: ShellNavigationSurface.Web,
  [ShellNavigationRouteId.LostWork]: ShellNavigationSurface.Web,
  [ShellNavigationRouteId.TokenOpsWaste]: ShellNavigationSurface.Web,
  [ShellNavigationRouteId.Judges]: ShellNavigationSurface.Web,
  [ShellNavigationRouteId.Approvals]: ShellNavigationSurface.Desktop,
  [ShellNavigationRouteId.Requests]: ShellNavigationSurface.Desktop,
  [ShellNavigationRouteId.Plans]: ShellNavigationSurface.Desktop,
} as const;

/**
 * Everything here reads the two PRODUCTION maps and compares them to the
 * registry: two sources that are edited in different packages by different
 * changes.
 */
describe("registry agrees with the shells' own reachability maps", () => {
  it("lists every single-host route the registry declares, so a new one cannot skip the host check", () => {
    const registrySingleHost = Object.values(ShellNavigationRouteId).filter(
      (id) =>
        COMPLETE_SURFACE_REGISTRY[id].mastery === SurfaceMastery.SingleHost
    );
    expect(Object.keys(EXPECTED_SINGLE_HOST_SIDE).sort()).toEqual(
      registrySingleHost.sort()
    );
  });

  it("puts each single-host route on the host the shell maps expose", () => {
    for (const [routeId, expectedHost] of Object.entries(
      EXPECTED_SINGLE_HOST_SIDE
    )) {
      const id = routeId as ShellNavigationRouteId;
      const entry = COMPLETE_SURFACE_REGISTRY[id];
      expect(entry.mastery, `route "${routeId}"`).toBe(
        SurfaceMastery.SingleHost
      );
      if (entry.mastery !== SurfaceMastery.SingleHost) {
        continue;
      }
      expect(entry.host, `route "${routeId}"`).toBe(expectedHost);
      const onWeb = WEB_SHELL_ROUTE_HREFS[id] !== null;
      const onDesktop = DESKTOP_SHELL_ROUTE_NAV_IDS[id] !== null;
      expect(onWeb, `route "${routeId}" web reachability`).toBe(
        expectedHost === ShellNavigationSurface.Web
      );
      expect(onDesktop, `route "${routeId}" desktop reachability`).toBe(
        expectedHost === ShellNavigationSurface.Desktop
      );
    }
  });

  it("only calls a route mastered or partial when both shells reach it", () => {
    for (const id of Object.values(ShellNavigationRouteId)) {
      const { mastery } = COMPLETE_SURFACE_REGISTRY[id];
      if (
        mastery !== SurfaceMastery.Mastered &&
        mastery !== SurfaceMastery.Partial
      ) {
        continue;
      }
      expect(
        WEB_SHELL_ROUTE_HREFS[id],
        `route "${id}" web href`
      ).not.toBeNull();
      expect(
        DESKTOP_SHELL_ROUTE_NAV_IDS[id],
        `route "${id}" desktop nav id`
      ).not.toBeNull();
    }
  });

  /**
   * A route excluded from the program but still reachable would be a
   * contradiction: the product would ship a surface nobody had agreed to own.
   */
  it("only excludes a route both shells map to null", () => {
    for (const id of Object.values(ShellNavigationRouteId)) {
      if (
        COMPLETE_SURFACE_REGISTRY[id].mastery !==
        SurfaceMastery.IntentionallyExcluded
      ) {
        continue;
      }
      expect(WEB_SHELL_ROUTE_HREFS[id], `route "${id}" web href`).toBeNull();
      expect(
        DESKTOP_SHELL_ROUTE_NAV_IDS[id],
        `route "${id}" desktop nav id`
      ).toBeNull();
    }
  });
});
