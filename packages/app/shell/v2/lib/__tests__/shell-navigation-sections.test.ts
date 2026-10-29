import {
  NAVIGATION_DESTINATION_LIMIT,
  NavigationActorStanding,
  type NavigationDestinationProjection,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
} from "@repo/api/src/types/navigation-view-model";
import { describe, expect, it } from "vitest";
import { NAV_LABS_MOVE_RETAINED_ROUTE_IDS } from "../../../../shared/lib/primary-nav-destinations";
import {
  SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  SHELL_WEB_LABS_NAV_GATE_KEY,
  ShellNavigationGroupId,
  ShellNavigationItemId,
  ShellNavigationRouteId,
  ShellNavigationSurface,
} from "../../../../shared/lib/shell-navigation-contract";
import {
  buildNavigationSectionModel,
  type NavigationSectionInput,
  type NavigationSectionModel,
} from "../navigation-section-model";
import {
  buildShellNavigationSectionInputs,
  type ShellNavigationHostResolution,
  shellNavigationDestinationIds,
} from "../shell-navigation-sections";

describe("buildShellNavigationSectionInputs", () => {
  it.each([ShellNavigationSurface.Web, ShellNavigationSurface.Desktop])(
    "keeps only the routes ISS-8759 retains outside Labs on %s",
    (surface) => {
      const outsideLabs = modelFor(openHost(surface))
        .filter((section) => section.id !== ShellNavigationGroupId.Labs)
        .flatMap(entryIds);
      const retained = Object.entries(NAV_LABS_MOVE_RETAINED_ROUTE_IDS)
        .filter(([, kept]) => kept)
        .map(([routeId]) => routeId);

      expect([...outsideLabs].sort()).toEqual([...retained].sort());
    }
  );

  it("never emits the Account or Gateway groups, or the account destinations", () => {
    const host = openHost(ShellNavigationSurface.Web);

    const groupIds = inputSectionIds(buildShellNavigationSectionInputs(host));
    expect(groupIds).not.toContain(ShellNavigationGroupId.Account);
    expect(groupIds).not.toContain(ShellNavigationGroupId.Gateway);

    const rendered = modelFor(host).flatMap(entryIds);
    expect(rendered).not.toContain(ShellNavigationItemId.Settings);
    expect(rendered).not.toContain(ShellNavigationItemId.Diagnostics);
  });

  it("resolves the same ordered hierarchy on Web and Desktop for the same view model and offered set", () => {
    const web = modelFor(openHost(ShellNavigationSurface.Web));
    const desktop = modelFor(openHost(ShellNavigationSurface.Desktop));

    expect(desktop).toEqual(web);
    expect(web.map((section) => section.id)).toEqual([
      ShellNavigationGroupId.Primary,
      ShellNavigationGroupId.Artifacts,
      ShellNavigationGroupId.Labs,
    ]);
  });

  it("re-homes the Labs destinations on Web when the Labs group gate is closed", () => {
    const labsClosed = openHost(ShellNavigationSurface.Web, {
      isGateOpen: (gate) => gate.key !== SHELL_WEB_LABS_NAV_GATE_KEY,
    });

    // The SECTION goes; the surfaces inside it do not. `labs-nav-section` is
    // outside `DEV_MODE_EXEMPT_FLAG_KEYS`, so the customer view closes it for
    // every viewer — and collapsing the subtree with it would leave that viewer
    // Dashboard, Sessions and Branches, which is precisely why the legacy arm
    // reads `CURRENT_SIDEBAR_SHAPE` here instead of the moved grouping.
    expect(modelFor(labsClosed).map((section) => section.id)).toEqual([
      ShellNavigationGroupId.Primary,
      ShellNavigationGroupId.Artifacts,
    ]);
    // Insights, Packs, Lost work, TokenOps waste and Judges are absent on the
    // same render: each declares the container key as its OWN gate, so they are
    // removed by that gate rather than re-homed by this table.
    expect(
      shellNavigationDestinationIds(
        buildShellNavigationSectionInputs(labsClosed)
      )
    ).toEqual([
      ShellNavigationItemId.Dashboard,
      ShellNavigationItemId.Inbox,
      ShellNavigationItemId.MyTasks,
      ShellNavigationItemId.Documents,
      ShellNavigationItemId.Issues,
      ShellNavigationItemId.Sessions,
      ShellNavigationItemId.Branches,
      ShellNavigationItemId.Agents,
    ]);
  });

  it("re-homes Search above the primary rows and re-homes Your Teams nowhere", () => {
    const labsClosed = openHost(ShellNavigationSurface.Web, {
      isGateOpen: (gate) => gate.key !== SHELL_WEB_LABS_NAV_GATE_KEY,
    });

    const [primary, artifacts] = modelFor(labsClosed);

    // Search keeps the legacy fallback shape's `searchAboveNav` home.
    expect(primary.leadingControlIds).toEqual([ShellNavigationItemId.Search]);
    // ISS-11248 retired Your Teams' pre-Labs home, so a closed container leaves
    // it out of the model entirely rather than after the Artifacts rows. The
    // Search assertion above is the positive sibling on the same render: this
    // host DOES re-home what still has a home, so the empty list is the table's
    // answer and not a model that failed to build.
    expect(artifacts.trailingControlIds).toEqual([]);
  });

  it("re-homes only what the Desktop container does not gate itself when labsNav is closed", () => {
    const labsClosed = openHost(ShellNavigationSurface.Desktop, {
      isGateOpen: (gate) => gate.key !== SHELL_DESKTOP_LABS_NAV_GATE_KEY,
    });

    // Desktop's container is a REACHABILITY gate for the items that declare it
    // (ISS-5037: hidden from the sidebar and unreachable by hash), and those
    // items declare it themselves. So Agents and Routines stay gone here while
    // the same re-homing brings Inbox and My Tasks back — one table, two
    // answers, because the contract already carries the difference. Documents
    // and Issues live in Artifacts outside the container, so it never touches
    // them.
    expect(
      shellNavigationDestinationIds(
        buildShellNavigationSectionInputs(labsClosed)
      )
    ).toEqual([
      ShellNavigationItemId.Dashboard,
      ShellNavigationItemId.Inbox,
      ShellNavigationItemId.MyTasks,
      ShellNavigationItemId.Documents,
      ShellNavigationItemId.Issues,
      ShellNavigationItemId.Sessions,
      ShellNavigationItemId.Branches,
    ]);
  });

  it("keeps a row that is not a link for a route with no href, and no row for a route the host does not offer", () => {
    const host = openHost(ShellNavigationSurface.Web, {
      resolveRoute: (routeId) => {
        if (routeId === ShellNavigationRouteId.Dashboard) {
          return { offered: true, href: null };
        }
        if (routeId === ShellNavigationRouteId.Branches) {
          return { offered: false, href: "/branches" };
        }
        return { offered: true, href: `/${routeId}` };
      },
    });

    const [primary, artifacts] = modelFor(host);

    expect(primary.entries).toEqual([
      expect.objectContaining({
        href: null,
        id: ShellNavigationItemId.Dashboard,
        navigable: false,
      }),
    ]);
    expect(artifacts.entries.map((entry) => entry.id)).toEqual([
      ShellNavigationItemId.Documents,
      ShellNavigationItemId.Issues,
      ShellNavigationItemId.Sessions,
    ]);
  });

  it("puts Search before the Labs rows and every Teams and Footer control after", () => {
    const labs = modelFor(openHost(ShellNavigationSurface.Web)).find(
      (section) => section.id === ShellNavigationGroupId.Labs
    );

    expect(labs?.leadingControlIds).toEqual([ShellNavigationItemId.Search]);
    expect(labs?.trailingControlIds).toEqual([]);
    expect(
      labs?.sections.map((section) => [
        section.id,
        section.leadingControlIds,
        section.trailingControlIds,
      ])
    ).toEqual([
      [ShellNavigationGroupId.LabsArtifacts, [], []],
      [
        ShellNavigationGroupId.LabsTeams,
        [],
        [ShellNavigationItemId.Teams, ShellNavigationItemId.TeamFavorites],
      ],
      [ShellNavigationGroupId.LabsFooter, [], [ShellNavigationItemId.DevMode]],
    ]);
  });

  it("omits the controls a host does not offer, and a headless group left with none", () => {
    const searchOnly = openHost(ShellNavigationSurface.Desktop, {
      offersControl: (itemId) => itemId === ShellNavigationItemId.Search,
    });

    const labs = modelFor(searchOnly).find(
      (section) => section.id === ShellNavigationGroupId.Labs
    );

    expect(labs?.leadingControlIds).toEqual([ShellNavigationItemId.Search]);
    expect(labs?.sections.map((section) => section.id)).toEqual([
      ShellNavigationGroupId.LabsArtifacts,
    ]);
  });

  it("opens Artifacts and Labs › Artifacts, closes Labs, and never collapses Primary or the headless Labs groups", () => {
    const inputs = buildShellNavigationSectionInputs(
      openHost(ShellNavigationSurface.Web)
    );

    expect(disclosureOf(inputs)).toEqual([
      [ShellNavigationGroupId.Primary, false, true],
      [ShellNavigationGroupId.Artifacts, true, true],
      [ShellNavigationGroupId.Labs, true, false],
      [ShellNavigationGroupId.LabsArtifacts, true, true],
      [ShellNavigationGroupId.LabsTeams, false, true],
      [ShellNavigationGroupId.LabsFooter, false, true],
    ]);
  });

  it("carries the host's badge cap and count noun onto the destination", () => {
    const countNoun = {
      one: "recently finished session",
      other: "recently finished sessions",
    };
    const host = openHost(ShellNavigationSurface.Desktop, {
      resolveRoute: (routeId) =>
        routeId === ShellNavigationRouteId.Agents
          ? { badgeMax: 9, countNoun, href: "/agents", offered: true }
          : { href: `/${routeId}`, offered: true },
    });

    const agents = buildShellNavigationSectionInputs(host)
      .find((section) => section.id === ShellNavigationGroupId.Labs)
      ?.sections?.find(
        (section) => section.id === ShellNavigationGroupId.LabsArtifacts
      )
      ?.destinations?.find(
        (destination) => destination.id === ShellNavigationItemId.Agents
      );

    expect(agents).toMatchObject({ badgeMax: 9, countNoun });
  });
});

describe("shellNavigationDestinationIds", () => {
  it("asks only about route destinations the host offers, nested ones included, and never about controls", () => {
    const host = openHost(ShellNavigationSurface.Web, {
      resolveRoute: (routeId) => ({
        href: `/${routeId}`,
        offered: routeId !== ShellNavigationRouteId.Packs,
      }),
    });

    const ids = shellNavigationDestinationIds(
      buildShellNavigationSectionInputs(host)
    );

    expect(ids).toContain(ShellNavigationItemId.Agents);
    expect(ids).not.toContain(ShellNavigationItemId.Packs);
    expect(ids).not.toContain(ShellNavigationItemId.Search);
    expect(ids.length).toBeLessThanOrEqual(NAVIGATION_DESTINATION_LIMIT);
  });
});

function openHost(
  surface: ShellNavigationSurface,
  overrides: Partial<ShellNavigationHostResolution> = {}
): ShellNavigationHostResolution {
  return {
    surface,
    resolveRoute: (routeId) => ({ href: `/${routeId}`, offered: true }),
    isGateOpen: () => true,
    offersControl: () => true,
    ...overrides,
  };
}

function modelFor(
  host: ShellNavigationHostResolution
): readonly NavigationSectionModel[] {
  const inputs = buildShellNavigationSectionInputs(host);
  return buildNavigationSectionModel(
    inputs,
    readyViewModel(shellNavigationDestinationIds(inputs))
  );
}

function readyViewModel(ids: readonly string[]): NavigationViewModel {
  const destinations: Record<string, NavigationDestinationProjection> = {};
  for (const id of ids) {
    destinations[id] = { status: NavigationDestinationStatus.Ready };
  }
  return {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
    organizationId: "org_1",
    destinations,
  };
}

function entryIds(section: NavigationSectionModel): string[] {
  return [
    ...section.entries.map((entry) => entry.id),
    ...section.sections.flatMap(entryIds),
  ];
}

function inputSectionIds(
  sections: readonly NavigationSectionInput[]
): string[] {
  return sections.flatMap((section) => [
    section.id,
    ...inputSectionIds(section.sections ?? []),
  ]);
}

function disclosureOf(
  sections: readonly NavigationSectionInput[]
): [string, boolean, boolean][] {
  return sections.flatMap((section) => [
    [section.id, section.collapsible, section.defaultOpen] as [
      string,
      boolean,
      boolean,
    ],
    ...disclosureOf(section.sections ?? []),
  ]);
}
