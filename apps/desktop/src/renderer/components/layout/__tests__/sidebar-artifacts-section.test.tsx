/**
 * @file sidebar-artifacts-section.test.tsx
 * @description The desktop "Artifacts" sidebar group, restored 2026-09-04.
 *
 * The defect: `NAV_ENTRIES` has always DECLARED Sessions and Branches under
 * `section: NavSection.Artifacts`, but `artifacts` was not a FOCUS_MODE-exempt
 * section, so `displaySection` forced those two into `main` (they are in
 * FOCUSED_NAV_IDS) and everything else into Labs. Nothing could ever display
 * under `artifacts`: `navItemsForSection(NavSection.Artifacts)` returned `[]`,
 * and the Sidebar's `artifactItems.length > 0` guard therefore never rendered
 * the group. Desktop lost a whole sub-menu that web still shows.
 *
 * Three halves, because each alone passes against a broken implementation:
 *
 *   1. the NAV MODEL — Sessions and Branches must DISPLAY under `artifacts`.
 *      `navSectionFor` is the assertion that can fail; the declared `section`
 *      proves nothing, which is exactly how this bug survived.
 *   2. the RENDER — the "Artifacts" GROUP LABEL must be on screen and in the
 *      accessibility tree as a disclosure. The missing header is the actual
 *      user-visible defect, and an items-only assertion would not catch it:
 *      Sessions and Branches were both still rendered before this fix, just
 *      unlabeled in the top group.
 *   3. the SPILL GUARD — the exempt check runs BEFORE FOCUSED_NAV_IDS, so any
 *      entry still declaring `artifacts` would be pulled up into the restored
 *      group. Packs was the one such entry and now declares `labs`; Artifacts
 *      holds exactly Sessions + Branches, matching web.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { buildBreadcrumbs } from "../../../navigation/breadcrumb-model";
import {
  NAV_SECTION_LABELS,
  NavSection,
  navItemsForSection,
  navSectionFor,
  pageTitleForNav,
} from "../../../navigation/nav-config";
import { hrefForNavId, NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
} from "../../dashboard/dashboard-storage-keys";
import { Sidebar } from "../Sidebar";

const ARTIFACTS_NAV_IDS = [
  NavId.Documents,
  NavId.Issues,
  NavId.Sessions,
  NavId.Branches,
] as const;

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
});

beforeEach(() => {
  // Same partial bridge stub the sibling sidebar suites use: the sidebar's
  // session-limits and identity reads all fail closed when `desktopApi` is bare,
  // which is the signed-out contract and keeps this suite on the nav structure.
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
  window.localStorage.clear();
  // Re-seeded AFTER the clear, which is the whole point: this suite's subject is
  // the nav structure of an install that has run before. ISS-10195's guided
  // onboarding run arms on a first run, and an empty store is one — it would put
  // a blocking modal over the sidebar this suite asserts on.
  window.localStorage.setItem(dashboardOnboardedStorageKey, DASHBOARD_FLAG_SET);
});

afterEach(() => {
  cleanup();
});

function renderSidebar() {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <SidebarProvider>
          <Sidebar activeNav={NavId.Sessions} />
        </SidebarProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

describe("desktop Artifacts nav section — nav model", () => {
  it("DISPLAYS Documents, Issues, Sessions and Branches under Artifacts, in that order", () => {
    const artifactIds = navItemsForSection(NavSection.Artifacts).map(
      (entry) => entry.id
    );

    // The regression this pins: the section resolved to an EMPTY list, so a
    // `toContain` chain alone could not tell "restored" from "still broken".
    expect(artifactIds).toEqual([...ARTIFACTS_NAV_IDS]);
    for (const navId of ARTIFACTS_NAV_IDS) {
      // The load-bearing assertion: the DISPLAYED section, not the declared one.
      expect(navSectionFor(navId)).toBe(NavSection.Artifacts);
    }
  });

  it("keeps Packs in Labs rather than letting it spill into Artifacts", () => {
    // Packs declared `artifacts` and relied on the FOCUS_MODE fold to reach
    // Labs. Exempting `artifacts` makes the declaration authoritative again, so
    // without moving the declaration Packs would surface in the restored group.
    const labsIds = navItemsForSection(NavSection.Labs).map(
      (entry) => entry.id
    );
    expect(labsIds.length).toBeGreaterThan(0);
    expect(labsIds).toContain(NavId.Packs);
    expect(navSectionFor(NavId.Packs)).toBe(NavSection.Labs);
    expect(
      navItemsForSection(NavSection.Artifacts).map((entry) => entry.id)
    ).not.toContain(NavId.Packs);
  });

  it("leaves Dashboard as the top-level group and Settings in the account menu", () => {
    // Blast radius: restoring one group must not reshuffle the rest of the nav.
    expect(
      navItemsForSection(NavSection.Main).map((entry) => entry.id)
    ).toEqual([NavId.Dashboard]);
    expect(navSectionFor(NavId.Settings)).toBe(NavSection.Account);
  });

  it("labels the restored section, since an unlabeled group is the defect", () => {
    expect(NAV_SECTION_LABELS[NavSection.Artifacts]).toBe("Artifacts");
  });
});

describe("desktop Artifacts nav section — sidebar render", () => {
  it("renders the Artifacts group label as an expanded disclosure", () => {
    renderSidebar();

    // Accessibility tree, not just pixels: the group header is the disclosure
    // control for its rows, so it needs an accessible name AND `aria-expanded`.
    const artifactsToggle = screen.getByRole("button", { name: "Artifacts" });
    expect(artifactsToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders Sessions and Branches as rows of the Artifacts section", () => {
    renderSidebar();
    const artifactsRegion = artifactsSectionBody();

    for (const label of ["Sessions", "Branches"]) {
      expect(
        within(artifactsRegion).getByRole("link", { name: label })
      ).toBeTruthy();
    }
    // Containment, structurally: the rows are descendants of the Artifacts
    // collapsible body, not siblings of it in the unlabeled top group.
    expect(
      within(artifactsRegion).queryByRole("link", {
        name: pageTitleForNav(NavId.Packs),
      })
    ).toBeNull();
    expect(
      within(artifactsRegion).queryByRole("link", {
        name: pageTitleForNav(NavId.Dashboard),
      })
    ).toBeNull();
  });

  it("still renders Dashboard outside the Artifacts section", () => {
    renderSidebar();
    const artifactsRegion = artifactsSectionBody();
    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(artifactsRegion.contains(dashboardLink)).toBe(false);
  });
});

describe("desktop Artifacts nav section — topbar breadcrumb", () => {
  it("leads the Sessions list trail with the Artifacts section crumb", () => {
    // Stated rather than left as a surprise: `buildBreadcrumbs` prepends the
    // DISPLAYED section's label, so restoring the group also gives the Sessions
    // and Branches list pages an "Artifacts /" crumb — the same shape Labs
    // destinations already have ("Labs / Insights"). Pinned so the trail cannot
    // drift silently away from the sidebar grouping.
    expect(listBreadcrumbLabels(NavId.Sessions)).toEqual([
      "Artifacts",
      "Sessions",
    ]);
    expect(listBreadcrumbLabels(NavId.Branches)).toEqual([
      "Artifacts",
      "Branches",
    ]);
    // Dashboard's group has no label, so its trail stays a single segment.
    expect(listBreadcrumbLabels(NavId.Dashboard)).toEqual(["Dashboard"]);
  });
});

function listBreadcrumbLabels(navId: NavId): string[] {
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
  }).map((crumb) => crumb.label);
}

/**
 * The Artifacts collapsible body. Resolved from the section's own toggle through
 * `aria-controls` so the lookup follows the primitive's wiring rather than a DOM
 * shape this suite would have to re-guess whenever the section is restyled. The
 * section ships OPEN (`SidebarCollapsibleSection` defaults `defaultOpen` true and
 * the Sidebar passes no override), unlike Labs, so there is nothing to expand.
 */
function artifactsSectionBody(): HTMLElement {
  const toggle = screen.getByRole("button", { name: "Artifacts" });
  const controlledId = toggle.getAttribute("aria-controls");
  if (!controlledId) {
    throw new Error("Artifacts toggle is missing aria-controls");
  }
  const body = document.getElementById(controlledId);
  if (!body) {
    throw new Error(`No element with id ${controlledId}`);
  }
  return body;
}
