import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { SHARE_DASHBOARD_PARAM } from "@repo/app/insights/lib/share-dashboard";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardTileSettings } from "../../hooks/use-dashboard-pins";
import { InsightsPage } from "../insights-page";

const { pinsState } = vi.hoisted(() => ({
  pinsState: {
    tiles: [] as string[],
    settings: {} as Record<string, DashboardTileSettings>,
  },
}));

vi.mock("../dashboard-grid", () => ({
  DashboardGrid: ({
    comparisonLabel,
    comparisonSections,
    sections,
    onAddTiles,
    onEditTile,
  }: {
    comparisonLabel: string;
    comparisonSections: Record<string, unknown>;
    sections: Record<string, unknown>;
    onAddTiles: () => void;
    onEditTile: (id: string) => void;
  }) => (
    <div data-testid="dashboard-grid">
      <span>{`grid-comparison:${comparisonLabel}`}</span>
      <span data-testid="grid-sections">
        {Object.keys(sections)
          .filter((key) => sections[key] !== undefined)
          .sort()
          .join(",")}
      </span>
      <span data-testid="grid-comparison-sections">
        {Object.keys(comparisonSections)
          .filter((key) => comparisonSections[key] !== undefined)
          .sort()
          .join(",")}
      </span>
      <button onClick={onAddTiles} type="button">
        grid add
      </button>
      <button onClick={() => onEditTile("kpi:merged")} type="button">
        grid edit
      </button>
    </div>
  ),
}));

vi.mock("../metric-picker", () => ({
  MetricPicker: ({
    open,
    editingTileId,
    onOpenChange,
  }: {
    open: boolean;
    editingTileId?: string | null;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div>
      <span data-testid="picker-state">{`${open}:${editingTileId ?? "none"}`}</span>
      <button onClick={() => onOpenChange(false)} type="button">
        picker close
      </button>
    </div>
  ),
}));

vi.mock("../../hooks/use-dashboard-pins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/use-dashboard-pins")>()),
  useDashboardPins: () => ({
    getTileSettings: () => ({}),
    isPinned: () => false,
    layout: {},
    pinTile: () => undefined,
    replaceTile: () => undefined,
    settings: pinsState.settings,
    tiles: pinsState.tiles,
    unpinTile: () => undefined,
  }),
}));

const METRIC_BUTTON_RE = /metric/i;
const COPY_ICON = "svg.lucide-copy";
const SHARE_ICON = "svg.lucide-share-2";
const TEAM_A = { id: "team-a", name: "Platform" };
const TEAM_B = { id: "team-b", name: "Data" };
const TEAM_COMBOBOX_NAME = "Team";
const SHARE_FEEDBACK_TIMEOUT_MS = 1800;
const CONNECT_BANNER_COPY =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].deliveryBannerExplanation;

beforeEach(() => {
  pinsState.tiles = ["kpi:merged"];
  pinsState.settings = {};
  window.history.replaceState({}, "", "/insights");
});

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard"
);
const ORIGINAL_SHARE = Object.getOwnPropertyDescriptor(navigator, "share");

afterEach(() => {
  vi.useRealTimers();
  restoreNavigatorProperty("clipboard", ORIGINAL_CLIPBOARD);
  restoreNavigatorProperty("share", ORIGINAL_SHARE);
});

describe("InsightsPage share feedback", () => {
  it("uses the native share sheet when available and shows no copy feedback", async () => {
    window.history.replaceState(
      {},
      "",
      `/insights?${SHARE_DASHBOARD_PARAM}=stale`
    );
    const share = stubShare(vi.fn().mockResolvedValue(undefined));
    const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));
    renderPage(createSource());

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const [payload] = share.mock.calls[0];
    expect(payload.title).toBe("Closedloop Insights");
    const params = new URL(payload.url).searchParams;
    expect(params.get("scope")).toBe(InsightsScope.Me);
    expect(params.get("period")).toBe(InsightsPeriod.Quarter);
    expect(params.has(SHARE_DASHBOARD_PARAM)).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => {
      await share.mock.results[0].value;
    });
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("stays silent when the user dismisses the native share sheet", async () => {
    const share = stubShare(
      vi.fn().mockRejectedValue(new DOMException("dismissed", "AbortError"))
    );
    renderPage(createSource());

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await act(async () => {
      await share.mock.results[0].value.catch(() => undefined);
    });
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy failed" })
    ).not.toBeInTheDocument();
  });

  it.each([
    ["a non-abort DOMException", new DOMException("denied", "NotAllowedError")],
    ["a plain error", new TypeError("blocked")],
  ])(
    "reports a failed copy when the share call throws %s",
    async (_name, error) => {
      stubShare(vi.fn().mockRejectedValue(error));
      renderPage(createSource());

      fireEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(
        await screen.findByRole("button", { name: "Copy failed" })
      ).toBeInTheDocument();
    }
  );

  it("restarts the copied-feedback window on a second copy, then returns to Share", async () => {
    // No pins, so no insights query settles on the fake clock mid-test.
    pinsState.tiles = [];
    const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));
    renderPage(createSource());
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await act(async () => {
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      await writeText.mock.results[0].value;
    });
    expect(
      screen.getByRole("button", { name: "Copied" }).querySelector(COPY_ICON)
    ).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(SHARE_FEEDBACK_TIMEOUT_MS - 800);
    });

    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    await act(async () => {
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      await writeText.mock.results[1].value;
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // The first window would have expired by now had the second copy not
    // cleared it.
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(SHARE_FEEDBACK_TIMEOUT_MS);
    });
    const shareButton = screen.getByRole("button", { name: "Share" });
    expect(shareButton.querySelector(SHARE_ICON)).not.toBeNull();
    expect(shareButton.querySelector(COPY_ICON)).toBeNull();
  });

  it("does nothing when neither native share nor the clipboard exists", () => {
    pinsState.tiles = [];
    renderPage(createSource());

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy failed" })
    ).not.toBeInTheDocument();
  });

  it("carries the selected team into the shared link only under Team scope", async () => {
    window.history.replaceState({}, "", "/insights?teamId=stale");
    const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { unmount } = renderPage(
      createSource({
        availableScopes: [InsightsScope.Team],
        availableTeams: [TEAM_A],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(new URL(writeText.mock.calls[0][0]).searchParams.get("teamId")).toBe(
      TEAM_A.id
    );
    unmount();

    renderPage(createSource({ availableTeams: [TEAM_A] }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(new URL(writeText.mock.calls[1][0]).searchParams.has("teamId")).toBe(
      false
    );
  });
});

describe("InsightsPage scope, team, and period controls", () => {
  it("queries the chosen scope, team, and period", async () => {
    const source = createSource({
      availableScopes: [
        InsightsScope.Me,
        InsightsScope.Org,
        InsightsScope.Team,
      ],
      availableTeams: [TEAM_A, TEAM_B],
    });
    renderPage(source);

    expect(
      screen.queryByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).not.toBeInTheDocument();

    pick("Scope", "Team");
    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_A.id
      )
    );

    pick(TEAM_COMBOBOX_NAME, TEAM_B.name);
    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_B.id
      )
    );
    expect(
      screen.getByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).toHaveTextContent(TEAM_B.name);

    pick("Scope", "Me");
    expect(
      screen.queryByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).not.toBeInTheDocument();
    pick("Scope", "Team");
    expect(
      screen.getByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).toHaveTextContent(TEAM_B.name);

    pick("Time period", "7 days");
    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Week,
        InsightsScope.Team,
        TEAM_B.id
      )
    );
  });

  it("hides the scope control when the shell advertises a single scope and labels the periods", () => {
    renderPage(createSource());

    expect(
      screen.queryByRole("combobox", { name: "Scope" })
    ).not.toBeInTheDocument();
    const period = screen.getByRole("combobox", { name: "Time period" });
    expect(period).toHaveTextContent("90 days");
    fireEvent.click(period);
    for (const label of ["7 days", "30 days", "90 days", "All time"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
  });

  it("offers no team picker under Team scope when the shell lists no teams", () => {
    const source = createSource({
      availableScopes: [InsightsScope.Me, InsightsScope.Team],
    });
    renderPage(source);
    expect(screen.getByRole("combobox", { name: "Scope" })).toHaveTextContent(
      "Me"
    );

    pick("Scope", "Team");

    expect(
      screen.queryByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).not.toBeInTheDocument();
  });

  it("selects the first team when switching to Team scope after teams arrive", async () => {
    const initial = createSource({
      availableScopes: [InsightsScope.Me, InsightsScope.Team],
      availableTeams: [],
    });
    const view = renderPage(initial);
    const next = createSource({
      availableScopes: [InsightsScope.Me, InsightsScope.Team],
      availableTeams: [TEAM_A],
    });
    view.rerender(pageTree(next, view.queryClient));

    pick("Scope", "Team");

    await waitFor(() =>
      expect(next.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_A.id
      )
    );
    expect(next.getDelivery).not.toHaveBeenCalledWith(
      InsightsPeriod.Quarter,
      InsightsScope.Team,
      undefined
    );
  });

  it("hides the team picker when every team is withdrawn under Team scope", () => {
    const view = renderPage(
      createSource({
        availableScopes: [InsightsScope.Team],
        availableTeams: [TEAM_A],
      })
    );
    expect(
      screen.getByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).toBeInTheDocument();

    view.rerender(
      pageTree(
        createSource({
          availableScopes: [InsightsScope.Team],
          availableTeams: [],
        }),
        view.queryClient
      )
    );

    expect(
      screen.queryByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).not.toBeInTheDocument();
  });

  it("falls back to the first remaining team when the selected team disappears", async () => {
    const initial = createSource({
      availableScopes: [InsightsScope.Team],
      availableTeams: [TEAM_B, TEAM_A],
    });
    const view = renderPage(initial);
    await waitFor(() =>
      expect(initial.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_B.id
      )
    );

    const next = createSource({
      availableScopes: [InsightsScope.Team],
      availableTeams: [TEAM_A],
    });
    view.rerender(pageTree(next, view.queryClient));

    await waitFor(() =>
      expect(next.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_A.id
      )
    );
    expect(
      screen.getByRole("combobox", { name: TEAM_COMBOBOX_NAME })
    ).toHaveTextContent(TEAM_A.name);
  });

  it("prefers Me when the current scope is withdrawn and Me is advertised", async () => {
    const initial = createSource({
      availableScopes: [InsightsScope.Org, InsightsScope.Team],
      availableTeams: [TEAM_A],
    });
    const view = renderPage(initial);
    await waitFor(() =>
      expect(initial.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org,
        undefined
      )
    );

    const next = createSource({
      availableScopes: [InsightsScope.Me, InsightsScope.Team],
    });
    view.rerender(pageTree(next, view.queryClient));

    await waitFor(() =>
      expect(next.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Me,
        undefined
      )
    );
  });

  it("falls back to the first advertised scope when neither the current scope nor Me remains", async () => {
    const view = renderPage(
      createSource({ availableScopes: [InsightsScope.Me, InsightsScope.Org] })
    );

    const next = createSource({
      availableScopes: [InsightsScope.Team],
      availableTeams: [TEAM_A],
    });
    view.rerender(pageTree(next, view.queryClient));

    await waitFor(() =>
      expect(next.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Team,
        TEAM_A.id
      )
    );
    expect(next.getDelivery).not.toHaveBeenCalledWith(
      InsightsPeriod.Quarter,
      InsightsScope.Me,
      undefined
    );
  });
});

describe("InsightsPage metric picker wiring", () => {
  it("opens the picker to add or edit and clears the edited tile on close", () => {
    renderPage(createSource());

    expect(screen.getByTestId("picker-state")).toHaveTextContent("false:none");

    fireEvent.click(screen.getByRole("button", { name: "grid edit" }));
    expect(screen.getByTestId("picker-state")).toHaveTextContent(
      "true:kpi:merged"
    );

    fireEvent.click(screen.getByRole("button", { name: "picker close" }));
    expect(screen.getByTestId("picker-state")).toHaveTextContent("false:none");

    fireEvent.click(screen.getByRole("button", { name: METRIC_BUTTON_RE }));
    expect(screen.getByTestId("picker-state")).toHaveTextContent("true:none");
  });

  it("loads unpinned sections and the comparison scope only while the picker is open", async () => {
    const source = createSource({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
    });
    renderPage(source);

    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Me,
        undefined
      )
    );
    expect(source.getAgents).not.toHaveBeenCalled();
    expect(source.getDelivery).not.toHaveBeenCalledWith(
      InsightsPeriod.Quarter,
      InsightsScope.Org,
      undefined
    );

    fireEvent.click(screen.getByRole("button", { name: "grid add" }));

    await waitFor(() =>
      expect(source.getAgents).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Me,
        undefined
      )
    );
    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org,
        undefined
      )
    );
    await waitFor(() =>
      expect(source.getUtilization).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org,
        undefined
      )
    );
    await waitFor(() =>
      expect(source.getAgents).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org,
        undefined
      )
    );
    expect(
      screen.getByText("grid-comparison:Organization")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("grid-comparison-sections")).toHaveTextContent(
        "agents,delivery,utilization"
      )
    );
    expect(screen.getByTestId("grid-sections")).toHaveTextContent(
      "agents,delivery,utilization"
    );
  });

  it("compares against Me while the Organization scope is selected", () => {
    renderPage(
      createSource({ availableScopes: [InsightsScope.Me, InsightsScope.Org] })
    );
    expect(
      screen.getByText("grid-comparison:Organization")
    ).toBeInTheDocument();

    pick("Scope", "Organization");

    expect(screen.getByText("grid-comparison:Me")).toBeInTheDocument();
  });

  it("loads no comparison scope when the shell cannot offer both Me and Organization", async () => {
    const source = createSource();
    renderPage(source);

    fireEvent.click(screen.getByRole("button", { name: "grid add" }));

    await waitFor(() =>
      expect(source.getAgents).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Me,
        undefined
      )
    );
    for (const getter of [
      source.getDelivery,
      source.getUtilization,
      source.getAgents,
    ]) {
      expect(getter).not.toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org,
        undefined
      );
    }
  });

  it("loads the comparison scope for a pinned tile with the overlay on", async () => {
    pinsState.tiles = ["kpi:tokens", "kpi:merged"];
    pinsState.settings = { "kpi:merged": { comparisonOverlay: true } };
    const source = createSource({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
    });
    renderPage(source);

    await waitFor(() =>
      expect(source.getDelivery).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org,
        undefined
      )
    );
    await waitFor(() =>
      expect(source.getAgents).toHaveBeenCalledWith(
        InsightsPeriod.Quarter,
        InsightsScope.Org,
        undefined
      )
    );
    expect(source.getUtilization).not.toHaveBeenCalled();
  });
});

describe("InsightsPage Delivery connect banner", () => {
  it("stays hidden when the gated pins are non-Delivery tiles or sit in an unavailable section", async () => {
    pinsState.tiles = ["kpi:merged", "kpi:tokens", "chart:unknown"];
    const getTileAvailability = vi.fn().mockReturnValue({
      state: BranchKpiState.Gated,
    });
    const source = createSource({
      availableSections: [InsightsSection.Agents],
      getTileAvailability,
      githubConnect: {
        action: GitHubConnectAction.Connect,
        onConnect: vi.fn(),
      },
    });
    renderPage(source);

    await waitFor(() => expect(source.getAgents).toHaveBeenCalled());
    expect(screen.queryByText(CONNECT_BANNER_COPY)).not.toBeInTheDocument();
    expect(source.getDelivery).not.toHaveBeenCalled();
  });
});

describe("InsightsPage Delivery connect banner, shown", () => {
  it("shows the banner when any pinned Delivery tile is gated, asking the source with the tile's identity", async () => {
    pinsState.tiles = ["kpi:tokens", "kpi:merged"];
    const getTileAvailability = vi.fn(({ tileId }: { tileId: string }) => ({
      state:
        tileId === "kpi:merged"
          ? BranchKpiState.Gated
          : BranchKpiState.Available,
    }));
    renderPage(
      createSource({
        getTileAvailability,
        githubConnect: {
          action: GitHubConnectAction.Connect,
          onConnect: vi.fn(),
        },
      })
    );

    expect(await screen.findByText(CONNECT_BANNER_COPY)).toBeInTheDocument();
    expect(getTileAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
      })
    );
  });

  it("hides the banner when the pinned Delivery tile is available", async () => {
    const source = createSource({
      getTileAvailability: vi.fn(() => ({ state: BranchKpiState.Available })),
      githubConnect: {
        action: GitHubConnectAction.Connect,
        onConnect: vi.fn(),
      },
    });
    renderPage(source);

    await waitFor(() => expect(source.getDelivery).toHaveBeenCalled());
    expect(screen.queryByText(CONNECT_BANNER_COPY)).not.toBeInTheDocument();
  });
});

describe("InsightsPage scroll restoration", () => {
  it("restores the last scroll offset when a re-render resets the container to the top", () => {
    renderPage(createSource());
    const container = screen.getByTestId("dashboard-grid").parentElement;
    if (!container) {
      throw new Error("Expected the scroll container");
    }
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    fireEvent.scroll(container);

    container.scrollTop = 0;
    fireEvent.click(screen.getByRole("button", { name: "grid add" }));

    expect(container.scrollTop).toBe(240);

    container.scrollTop = 50;
    fireEvent.click(screen.getByRole("button", { name: "grid edit" }));
    expect(container.scrollTop).toBe(50);
  });
});

function stubClipboard<T extends ReturnType<typeof vi.fn>>(writeText: T): T {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function stubShare<T extends ReturnType<typeof vi.fn>>(share: T): T {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: share,
  });
  return share;
}

function restoreNavigatorProperty(
  key: "clipboard" | "share",
  descriptor: PropertyDescriptor | undefined
) {
  if (descriptor) {
    Object.defineProperty(navigator, key, descriptor);
  } else {
    Reflect.deleteProperty(navigator, key);
  }
}

function pick(comboboxName: string, optionName: string) {
  fireEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function pageTree(source: InsightsDataSource, queryClient: QueryClient) {
  return (
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/insights" }).adapter}
    >
      <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
        <QueryClientProvider client={queryClient}>
          <InsightsDataSourceProvider value={source}>
            <InsightsPage storageNamespace="branches-test" />
          </InsightsDataSourceProvider>
        </QueryClientProvider>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

function renderPage(source: InsightsDataSource) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(pageTree(source, queryClient));
  return Object.assign(result, { queryClient });
}

function createSource(
  overrides: Partial<InsightsDataSource> = {}
): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getDelivery: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getUtilization: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    getAgents: vi.fn().mockResolvedValue({ charts: {}, kpis: [] }),
    ...overrides,
  };
}
