import {
  SHELL_NAVIGATION_ITEMS,
  type ShellNavigationRouteId,
  ShellNavigationSurface,
  shellNavigationGateKeys,
} from "@repo/app/shared/lib/shell-navigation-contract";
import {
  buildShellNavigationSectionInputs,
  shellNavigationDestinationIds,
} from "@repo/app/shell/v2/lib/shell-navigation-sections";
import { describe, expect, it } from "vitest";
import { resolveDesktopRoute } from "../src/renderer/components/layout/shell-navigation/desktop-shell-route-resolution";
import {
  DESKTOP_SHELL_ROUTE_NAV_IDS,
  hrefForNavId,
  type NavId,
} from "../src/renderer/navigation/route-table";
import {
  DESKTOP_OPEN_NAV_GATES,
  DESKTOP_ROUTE_MATRIX,
} from "./e2e/helpers/shell-route-matrix";

/**
 * ISS-8361 — holds the Electron route matrix's written-out table to the
 * navigation contract, which the Electron spec itself cannot import.
 *
 * Without this, a destination the contract gains would render in the v2
 * desktop sidebar and never be visited, and the matrix would stay green; a
 * destination the contract drops would leave a step clicking a row that no
 * longer exists, which reads as a flaky launch rather than a stale table.
 */
describe("the desktop shell route matrix (ISS-8361)", () => {
  const offered = offeredDesktopDestinations();

  it("visits exactly the destinations the v2 desktop tree offers, in its order", () => {
    expect(offered.length).toBeGreaterThan(0);
    expect(DESKTOP_ROUTE_MATRIX.map((row) => row.id)).toEqual(
      offered.map((destination) => destination.id)
    );
  });

  it("names each row by the contract label and routes it by the desktop route table", () => {
    expect(
      DESKTOP_ROUTE_MATRIX.map(({ id, label, navId }) => ({ id, label, navId }))
    ).toEqual(offered.map(({ id, label, navId }) => ({ id, label, navId })));
    for (const { href, navId } of offered) {
      expect(href).toBe(hrefForNavId(navId));
    }
  });

  it("opens every gate the contract declares for desktop", () => {
    expect([...DESKTOP_OPEN_NAV_GATES].sort()).toEqual(
      [...shellNavigationGateKeys(ShellNavigationSurface.Desktop)].sort()
    );
  });
});

type OfferedDestination = {
  readonly id: string;
  readonly label: string;
  readonly navId: NavId;
  /** What `resolveDesktopRoute` answered, not what the route table says. */
  readonly href: string;
};

/**
 * What a fully-gated account is shown: the same builder and the same route
 * resolver the desktop adapter uses, with every gate open and nothing hidden.
 */
function offeredDesktopDestinations(): OfferedDestination[] {
  const hrefs = new Map<ShellNavigationRouteId, string | null>();
  const sections = buildShellNavigationSectionInputs({
    isGateOpen: () => true,
    offersControl: () => false,
    resolveRoute: (routeId) => {
      const resolution = resolveDesktopRoute(routeId, []);
      hrefs.set(routeId, resolution.href);
      return resolution;
    },
    surface: ShellNavigationSurface.Desktop,
  });
  return shellNavigationDestinationIds(sections).map((id) =>
    toOffered(id, hrefs)
  );
}

function toOffered(
  id: string,
  hrefs: ReadonlyMap<ShellNavigationRouteId, string | null>
): OfferedDestination {
  const item = SHELL_NAVIGATION_ITEMS.find((candidate) => candidate.id === id);
  const routeId = item?.routeId;
  const navId =
    routeId === undefined ? null : DESKTOP_SHELL_ROUTE_NAV_IDS[routeId];
  const href = routeId === undefined ? null : (hrefs.get(routeId) ?? null);
  if (item === undefined || navId === null || href === null) {
    throw new Error(`${id} is offered on desktop but has no desktop route`);
  }
  return { id, label: item.label, navId, href };
}
