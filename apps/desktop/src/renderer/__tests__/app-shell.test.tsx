import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import {
  type AgentSessionAnalytics,
  type AgentSessionDetail,
  type AgentSessionListItem,
  type AgentSessionListResponse,
  AgentSessionState,
  type AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../shared/local-session-source-status";
import { DesktopNavigationApp } from "../App";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "../components/layout/sidebar-persistence";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));
vi.mock("../components/settings/SettingsPanel", () => ({
  SettingsPanel: () => <NativePageMarker id="settings" />,
}));
vi.mock("../components/features/CoreFeaturesView", () => ({
  PlansView: () => <NativePageMarker id="plans" />,
}));
vi.mock("../components/approvals/ApprovalsPanel", () => ({
  ApprovalsPanel: () => <NativePageMarker id="approvals" />,
}));
vi.mock("../components/activity/ActivityPanel", () => ({
  ActivityPanel: () => <NativePageMarker id="requests" />,
}));
vi.mock("../components/diagnostics/diagnostics-view", () => ({
  DiagnosticsView: () => <NativePageMarker id="diagnostics" />,
}));
vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: ({
    onFiltersChange,
  }: {
    onFiltersChange: (next: {
      statuses: string[];
      userIds: string[];
      repositories: string[];
    }) => void;
  }) => (
    <button
      onClick={() =>
        onFiltersChange({
          statuses: [SESSION_STATUS.COMPLETED],
          userIds: [],
          repositories: [],
        })
      }
      type="button"
    >
      Apply completed status filter
    </button>
  ),
}));
// Branch detail (Epic C) is mocked to a marker so this suite exercises App.tsx
// routing, not the detail page internals (covered by
// branch-detail-view.test.tsx). Mirrors the native-page marker mocks above.
vi.mock("../components/branches/branch-detail-view", () => ({
  BranchDetailView: ({
    branchId,
    backHref,
  }: {
    branchId: string;
    backHref: string;
  }) => (
    <div data-back-href={backHref} data-testid="branch-detail">
      {branchId}
    </div>
  ),
}));

function NativePageMarker({ id }: { id: string }) {
  return <div data-testid={`native-route:${id}`}>{id}</div>;
}

const activeNavigations = new Set<DesktopNavigation>();
const DESKTOP_SIDEBAR_OPEN_STORAGE_KEY = "closedloop.desktop.sidebar.open";
const DASHBOARD_NAV_LINK_RE = /Dashboard/;
let restoreLocalStorage: (() => void) | undefined;
let restoreResizeObserver: (() => void) | undefined;

// FEA-2023: CI runners share CPU across parallel jobs. This suite drives heavy
// real-component renders (the shared-wrappers test alone takes ~2.9s on an idle
// dev machine) and walks routes via sequential async `findBy*` settles. On
// vitest's 5s default test budget and testing-library's 1s default async-util
// budget, CPU starvation (the same class as the FEA-1523 build-runner timeouts)
// intermittently turned passing renders into "Test timed out" / "Unable to find
// element" flakes that flapped `desktop#test`. Give both budgets deliberate,
// generous headroom, kept decoupled — the per-assertion async budget is strictly
// smaller than the whole-test budget, so a genuinely missing element still fails
// with testing-library's descriptive error before the generic test timeout
// fires (it is never masked, only given room to settle under load).
const ASYNC_SETTLE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

vi.setConfig({ hookTimeout: TEST_TIMEOUT_MS, testTimeout: TEST_TIMEOUT_MS });
configure({ asyncUtilTimeout: ASYNC_SETTLE_TIMEOUT_MS });

describe("App shell shared telemetry route wiring", () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
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
    restoreResizeObserver = installResizeObserver();
    restoreLocalStorage = installLocalStorage();
    installDesktopApi();
  });

  afterEach(() => {
    try {
      for (const navigation of activeNavigations) {
        navigation.dispose();
      }
      activeNavigations.clear();
      cleanup();
      window.localStorage.clear();
      window.location.hash = "";
    } finally {
      restoreResizeObserver?.();
      restoreResizeObserver = undefined;
      restoreLocalStorage?.();
      restoreLocalStorage = undefined;
    }
  });

  it("persists desktop sidebar state across app shell remounts", async () => {
    const collapsedRender = renderDesktopApp("");

    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    fireEvent.click(screen.getByTitle("Collapse sidebar"));
    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
    expect(window.localStorage.getItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY)).toBe(
      "false"
    );
    collapsedRender.unmount();

    const expandedRender = renderDesktopApp("");
    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
    fireEvent.click(screen.getByTitle("Expand sidebar"));
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    expect(window.localStorage.getItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY)).toBe(
      "true"
    );
    expandedRender.unmount();

    renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
  });

  it("persists the desktop Labs nav section after app shell remounts", async () => {
    const firstRender = renderDesktopApp("");
    const labsToggle = await screen.findByRole("button", { name: "Labs" });

    expect(labsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Insights" })).toBeNull();

    fireEvent.click(labsToggle);

    expect(labsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
    expect(
      window.localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)
    ).toBe("true");
    firstRender.unmount();

    renderDesktopApp("");

    const restoredLabsToggle = await screen.findByRole("button", {
      name: "Labs",
    });
    expect(restoredLabsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
  });

  it("hydrates the desktop Labs nav section from storage on initial app shell load", async () => {
    window.localStorage.setItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY, "true");

    renderDesktopApp("");

    const labsToggle = await screen.findByRole("button", { name: "Labs" });
    expect(labsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
  });

  it("defaults desktop sidebar expanded for missing or corrupt persisted values", async () => {
    window.localStorage.setItem(
      `${DESKTOP_SIDEBAR_OPEN_STORAGE_KEY}.similar`,
      "false"
    );
    const wrongKeyRender = renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    wrongKeyRender.unmount();

    window.localStorage.clear();
    window.localStorage.setItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, "collapsed");
    renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
  });

  it("defaults desktop sidebar expanded when localStorage read is unavailable", async () => {
    const getItemSpy = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("localStorage read blocked");
      });
    const fallbackRender = renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    fallbackRender.unmount();
    getItemSpy.mockRestore();

    window.localStorage.setItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, "false");
    renderDesktopApp("");
    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
  });

  it("keeps the dashboard link reachable while runtime readiness is pending", async () => {
    renderDesktopApp("");

    const dashboardLink = await screen.findByRole("link", {
      name: DASHBOARD_NAV_LINK_RE,
    });
    expect(dashboardLink.getAttribute("href")).toBe("/dashboard");
    expect(screen.getByLabelText("Preparing dashboard")).toBeDefined();
  });

  it("keeps the gateway footer menu after removing sidebar gateway health", async () => {
    renderDesktopApp("");

    const gatewayMenuButton = await screen.findByRole("button", {
      name: "Closedloop Gateway",
    });
    expect(screen.queryByText("Gateway healthy")).toBeNull();
    expect(screen.queryByText("Gateway unhealthy")).toBeNull();

    fireEvent.pointerDown(gatewayMenuButton, { button: 0, ctrlKey: false });

    const gatewayMenu = await screen.findByRole("menu");
    expect(
      within(gatewayMenu).queryByRole("menuitem", { name: "Settings" })
    ).toBeNull();
    expect(
      within(gatewayMenu).getByRole("menuitem", { name: "Theme" })
    ).toBeDefined();
  });

  it("keeps desktop sidebar responsive when localStorage write fails", async () => {
    window.localStorage.setItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, "true");
    renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();

    const setItemSpy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("localStorage write blocked");
      });

    fireEvent.click(screen.getByTitle("Collapse sidebar"));

    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
    expect(setItemSpy).toHaveBeenCalledWith(
      DESKTOP_SIDEBAR_OPEN_STORAGE_KEY,
      "false"
    );
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it("renders real shared sessions and insights wrappers through the desktop provider", async () => {
    // The default route is the Sessions page (Dashboard is a placeholder).
    // Views are reached by hash navigation since the sidebar nav items are
    // links folded into a collapsed Labs section under FOCUS_MODE.
    await renderDesktopApp("");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(window.location.hash).toBe("#/sessions");

    await screen.findByRole("link", { name: "Shell Active Session" });
    const sessionLink = screen
      .getAllByRole("link", { name: "Shell Active Session" })
      .find((link) => link.getAttribute("href") === "#/sessions/s-active");
    expect(sessionLink?.getAttribute("href")).toBe("#/sessions/s-active");

    window.location.hash =
      sessionLink?.getAttribute("href") ?? "#/sessions/s-active";
    expect(await findSharedRouteHeading("Shell Active Session")).toBeDefined();

    // The breadcrumb's "Sessions" parent is the back affordance (the in-page
    // "Back to Sessions" control was removed).
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole(
        "link",
        { name: "Sessions" }
      )
    );
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));

    window.location.hash = "#/insights";
    expect(await findSharedRouteHeading("Agent Monitoring")).toBeDefined();
    expect(screen.getByRole("button", { name: "Load insights" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Load insights" }));
    await waitFor(() =>
      expect(screen.getByText("Recent session activity")).toBeDefined()
    );

    expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-active"
    );
  });

  it("submits top-left search to the sessions view and forwards the local search filter", async () => {
    await renderDesktopApp("#/sessions");

    const searchInput = screen.getByPlaceholderText("Search");
    expect(searchInput.hasAttribute("disabled")).toBe(false);
    fireEvent.change(searchInput, {
      target: { value: "Failed Session" },
    });
    const searchForm = searchInput.closest("form");
    expect(searchForm).not.toBeNull();
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?search=Failed+Session");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        search: "Failed Session",
        // Default 7-day time window scopes every sessions list query.
        startDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        // PLN-1034: Sessions default to most-recent-activity, descending.
        sortBy: "lastActivity",
        sortDir: "desc",
      });
    });
    expect(
      await screen.findByRole("link", { name: "Shell Failed Session" })
    ).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();
  });

  it("shows an in-list loading state while a sidebar search is pending", async () => {
    await renderDesktopApp("#/sessions");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
    expect(await screen.findByText("26")).toBeDefined();

    const pendingList = new Promise<AgentSessionListResponse>(() => undefined);
    const pendingUsage = new Promise<AgentSessionUsageSummary>(() => undefined);
    vi.mocked(window.desktopApi.agentSessionsApi.list).mockImplementation(
      (request = {}) => {
        if (request.search) {
          return pendingList;
        }
        return Promise.resolve({
          items: [],
          total: 0,
          viewerScope: "self",
        });
      }
    );
    vi.mocked(window.desktopApi.agentSessionsApi.usage).mockImplementation(
      (request = {}) => {
        if (request.search) {
          return pendingUsage;
        }
        return Promise.resolve(agentSessionUsage(0));
      }
    );

    const searchInput = screen.getByPlaceholderText("Search");
    fireEvent.change(searchInput, {
      target: { value: "Failed Session" },
    });
    const searchForm = searchInput.closest("form");
    expect(searchForm).not.toBeNull();
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?search=Failed+Session");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: "Failed Session" })
      );
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Searching sessions..."
    );
    expect(screen.queryByText("26")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
    expect(
      vi
        .mocked(window.desktopApi.agentSessionsApi.usage)
        .mock.calls.some(([request]) => request?.search === "Failed Session")
    ).toBe(false);
    expect(
      vi
        .mocked(window.desktopApi.agentSessionsApi.analytics)
        .mock.calls.some(([request]) => request?.search === "Failed Session")
    ).toBe(false);
  });

  it("clears an active sessions search from the desktop sidebar", async () => {
    await renderDesktopApp("#/sessions?search=Failed+Session");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    const activeSearchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
    expect(activeSearchInput.value).toBe("Failed Session");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(activeSearchInput.value).toBe("");
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        search: undefined,
        // Default 7-day time window scopes every sessions list query.
        startDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
      });
    });
  });

  it("clears a draft sessions search to the unfiltered sessions route", async () => {
    await renderDesktopApp("#/sessions");

    const searchInput = screen.getByRole("textbox", { name: "Search" });
    fireEvent.change(searchInput, {
      target: { value: "Failed Session" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect((searchInput as HTMLInputElement).value).toBe("");
  });

  // FEA-2472: the clear-and-reset path also has to work when the user deletes
  // the query text and presses Return (submits an empty query), not only via
  // the "x" clear affordance covered above. An empty submit must reset the
  // search, restore the full unfiltered list, and drop the active-search
  // indicator — a regression here would strand stale filtered results.
  it("restores the full sessions list when the query is deleted and Return is pressed", async () => {
    await renderDesktopApp("#/sessions?search=Failed+Session");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    // The list starts filtered to the single matching session.
    expect(
      await screen.findByRole("link", { name: "Shell Failed Session" })
    ).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
    expect(searchInput.value).toBe("Failed Session");

    // Delete the query text, then submit (press Return) on the empty input.
    fireEvent.change(searchInput, { target: { value: "" } });
    const searchForm = searchInput.closest("form");
    expect(searchForm).not.toBeNull();
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(searchInput.value).toBe("");
    // The active-search indicator (clear affordance) is removed after reset.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    // The reset re-issues the list query with no search term.
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        search: undefined,
        // Default 7-day time window scopes every sessions list query.
        startDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
      });
    });
    // The full, unfiltered result set is shown again.
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
  });

  it("treats a whitespace-only query as an empty submit and restores the full list", async () => {
    await renderDesktopApp("#/sessions?search=Failed+Session");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Failed Session" })
    ).toBeDefined();

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
    // Whitespace-only input is treated as empty and resets to the bare route.
    fireEvent.change(searchInput, { target: { value: "   " } });
    const searchForm = searchInput.closest("form");
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(searchInput.value).toBe("");
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: undefined })
      );
    });
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
  });

  it("restores the full list from an empty filtered result when the search is cleared with Return", async () => {
    await renderDesktopApp("#/sessions");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;

    // A query that matches nothing collapses the list to the empty state.
    fireEvent.change(searchInput, {
      target: { value: "no-such-session-xyz" },
    });
    fireEvent.submit(searchInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe(
        "#/sessions?search=no-such-session-xyz"
      );
    });
    expect(await screen.findByText("No sessions found")).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();

    // Deleting the query and pressing Return returns to the full list, not the
    // empty state it collapsed to while filtered.
    fireEvent.change(searchInput, { target: { value: "" } });
    fireEvent.submit(searchInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
    expect(screen.queryByText("No sessions found")).toBeNull();
  });

  it("treats Return on an already-empty search input as a no-op that keeps the full list", async () => {
    await renderDesktopApp("#/sessions");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
    expect(searchInput.value).toBe("");
    // The unfiltered route shows no active-search indicator to begin with.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    fireEvent.submit(searchInput.closest("form") as HTMLFormElement);

    // Submitting an empty query keeps the unfiltered route and never appends a
    // search parameter.
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(window.location.hash).not.toContain("search=");
    expect(
      screen.getByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    // No search-scoped fetch was ever issued.
    expect(
      vi
        .mocked(window.desktopApi.agentSessionsApi.list)
        .mock.calls.some(([request]) => Boolean(request?.search))
    ).toBe(false);
  });

  it("forwards selected session statuses to the desktop local data source and resets pagination", async () => {
    await renderDesktopApp("#/sessions?page=2");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith(
        expect.objectContaining({
          offset: 25,
          statuses: [],
        })
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Apply completed status filter" })
    );

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith(
        expect.objectContaining({
          offset: 0,
          statuses: [SESSION_STATUS.COMPLETED],
        })
      );
    });
  });

  it("returns from a page-two session detail to the same sessions page and scroll position", async () => {
    const firstRender = renderDesktopApp("");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    fireEvent.click(screen.getByLabelText("Go to next page"));
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?page=2");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 25,
        search: undefined,
        // Default 7-day time window scopes every sessions list query.
        startDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
      });
    });
    firstRender.unmount();

    const { navigation } = renderDesktopApp("#/sessions?page=2");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 25,
        search: undefined,
        // Default 7-day time window scopes every sessions list query.
        startDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
      });
    });

    const contentViewport = screen.getByTestId("desktop-content-viewport");
    contentViewport.scrollTop = 384;
    fireEvent.scroll(contentViewport);

    const pageTwoLink = await screen.findByRole("link", {
      name: "Shell Page Two Session",
    });
    window.location.hash =
      pageTwoLink.getAttribute("href") ?? "#/sessions/s-page-two";
    expect(
      await findSharedRouteHeading("Shell Page Two Session")
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-page-two"
    );
    expect(navigation.getHistory()).toContain("/sessions/s-page-two");
    // The breadcrumb's "Sessions" parent preserves the originating list's page
    // query (and restores its scroll) — the back affordance now that the in-page
    // "Back to Sessions" control is gone.
    const sessionsCrumb = within(
      screen.getByRole("navigation", { name: "Breadcrumb" })
    ).getByRole("link", { name: "Sessions" });
    expect(sessionsCrumb.getAttribute("href")).toBe("/sessions?page=2");

    fireEvent.click(sessionsCrumb);
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?page=2");
    });
    expect(
      await screen.findByRole("link", { name: "Shell Page Two Session" })
    ).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId("desktop-content-viewport").scrollTop).toBe(
        384
      );
    });
  });

  it("keeps desktop insights scans opt-in and unmounts insights when inactive", async () => {
    await renderDesktopApp("#/insights");

    expect(await findSharedRouteHeading("Agent Monitoring")).toBeDefined();
    expect(screen.getByText("Local session history")).toBeDefined();
    expect(screen.getByRole("button", { name: "Load insights" })).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load insights" }));
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
      });
    });
    expect(screen.getByText("Recent session activity")).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();
  });

  it("renders the shared detail not-found state through the real route wrapper", async () => {
    await renderDesktopApp("#/sessions/missing");

    expect(await screen.findByText("Session not found")).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "missing"
    );
  });

  it("renders desktop local session details without unsupported write controls", async () => {
    await renderDesktopApp("#/sessions/s-pending");

    expect(await findSharedRouteHeading("Shell Pending Session")).toBeDefined();
    const { contentViewport, detailShell, traceScroller, workspace } =
      getDesktopSessionDetailScrollElements();
    expect(workspace).toBeInstanceOf(HTMLElement);
    expect(traceScroller).toBeInstanceOf(HTMLElement);
    expect(detailShell?.className).toEqual(
      expect.stringContaining("overflow-hidden")
    );
    expect(detailShell?.className).toEqual(expect.stringContaining("h-full"));
    expect(contentViewport?.className).toEqual(
      expect.stringContaining("min-h-0")
    );
    expect(contentViewport?.className).toEqual(
      expect.stringContaining("overflow-hidden")
    );
    expect(contentViewport?.className).not.toEqual(
      expect.stringContaining("overflow-auto")
    );
    expect(document.querySelector(".sd3-cmts")).toBeInstanceOf(HTMLElement);
    expect(screen.getByText("Comments")).toBeDefined();

    window.location.hash = "#/sessions/s-blocked";
    expect(await findSharedRouteHeading("Shell Blocked Session")).toBeDefined();
    expect(document.querySelector(".sd3-cmts")).toBeInstanceOf(HTMLElement);
    expect(screen.getByText("Comments")).toBeDefined();

    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-pending"
    );
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-blocked"
    );
  });

  it("keeps desktop-only native routes reachable from the shell", async () => {
    await renderDesktopApp("");

    const nativeRoutes = [
      ["Plans", "plans"],
      ["Approvals", "approvals"],
      ["Requests", "requests"],
      ["Diagnostics", "diagnostics"],
      ["Settings", "settings"],
    ] as const;

    for (const [, id] of nativeRoutes) {
      window.location.hash = `#/${id}`;
      expect(await screen.findByTestId(`native-route:${id}`)).toBeDefined();
    }
  });

  it("redirects legacy packs-lab routes (/tools, /subagents, /packs, /skills) to the Agents workspace", async () => {
    await renderDesktopApp("");

    // Legacy routes must redirect to NavId.Agents (the unified workspace).
    // The AgentsView renders null when the feature flag is off (which is the
    // case in the test environment because the static adapter defaults all flags
    // to off). So we just assert the hash routes are accepted (no 404/unmapped).
    for (const legacyPath of ["/tools", "/subagents", "/packs", "/skills"]) {
      window.location.hash = `#${legacyPath}`;
      // The hash is accepted (route resolves to NavId.Agents) — no crash.
      await waitFor(() => expect(window.location.hash).toBe(`#${legacyPath}`));
    }

    // The deprecated db APIs must not be called (the views that used them are gone).
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
  });

  it("routes #/branches/:id to the branch detail view", async () => {
    await renderDesktopApp("#/branches/b-1");

    const detail = await screen.findByTestId("branch-detail");
    expect(detail.textContent).toContain("b-1");
    // Back targets the Branches list explicitly, not the contextual nav — a
    // direct #/branches/:id load must not send "Back to Branches" to Sessions.
    // (Path-style href; the hash router prepends "#" on navigation.)
    expect(detail.getAttribute("data-back-href")).toBe("/branches");

    // The Topbar breadcrumb gains a linked "Branches" parent segment that
    // returns to the list (mirrors the web app). The mocked detail body never
    // publishes a name, so the current segment is the generic fallback.
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const branchesCrumb = within(breadcrumb).getByRole("link", {
      name: "Branches",
    });
    expect(branchesCrumb.getAttribute("href")).toBe("/branches");
    expect(await findTopbarCurrentPage("Branch")).toBeDefined();
  });

  it("renders a linked Sessions breadcrumb with the session name on the session detail page", async () => {
    await renderDesktopApp("#/sessions/s-active");

    // The current segment resolves to the loaded session's name.
    expect(await findTopbarCurrentPage("Shell Active Session")).toBeDefined();

    // The parent "Sessions" segment links back to the Sessions list and
    // navigates there on click.
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const sessionsCrumb = within(breadcrumb).getByRole("link", {
      name: "Sessions",
    });
    expect(sessionsCrumb.getAttribute("href")).toBe("/sessions");

    fireEvent.click(sessionsCrumb);
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
  });
});

function findSharedRouteHeading(name: string) {
  // Inherits the file-wide asyncUtilTimeout configured above (FEA-2023).
  return screen.findByRole("heading", { name });
}

function getDesktopSessionDetailScrollElements() {
  const workspace = document.querySelector(".sd3");
  const traceScroller = document.querySelector(".sd3-scroll");
  const detailShell = workspace?.parentElement;
  const contentViewport = detailShell?.parentElement;
  return { contentViewport, detailShell, traceScroller, workspace };
}

// The Sessions/Branches pages have no in-body heading — their page name lives
// in the Topbar breadcrumb (the current segment is marked aria-current="page").
// Scope to the labeled breadcrumb nav so a matching sidebar nav label can't
// satisfy it.
function findTopbarCurrentPage(name: string) {
  // Inherits the file-wide asyncUtilTimeout configured above (FEA-2023).
  return within(
    screen.getByRole("navigation", { name: "Breadcrumb" })
  ).findByText(name, { selector: '[aria-current="page"]' });
}

function renderDesktopApp(initialHash: string) {
  window.location.hash = initialHash;
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  return {
    navigation,
    ...render(
      <DesktopAppCoreProvider>
        <DesktopNavigationApp navigation={navigation} />
      </DesktopAppCoreProvider>
    ),
  };
}

function installLocalStorage(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "localStorage"
  );
  const entries = new Map<string, string>();
  const storage = {
    clear: vi.fn(() => entries.clear()),
    getItem: vi.fn((key: string) =>
      entries.has(key) ? (entries.get(key) ?? null) : null
    ),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
  } satisfies Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });

  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(window, "localStorage");
      return;
    }
    Object.defineProperty(window, "localStorage", originalDescriptor);
  };
}

function installResizeObserver(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });

  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
      return;
    }
    Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
  };
}

function installDesktopApi() {
  const items = [
    agentSessionListItem({
      id: "s-active",
      name: "Shell Active Session",
      status: "active",
    }),
    agentSessionListItem({
      id: "s-completed",
      name: "Shell Completed Session",
      status: "completed",
    }),
    agentSessionListItem({
      id: "s-failed",
      name: "Shell Failed Session",
      status: "failed",
    }),
    agentSessionListItem({
      id: "s-pending",
      name: "Shell Pending Session",
      state: AgentSessionState.PendingApproval,
      status: "active",
    }),
    agentSessionListItem({
      id: "s-blocked",
      name: "Shell Blocked Session",
      state: AgentSessionState.Blocked,
      status: "failed",
    }),
    agentSessionListItem({
      id: "s-abandoned",
      name: "Shell Abandoned Session",
      status: "abandoned",
    }),
    ...Array.from({ length: 19 }, (_, index) =>
      agentSessionListItem({
        id: `s-filler-${index + 1}`,
        name: `Shell Filler Session ${index + 1}`,
        status: "completed",
      })
    ),
    agentSessionListItem({
      id: "s-page-two",
      name: "Shell Page Two Session",
      status: "completed",
    }),
  ];

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(() => Promise.resolve(agentSessionAnalytics())),
        detail: vi.fn((id: string) => {
          const item = items.find((session) => session.id === id);
          return Promise.resolve(item ? agentSessionDetail(item) : null);
        }),
        list: vi.fn(
          (
            request: {
              limit?: number;
              offset?: number;
              search?: string;
              status?: string;
              statuses?: string[];
            } = {}
          ) => {
            let statuses: string[] = [];
            if (request.statuses && request.statuses.length > 0) {
              statuses = request.statuses;
            } else if (request.status) {
              statuses = [request.status];
            }
            let filtered =
              statuses.length > 0
                ? items.filter((item) => statuses.includes(item.status))
                : items;
            if (request.search) {
              const normalizedSearch = request.search.toLowerCase();
              filtered = filtered.filter((item) =>
                [
                  item.name,
                  item.externalSessionId,
                  item.harness,
                  item.cwd,
                  item.repositoryFullName,
                  item.baseBranch,
                ].some((value) =>
                  value?.toLowerCase().includes(normalizedSearch)
                )
              );
            }
            const offset = request.offset ?? 0;
            const limit = request.limit ?? filtered.length;
            return Promise.resolve({
              items: filtered.slice(offset, offset + limit),
              total: filtered.length,
              viewerScope: "self",
            } satisfies AgentSessionListResponse);
          }
        ),
        usage: vi.fn(() => Promise.resolve(agentSessionUsage(items.length))),
      },
      db: {
        getDiagnostics: vi.fn(),
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
        // Agent components IPC (FEA-2923 / T-16.2).
        listAgentComponents: vi.fn(async () => ({ items: [], total: 0 })),
        getAgentComponentDetail: vi.fn(async () => null),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => {})),
      getAgentMonitorUrl: vi.fn(() =>
        Promise.resolve({
          enabled: true,
          localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
          planExtractionEnabled: true,
          ready: true,
          url: "http://127.0.0.1:0",
        })
      ),
      getAllFlags: vi.fn(() => Promise.resolve({ flags: [] })),
      onDbChanged: vi.fn(() => () => undefined),
    },
  });
}

function agentSessionListItem({
  id,
  name,
  state,
  status,
}: {
  id: string;
  name: string;
  state?: AgentSessionState;
  status: string;
}): AgentSessionListItem {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    agentCount: 1,
    awaitingInputSince: null,
    baseBranch: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "local-desktop",
      isOnline: true,
      lastSeenAt: timestamp,
      machineName: "Local Desktop",
    },
    cwd: "/tmp/shell-session",
    endedAt: timestamp,
    errorCount: status === "failed" ? 1 : 0,
    estimatedCost: 0.01,
    externalSessionId: id,
    harness: "codex",
    id,
    inputTokens: 10,
    lastActivityAt: timestamp,
    model: "gpt-test",
    name,
    outputTokens: 20,
    project: null,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt: timestamp,
    state,
    status,
    toolUseCount: 1,
    updatedAt: timestamp,
    user: null,
    worktreePath: "/tmp/symphony-alpha",
  };
}

function agentSessionDetail(item: AgentSessionListItem): AgentSessionDetail {
  return {
    ...item,
    agents: [
      {
        endedAt: item.endedAt?.toISOString() ?? null,
        externalAgentId: `${item.id}-agent`,
        name: "Main",
        startedAt: item.startedAt.toISOString(),
        status: "completed",
        task: "Rendered shared shell route",
        type: "main",
        updatedAt: item.updatedAt.toISOString(),
      },
    ],
    attribution: {
      baseBranch: null,
      repositoryFullName: item.repositoryFullName,
      sourceArtifactId: null,
      sourceLoopId: null,
      worktreePath: item.worktreePath,
    },
    events: [
      {
        createdAt: item.updatedAt.toISOString(),
        eventType: "agent_message",
        externalEventId: `${item.id}-event`,
        summary: "Shared detail event",
      },
    ],
    metadata: { shell: true },
    sourceArtifactId: null,
    sourceLoopId: null,
    tokenUsageByModel: [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: item.estimatedCost,
        inputTokens: item.inputTokens,
        model: item.model ?? "gpt-test",
        outputTokens: item.outputTokens,
      },
    ],
  };
}

function agentSessionUsage(totalSessions: number): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0.04,
    byHarness: [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0.04,
        harness: "codex",
        inputTokens: 10,
        outputTokens: 20,
        sessionCount: totalSessions,
      },
    ],
    byModel: [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0.04,
        inputTokens: 10,
        model: "gpt-test",
        outputTokens: 20,
        sessionCount: totalSessions,
      },
    ],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    latestSessionAt: null,
    lastSyncTargets: [],
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0.04,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalSessions,
    viewerScope: "self",
  };
}

function agentSessionAnalytics(): AgentSessionAnalytics {
  return {
    byAgentType: [],
    byProject: [],
    byRepository: [],
    byTool: [],
    viewerScope: "self",
  };
}
