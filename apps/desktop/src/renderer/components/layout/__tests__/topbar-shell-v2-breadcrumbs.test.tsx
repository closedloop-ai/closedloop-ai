/**
 * @file topbar-shell-v2-breadcrumbs.test.tsx
 * @description Breadcrumbs stay owned by the content header, and mounting the v2
 * sidebar does not move them (ISS-9734, PLN-2016 D10).
 *
 * Two halves, because either alone leaves the claim half-made:
 *
 *   1. the RENDER — the same route's Topbar trail is identical with
 *      `shell-sidebar-v2` on and off. The subject is TOPBAR: that it neither
 *      re-derives nor filters the trail on the key. The trail itself is built by
 *      `crumbsFor` in the test body, outside any provider, so a
 *      `buildBreadcrumbs` taught to read a flag would read the same default in
 *      both legs and this half would not notice.
 *   2. the MODEL — every destination the v2 sidebar offers carries the section
 *      crumb its TOP-LEVEL contract group names. Desktop's Topbar says
 *      "Labs / Agents" while the v2 tree nests Agents under Labs › Artifacts;
 *      that divergence is pinned here rather than changed.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  SHELL_NAVIGATION_GROUPS,
  SHELL_NAVIGATION_ITEMS,
  ShellNavigationGroupId,
  type ShellNavigationItemDescriptor,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildBreadcrumbs } from "../../../navigation/breadcrumb-model";
import {
  NAV_SECTION_LABELS,
  navSectionFor,
  pageTitleForNav,
} from "../../../navigation/nav-config";
import {
  DESKTOP_SHELL_ROUTE_NAV_IDS,
  hrefForNavId,
  NavId,
} from "../../../navigation/route-table";
import { Topbar } from "../Topbar";

const PINNED_ROUTES: readonly NavId[] = [
  NavId.Dashboard,
  NavId.Sessions,
  NavId.Agents,
];

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
});

afterEach(() => {
  cleanup();
});

function crumbsFor(navId: NavId) {
  return buildBreadcrumbs({
    agentsListHref: hrefForNavId(NavId.Agents),
    branchBackHref: hrefForNavId(NavId.Branches),
    branchBackLabel: BranchBackLabel.Branches,
    detailAgentSlug: null,
    detailBranchId: null,
    detailSessionId: null,
    detailTitle: null,
    detailTitleSettled: false,
    navId,
    sessionsListHref: hrefForNavId(NavId.Sessions),
  });
}

/** The trail the Topbar actually renders, under a shell with the key as given. */
function renderedTrail(navId: NavId, shellSidebarV2: boolean): string[] {
  const memoryNav = createMemoryNavigation({
    initialPath: hrefForNavId(navId),
  });
  render(
    <NavigationProvider adapter={memoryNav.adapter}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: shellSidebarV2 ? [SHELL_SIDEBAR_V2_FLAG_KEY] : [],
        })}
      >
        <SidebarProvider>
          <Topbar breadcrumbs={crumbsFor(navId)} />
        </SidebarProvider>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
  const trail = within(screen.getByRole("navigation", { name: "breadcrumb" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent?.trim() ?? "");
  cleanup();
  return trail;
}

/** The top-level contract group an item belongs to, walking parents. */
function topLevelGroupId(
  item: ShellNavigationItemDescriptor
): ShellNavigationGroupId {
  let groupId = item.groupId;
  for (;;) {
    const group = SHELL_NAVIGATION_GROUPS.find(
      (candidate) => candidate.id === groupId
    );
    if (group?.parentId === undefined) {
      return groupId;
    }
    groupId = group.parentId;
  }
}

describe("Topbar breadcrumbs under the v2 sidebar (PLN-2016 D10)", () => {
  it.each(PINNED_ROUTES)(
    "renders the same %s trail with shell-sidebar-v2 on and off",
    (navId) => {
      const off = renderedTrail(navId, false);
      const on = renderedTrail(navId, true);

      expect(on).toEqual(off);
      expect(on.at(-1)).toBe(crumbsFor(navId).at(-1)?.label);
    }
  );

  it("keeps every v2 row's label equal to the page heading's, which is derived from a different owner", () => {
    // The v2 row takes its label from the shell CONTRACT; the Topbar crumb and
    // each page `<h1>` take theirs from `pageTitleForNav` over `nav-config`
    // (FEA-3989, so the nav word and the heading cannot drift). They agree
    // today, and nothing structural makes them: there is no host-label seam on
    // `ShellNavigationRouteResolution` for the adapter to feed one from the
    // other. This is the guarantee, standing in for that seam.
    const drifted: string[] = [];
    for (const item of SHELL_NAVIGATION_ITEMS) {
      const navId =
        item.routeId === undefined
          ? null
          : DESKTOP_SHELL_ROUTE_NAV_IDS[item.routeId];
      if (navId === null || navId === undefined) {
        continue;
      }
      const heading = pageTitleForNav(navId);
      if (heading !== item.label) {
        drifted.push(`${navId}: row "${item.label}" vs heading "${heading}"`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it("gives every destination the v2 sidebar offers the section crumb its top-level group names", () => {
    const checked: string[] = [];
    for (const item of SHELL_NAVIGATION_ITEMS) {
      const navId =
        item.routeId === undefined
          ? null
          : DESKTOP_SHELL_ROUTE_NAV_IDS[item.routeId];
      if (navId === null || navId === undefined) {
        continue;
      }
      const group = topLevelGroupId(item);
      // Account destinations are workspace-menu commands, never a sidebar
      // section and never a section crumb.
      if (group === ShellNavigationGroupId.Account) {
        continue;
      }
      const section = navSectionFor(navId);
      const crumb = section === undefined ? null : NAV_SECTION_LABELS[section];
      const expected =
        group === ShellNavigationGroupId.Primary
          ? null
          : (SHELL_NAVIGATION_GROUPS.find((candidate) => candidate.id === group)
              ?.label ?? null);
      expect(`${navId}:${crumb}`).toBe(`${navId}:${expected}`);
      checked.push(navId);
    }
    // The walk is only a guarantee if it actually walked: every desktop-routed
    // shell destination, not a subset that happens to agree.
    expect(checked).toEqual([
      NavId.Dashboard,
      NavId.Documents,
      NavId.Issues,
      NavId.Sessions,
      NavId.Branches,
      NavId.Insights,
      NavId.Approvals,
      NavId.Requests,
      NavId.Agents,
      NavId.Packs,
      NavId.Plans,
      NavId.Help,
    ]);
  });
});
