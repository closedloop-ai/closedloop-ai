import { GRID_TABLE_METRIC_BAND_TEST_ID } from "@closedloop-ai/design-system/components/ui/grid-table-list-surface";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import {
  SESSIONS_TOOLBAR_FACET_GROUPS,
  SESSIONS_TOOLBAR_FILTER_BUTTON,
  SESSIONS_TOOLBAR_OPTIONS_BUTTON,
  SESSIONS_TOOLBAR_SUMMARY_CARD_LABELS,
  SessionsToolbarMountHarness,
  sessionsToolbarOptionsRow,
} from "@repo/app/agents/components/sessions/__tests__/sessions-toolbar-mount-harness";
import { createAgentSessionUsageSummaryFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSIONS_EXPORT_CSV_LABEL } from "@repo/app/agents/components/sessions/sessions-options-menu";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { V1_SUMMARY_BAND_SELECTOR } from "./fixtures/summary-band-selector";

/**
 * ISS-7725 — the DESKTOP adapter, with the REAL `SessionsToolbar` mounted.
 *
 * Every other `SessionsView` suite mocks the toolbar to a bare
 * `<div data-testid="sessions-toolbar" />`, so the Options menu's composition
 * has never been exercised through this adapter. `sessions-view-responsive`
 * covers the card/band host wiring by MOCKING `useSessionsViewState` to return
 * an already-hidden set — proving the render but never the toggle producing it.
 *
 * Here the flag hook and the view-state hook are real (only `isViewReady` is
 * pinnable, below), so a click lands on the shipped `TableOptionsSwitchRow` and
 * travels the shipped `toggleSummaryCard` path.
 *
 * Cloud + Authenticated throughout: the export row is a cloud-mode decision
 * (`useSessionsExportItem`), so a Local-mode mount could not observe it at all.
 *
 * `fireEvent` rather than `userEvent`, and native assertions rather than
 * jest-dom matchers: `apps/desktop` declares neither package and
 * `vitest.renderer.config.ts` loads no setup file. The Radix pointer-capture
 * shims the menus need come in with the harness import above.
 */

const { hooks, viewReadyOverride } = vi.hoisted(() => ({
  hooks: {
    useAgentSessionAnalytics: vi.fn(),
    useAgentSessionsPageData: vi.fn(),
    useAgentSessionUsage: vi.fn(),
    useLocalAgentSessionUsage: vi.fn(),
    useIngestProgress: vi.fn(),
    useSharedDateRange: vi.fn(),
    useSearchParamsValue: vi.fn(),
  },
  viewReadyOverride: { value: null as boolean | null },
}));

// The list body is not what this suite is about, and the real one pulls the
// whole table runtime in behind it.
vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
  useCancelAgentSessionsPageData: () => () => undefined,
}));

vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
}));

vi.mock("../../../hooks/use-file-access-blocks", () => ({
  useFileAccessBlocks: () => [],
}));

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

// The REAL view state runs, so `toggleSummaryCard` actually mutates and the
// strip re-renders from it. Only `isViewReady` is pinnable: the restore commits
// in a post-mount effect that `render()` has already flushed, so the window the
// export row is gated on is otherwise unobservable.
vi.mock("@repo/app/agents/hooks/use-sessions-view-state", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/agents/hooks/use-sessions-view-state")
    >();
  return {
    ...actual,
    useSessionsViewState: (persistKey?: string) => {
      const state = actual.useSessionsViewState(persistKey);
      if (viewReadyOverride.value === null) {
        return state;
      }
      return { ...state, isViewReady: viewReadyOverride.value };
    },
  };
});

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/sessions" }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: hooks.useSearchParamsValue,
}));

vi.mock("../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Cloud,
  useDesktopLocalReadReason: () => undefined,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Typed fixture, not a literal: a partial usage object drops non-optional
// fields, so a new summary field fails tsc here instead of arriving missing.
const USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  {
    totalSessions: 50,
    totalInputTokens: 1000,
    totalOutputTokens: 250,
    earliestSessionAt: "2026-07-01T00:00:00.000Z",
    latestSessionAt: "2026-07-02T00:00:00.000Z",
  }
);

function renderSessionsView(enabledFlags: readonly string[] = []) {
  return render(
    <SessionsToolbarMountHarness enabledFlags={enabledFlags}>
      <SessionsView />
    </SessionsToolbarMountHarness>
  );
}

/**
 * Opens a Radix DROPDOWN (the Options and Filter controls). Radix opens these on
 * pointerdown rather than click, and their content is a `menu`.
 */
function openMenu(name: string): HTMLElement {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.getByRole("menu");
}

/** The request shape the last `useAgentSessionsPageData` call was given. */
function lastSessionsRequest(): { statuses?: readonly string[] } | undefined {
  const calls = hooks.useAgentSessionsPageData.mock.calls;
  return calls.at(-1)?.[0] as { statuses?: readonly string[] } | undefined;
}

/** A rendered Status chip's text, whatever value it carries. */
const STATUS_CHIP_TEXT = /^Status: \S+$/;

/** The chip text the active-filter bar renders for one status value. */
function statusChipLabel(status: string): string {
  return `Status: ${SESSION_STATUS_LABELS[status as keyof typeof SESSION_STATUS_LABELS] ?? status}`;
}

/**
 * Every Status chip currently rendered, read by PREFIX rather than by the three
 * expected labels — a chip carrying a retired value falls back to the raw wire
 * string (`Status: waiting`), which a label-keyed lookup would never find.
 */
function statusChipLabels(): string[] {
  // Leaf elements only. The same string reads back off every ancestor of the
  // chip's text node, so an unfiltered walk reports one chip three times and
  // an exact-list assertion fails on a correct render.
  return [...document.querySelectorAll("*")]
    .filter((node) => node.children.length === 0)
    .map((node) => node.textContent?.trim() ?? "")
    .filter((text) => STATUS_CHIP_TEXT.test(text));
}

/**
 * The Status facet row, whose accessible name carries the selected-count badge
 * ("Status2") once anything is selected — so it cannot be matched by the bare
 * word the unfiltered case uses.
 */
const STATUS_FACET_ROW_NAME = /^Status\d*$/;

/**
 * Opens the REAL Filter popover's Status submenu and reports both what the
 * facet row says it is holding and what the submenu offers.
 */
function openStatusSubmenu(): {
  facetRowName: string;
  optionNames: string[];
} {
  const filterMenu = openMenu(SESSIONS_TOOLBAR_FILTER_BUTTON);
  const facetRow = within(filterMenu).getByRole("menuitem", {
    name: STATUS_FACET_ROW_NAME,
  });
  const facetRowName = facetRow.textContent?.trim() ?? "";
  fireEvent.keyDown(facetRow, { key: "ArrowRight" });
  const submenu = screen.getAllByRole("menu").at(-1) as HTMLElement;
  return {
    facetRowName,
    optionNames: within(submenu)
      .getAllByRole("menuitem")
      .map((option) => option.textContent?.trim() ?? ""),
  };
}

/**
 * ISS-8909: the v2 SURFACE draws the padded band the retired v1
 * `SessionsSummaryBand` used to. Both selectors are matched because the v1 one
 * is still what some sibling fixtures name; the decision under test — the band
 * goes when it would be empty — is unchanged.
 */
const summaryBand = () =>
  document.querySelector<HTMLElement>(
    `${V1_SUMMARY_BAND_SELECTOR}, [data-testid="${GRID_TABLE_METRIC_BAND_TEST_ID}"]`
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  viewReadyOverride.value = null;
  hooks.useSharedDateRange.mockReturnValue({
    dateRange: "7d",
    setDateRange: vi.fn(),
  });
  hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
  hooks.useAgentSessionsPageData.mockReturnValue({
    data: {
      list: {
        items: [{ id: "session-1" }],
        total: 50,
        readSource: ReadSource.Cloud,
      },
      usage: USAGE,
    },
    isFetching: false,
    isPlaceholderData: false,
    isLoading: false,
    isError: false,
  });
  hooks.useAgentSessionUsage.mockReturnValue({
    data: USAGE,
    isFetching: false,
    isPlaceholderData: false,
    isError: false,
  });
  hooks.useAgentSessionAnalytics.mockReturnValue({
    data: { byRepository: [] },
  });
  hooks.useLocalAgentSessionUsage.mockReturnValue({
    data: undefined,
    isError: false,
  });
  hooks.useIngestProgress.mockReturnValue(null);
});

afterEach(cleanup);

/**
 * ISS-9692: an explicit timeout, because the tree these cases mount grew.
 * Desktop Sessions now supplies `onPageSizeChange`, so the shared footer renders
 * a real rows-per-page `Select` it previously omitted — every mount and every
 * menu click below pays for that extra Radix subtree, and the heaviest case went
 * from ~2.5s to ~5.3s against a 5s default. Nothing about what these cases
 * ASSERT changed; only how much real UI stands between the click and the
 * assertion. Stated here rather than left to the default so a genuine hang is
 * still bounded (repo rule: an integration test names its own timeout).
 */
const TOOLBAR_MENU_TEST_TIMEOUT_MS = 30_000;

describe("PRD-721 AC-5 — Desktop Sessions mounts the real toolbar", {
  timeout: TOOLBAR_MENU_TEST_TIMEOUT_MS,
}, () => {
  it("renders the real toolbar's own controls, not a stand-in's test id", () => {
    renderSessionsView();

    // The proof the toolbar is REAL. The stand-in every sibling suite installs
    // renders a bare `<div data-testid="sessions-toolbar" />` and neither of
    // these controls, so no Options assertion below can pass against it.
    // ISS-8909: read through the v2 toolbar's Options control, which owns the
    // column switches the retired v1 View popover used to.
    expect(
      screen.getByRole("button", { name: SESSIONS_TOOLBAR_OPTIONS_BUTTON })
    ).toBeDefined();
    const filterMenu = openMenu(SESSIONS_TOOLBAR_FILTER_BUTTON);
    for (const group of SESSIONS_TOOLBAR_FACET_GROUPS) {
      expect(
        within(filterMenu).getByRole("menuitem", { name: group })
      ).toBeDefined();
    }
  });

  it("offers the export row only once the saved-view restore gate has opened", () => {
    viewReadyOverride.value = false;
    renderSessionsView();

    expect(
      within(openMenu(SESSIONS_TOOLBAR_OPTIONS_BUTTON)).queryByRole(
        "menuitem",
        {
          name: SESSIONS_EXPORT_CSV_LABEL,
        }
      )
    ).toBeNull();
    cleanup();

    // Same mode, same flag, gate OPEN — so the absence above is the gate and not
    // a row this surface never offers.
    viewReadyOverride.value = true;
    renderSessionsView();
    expect(
      within(openMenu(SESSIONS_TOOLBAR_OPTIONS_BUTTON)).getByRole("menuitem", {
        name: SESSIONS_EXPORT_CSV_LABEL,
      })
    ).toBeDefined();
  });

  /**
   * ISS-10629 (davetho review, PR #7603): the retirement is enforced in
   * `dedupeSessionStatusFacetValues`, and until this case the ONLY coverage of
   * it ran against that parser in isolation. A real URL/hash adapter could have
   * reintroduced a retired value — a second read of the params that skipped the
   * parser, an option list built from the displayed vocabulary — and every
   * surface spec stayed green, because none of them ever restored one.
   *
   * Restores a MIXED selection so the three assertions below cannot be
   * satisfied by a filter that dropped everything: `active` has to survive all
   * three.
   *
   * The parser deliberately does NOT rewrite the hash on mount, so nothing here
   * asserts a navigation — only what the surface OFFERS, SENDS, and SHOWS.
   */
  it("refuses a retired status restored from the hash — no option, no request value, no chip (ISS-10629)", () => {
    // Plain literals: ISS-10364 retired all three `DISPLAYED_SESSION_STATUS`
    // members this test used to read them from, on top of ISS-10629 already
    // having retired them from the filter facet.
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams([
        ["status", "waiting"],
        ["status", SESSION_STATUS.ACTIVE],
        ["status", "stale"],
        ["status", "unknown"],
      ])
    );
    renderSessionsView();

    // The three are NOT interchangeable, and only one of them kills a filter
    // that stopped filtering: SENDS and the facet row's selected count both
    // read the parsed list directly, so both redden when a retired value
    // survives the parse. The chip row drops a value it has no facet option
    // for, so its assertion cannot catch that mutation — it guards the other
    // direction, a chip row taught to render the displayed vocabulary.

    // SENDS: the desktop data source is asked for the one surviving value.
    expect(lastSessionsRequest()?.statuses).toEqual([SESSION_STATUS.ACTIVE]);

    // SHOWS: one chip, for the survivor. Asserting the survivor's chip is
    // present is what makes the absence of the other three meaningful — a chip
    // row that never mounted would satisfy an absence-only check on its own.
    expect(statusChipLabels()).toEqual([
      statusChipLabel(SessionStatusFacetValue.Active),
    ]);

    // OFFERS: the Status submenu, read from the REAL toolbar. Its row carries
    // the selected COUNT, which is the filter's own statement of how many
    // values it is holding — one, not the four the URL asked for.
    const status = openStatusSubmenu();
    expect(status.facetRowName).toBe("Status1");
    expect(status.optionNames).toEqual([
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Active],
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Inactive],
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Error],
    ]);
  });

  it("hides every summary card from the real menu and drops the empty band with them", () => {
    const { container } = renderSessionsView();

    expect(
      container.querySelectorAll('[data-slot="card"]').length
    ).toBeGreaterThan(0);
    expect(summaryBand()).not.toBeNull();

    const menu = openMenu(SESSIONS_TOOLBAR_OPTIONS_BUTTON);
    for (const label of SESSIONS_TOOLBAR_SUMMARY_CARD_LABELS) {
      fireEvent.click(sessionsToolbarOptionsRow(menu, label));
    }

    // Both halves: the cards are gone AND the padded sticky wrapper went with
    // them, so no unexplained empty band is left between toolbar and table.
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(0);
    expect(summaryBand()).toBeNull();
  });
});
