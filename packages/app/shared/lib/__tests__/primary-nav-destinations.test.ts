import { describe, expect, it } from "vitest";
import {
  currentNavGroup,
  labsMovedNavGroup,
  NAV_LABS_MOVE_RETAINED_ROUTE_IDS,
  PRIMARY_NAV_DESTINATIONS,
  PrimaryNavGroup,
  WEB_CANONICAL_LANDING_HREF,
  WEB_SHELL_ROUTE_HREFS,
} from "../primary-nav-destinations";
import {
  SHELL_CANONICAL_LANDING_ROUTE_ID,
  SHELL_NAVIGATION_ITEMS,
  ShellNavigationGateKind,
  ShellNavigationItemKind,
  ShellNavigationRouteId,
  ShellNavigationSurface,
} from "../shell-navigation-contract";

describe("PRIMARY_NAV_DESTINATIONS — Sessions (FEA-4155 / ISS-8022)", () => {
  const sessions = PRIMARY_NAV_DESTINATIONS.find(
    (destination) => destination.path === "/sessions"
  );

  it("leaves Sessions ungated so no reintroduced flag can hide the nav entry", () => {
    expect(sessions).toBeDefined();
    // FEA-4155 made the Sessions route always-on and ISS-8022 retired the
    // `desktop-agent-session-sync` key this entry used to carry. The palette,
    // sidebar, and mobile-nav suites drive `useFeatureFlag` through a mock that
    // answers `enabled` for every key it is not explicitly switching off, so a
    // gate reintroduced here would render in all three and be caught by none.
    // This structural check is the one that fails — a gate would hide the only
    // path to a page that always renders.
    expect(sessions?.featureFlag).toBeUndefined();
  });
});

describe("PRIMARY_NAV_DESTINATIONS — shell navigation contract", () => {
  it("assigns every primary destination to a shell route id with the same web href", () => {
    const shellItemByRouteId = shellItemDescriptorByRouteId();

    for (const destination of PRIMARY_NAV_DESTINATIONS) {
      expect(WEB_SHELL_ROUTE_HREFS[destination.shellRouteId]).toBe(
        destination.path
      );
      expect(
        webFeatureFlagKeysFor(destination.shellRouteId, shellItemByRouteId)
      ).toEqual(
        destination.featureFlag === undefined ? [] : [destination.featureFlag]
      );
    }
  });

  it("covers Web-only Labs routes without conflating My Issues and My Tasks", () => {
    expect(WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.Insights]).toBe(
      "/insights"
    );
    expect(WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.LostWork]).toBe(
      "/insights/lost-work"
    );
    expect(WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.TokenOpsWaste]).toBe(
      "/insights/tokenops-waste"
    );
    expect(WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.Judges]).toBe(
      "/judges-analytics"
    );
    expect(WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.Packs]).toBe("/packs");
    expect(WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.MyIssues]).toBeNull();
    expect(WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.MyTasks]).toBe(
      "/my-tasks"
    );
  });

  it("derives the Web Master v2 landing href from the Dashboard shell route", () => {
    const dashboardDestination = PRIMARY_NAV_DESTINATIONS.find(
      (destination) =>
        destination.shellRouteId === ShellNavigationRouteId.Dashboard
    );

    expect(WEB_CANONICAL_LANDING_HREF).toBe(
      WEB_SHELL_ROUTE_HREFS[SHELL_CANONICAL_LANDING_ROUTE_ID]
    );
    expect(WEB_CANONICAL_LANDING_HREF).toBe("/dashboard");
    expect(WEB_CANONICAL_LANDING_HREF).toBe(dashboardDestination?.path);
    // One landing href, no per-experience split: the legacy tree used to land
    // on My Tasks, and a second constant is how that would come back.
    expect(WEB_CANONICAL_LANDING_HREF).not.toBe(
      WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.MyTasks]
    );
  });
});

function shellItemDescriptorByRouteId() {
  return new Map(
    SHELL_NAVIGATION_ITEMS.filter(
      (item) =>
        item.kind === ShellNavigationItemKind.Route &&
        item.routeId !== undefined
    ).map((item) => [item.routeId, item])
  );
}

function webFeatureFlagKeysFor(
  routeId: ShellNavigationRouteId,
  shellItemByRouteId: ReturnType<typeof shellItemDescriptorByRouteId>
) {
  return (
    shellItemByRouteId
      .get(routeId)
      ?.gates?.[ShellNavigationSurface.Web]?.filter(
        (gate) => gate.kind === ShellNavigationGateKind.WebFeatureFlag
      )
      .map((gate) => gate.key) ?? []
  );
}

describe("ISS-8759 — the Labs-move reading of the same destination list", () => {
  it("keeps only Dashboard, Documents, Issues, Sessions and Branches in their current group", () => {
    const retained = PRIMARY_NAV_DESTINATIONS.filter(
      (destination) => labsMovedNavGroup(destination) === destination.group
    ).map((destination) => destination.title);

    expect(retained).toEqual([
      "Dashboard",
      "Documents",
      "Issues",
      "Sessions",
      "Branches",
    ]);
  });

  it("reads every other destination into the Labs group", () => {
    const moved = PRIMARY_NAV_DESTINATIONS.filter(
      (destination) => labsMovedNavGroup(destination) === PrimaryNavGroup.Labs
    ).map((destination) => destination.title);

    // Order is the canonical list's, which is what the sidebar renders.
    expect(moved).toEqual(["Inbox", "My Tasks", "Agents"]);
  });

  it("leaves every destination in its declared group under the flag-off reading", () => {
    for (const destination of PRIMARY_NAV_DESTINATIONS) {
      expect(currentNavGroup(destination)).toBe(destination.group);
    }
    // The two readings must actually differ, or the assertion above would hold
    // for a `labsMovedNavGroup` that never moved anything.
    expect(
      PRIMARY_NAV_DESTINATIONS.some(
        (destination) =>
          labsMovedNavGroup(destination) !== currentNavGroup(destination)
      )
    ).toBe(true);
  });

  it("classifies every shell route id, so a new route cannot default into Labs unnoticed", () => {
    expect(Object.keys(NAV_LABS_MOVE_RETAINED_ROUTE_IDS).sort()).toEqual(
      Object.values(ShellNavigationRouteId).sort()
    );
  });
});
