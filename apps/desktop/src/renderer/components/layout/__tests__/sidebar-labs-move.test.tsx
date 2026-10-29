/**
 * @file sidebar-labs-move.test.tsx
 * @description ISS-8759, desktop mirror (operator direction 2026-09-03): Search
 * moves into the Labs section and the Gateway sub-menu folds into Labs with it.
 *
 * Two halves, both asserted here because either alone passes against a broken
 * implementation:
 *
 *   1. the NAV MODEL — Approvals and Requests must DISPLAY under Labs. The
 *      declared `section` alone proves nothing (FOCUS_MODE overrides it, which is
 *      exactly how `gateway` used to survive the fold), so `navSectionFor` is the
 *      assertion that can fail. Everything is located by `NavId`, never by index
 *      into `NAV_ENTRIES`.
 *   2. the RENDER — Search lives inside the Labs collapsible body, so collapsing
 *      Labs takes Search with it. Operator ruling 2026-09-01: "search should not
 *      be visible when Labs is not present or collapsed." A test that only found
 *      the search box somewhere in the sidebar would pass with it still pinned
 *      above the nav.
 */
import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  NAV_SECTION_LABELS,
  NavSection,
  navItemsForSection,
  navSectionFor,
  pageTitleForNav,
} from "../../../navigation/nav-config";
import { NavId } from "../../../navigation/route-table";
import {
  LabsPageOutcome,
  resolveLabsPageOutcome,
} from "../../../navigation/use-nav-gates";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
} from "../../dashboard/dashboard-storage-keys";
import { Sidebar } from "../Sidebar";

const MOVED_GATEWAY_NAV_IDS = [NavId.Approvals, NavId.Requests] as const;
/** The Labs search box's accessible name (inline in `SidebarSearchForm`). */
const SEARCH_TEXTBOX_NAME = "Search";

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
  // Same partial bridge stub as the account-menu suite: the sidebar's session
  // limits and identity reads all fail closed when `desktopApi` is bare, which
  // is the signed-out contract and keeps this suite on the nav structure.
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

describe("ISS-8759 desktop mirror — Gateway folds into Labs", () => {
  it("DISPLAYS Approvals and Requests under Labs", () => {
    const labsIds = navItemsForSection(NavSection.Labs).map(
      (entry) => entry.id
    );
    // Guard against a vacuous pass if the section were ever empty.
    expect(labsIds.length).toBeGreaterThan(0);

    for (const navId of MOVED_GATEWAY_NAV_IDS) {
      // The load-bearing assertion: the DISPLAYED section, not merely that an
      // entry with this id exists somewhere in the nav.
      expect(navSectionFor(navId)).toBe(NavSection.Labs);
      expect(labsIds).toContain(navId);
    }
  });

  it("leaves the focus pages and the account section where they are", () => {
    // Blast radius: the fold must move ONE section, not collapse the nav.
    //
    // BEHAVIOR CHANGE (2026-09-04, restored Artifacts group): Sessions and
    // Branches moved out of the unlabeled top group and into the "Artifacts"
    // group they have always DECLARED — `artifacts` is now a FOCUS_MODE-exempt
    // section, so the declaration is honored instead of being overridden. The
    // focus pages are still exactly where the fold left them relative to Labs;
    // what changed is which group renders them, so this case asserts the new
    // placement rather than dropping the two ids. Dashboard is unmoved.
    const mainIds = navItemsForSection(NavSection.Main).map((e) => e.id);
    expect(mainIds).toContain(NavId.Dashboard);
    expect(navSectionFor(NavId.Sessions)).toBe(NavSection.Artifacts);
    expect(navSectionFor(NavId.Branches)).toBe(NavSection.Artifacts);
    for (const navId of MOVED_GATEWAY_NAV_IDS) {
      expect(mainIds).not.toContain(navId);
      expect(navSectionFor(navId)).not.toBe(NavSection.Artifacts);
    }
    // `account` is still FOCUS_MODE-exempt, alongside `artifacts`.
    expect(navSectionFor(NavId.Settings)).toBe(NavSection.Account);
  });

  it("retires the Gateway section rather than leaving a dead member", () => {
    const sections: string[] = Object.values(NavSection);
    expect(sections).not.toContain("gateway");
    expect(Object.keys(NAV_SECTION_LABELS)).not.toContain("gateway");
  });

  it("puts the moved queues inside the Labs container gate", () => {
    // The honest consequence of "under Labs" on desktop: a displayed Labs route
    // is unreachable while `labsNav` is off, exactly like every other Labs
    // destination. Asserted rather than left as a surprise.
    for (const pageId of MOVED_GATEWAY_NAV_IDS) {
      expect(
        resolveLabsPageOutcome({
          active: true,
          desktopFlagsResolved: true,
          labsNavOn: false,
          pageId,
        })
      ).toBe(LabsPageOutcome.Redirect);
      expect(
        resolveLabsPageOutcome({
          active: true,
          desktopFlagsResolved: true,
          labsNavOn: true,
          pageId,
        })
      ).toBe(LabsPageOutcome.Render);
    }
  });

  it("renders no Gateway section header in the sidebar", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: "Gateway" })).toBeNull();
  });

  it("renders the moved queues as rows of the Labs section", () => {
    renderSidebar();
    const labsRegion = expandLabs();
    for (const label of ["Approvals", "Requests"]) {
      expect(
        within(labsRegion).getByRole("link", { name: label })
      ).toBeTruthy();
    }
  });
});

describe("ISS-8759 desktop mirror — Search inside Labs", () => {
  it("shows no Search control on first load, because Labs ships closed", () => {
    renderSidebar();

    // Asserted as the intended state, not tolerated as a regression. Labs ships
    // collapsed (ISS-4478, reaffirmed by the operator 2026-09-03: "Labs ships
    // closed under the PostHog FF"), and the 2026-09-01 ruling puts Search
    // inside it — "search should not be visible when Labs is not present or
    // collapsed." So a first load legitimately has no search box on screen.
    expect(
      screen.getByRole("button", { name: "Labs" }).getAttribute("aria-expanded")
    ).toBe("false");
    expect(
      screen.queryByRole("textbox", { name: SEARCH_TEXTBOX_NAME })
    ).toBeNull();
  });

  it("renders the Search control inside the Labs section body once expanded", () => {
    renderSidebar();
    const labsRegion = expandLabs();
    const searchBox = screen.getByRole("textbox", {
      name: SEARCH_TEXTBOX_NAME,
    });
    // Containment, structurally: the control is a descendant of the Labs
    // collapsible body, not a sibling pinned above the nav.
    expect(labsRegion.contains(searchBox)).toBe(true);
  });

  it("hides Search again when the Labs section is re-collapsed", () => {
    renderSidebar();
    const labsToggle = screen.getByRole("button", { name: "Labs" });
    expandLabs();
    expect(
      screen.getByRole("textbox", { name: SEARCH_TEXTBOX_NAME })
    ).toBeTruthy();

    fireEvent.click(labsToggle);

    // Operator ruling 2026-09-01 — collapsing Labs takes Search with it.
    expect(labsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("textbox", { name: SEARCH_TEXTBOX_NAME })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: pageTitleForNav(NavId.Approvals) })
    ).toBeNull();
  });
});

/**
 * Expand the Labs section and return its body. The section ships collapsed
 * (ISS-4478), and the collapsible unmounts its children while closed, so
 * anything asserted about the section's CONTENTS has to open it first — the
 * same thing the desktop e2e helpers do.
 */
function expandLabs(): HTMLElement {
  const labsToggle = screen.getByRole("button", { name: "Labs" });
  if (labsToggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(labsToggle);
  }
  if (labsToggle.getAttribute("aria-expanded") !== "true") {
    throw new Error("Labs section did not expand");
  }
  return labsSectionBody();
}

/**
 * The Labs collapsible body. Resolved from the section's own toggle through
 * `aria-controls` so the lookup follows the primitive's wiring rather than a
 * DOM shape this suite would have to re-guess whenever the section is restyled.
 */
function labsSectionBody(): HTMLElement {
  const labsToggle = screen.getByRole("button", { name: "Labs" });
  const controlledId = labsToggle.getAttribute("aria-controls");
  if (!controlledId) {
    throw new Error("Labs toggle is missing aria-controls");
  }
  const body = document.getElementById(controlledId);
  if (!body) {
    throw new Error(`No element with id ${controlledId}`);
  }
  return body;
}
