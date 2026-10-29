import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import {
  SESSIONS_TOOLBAR_COLUMN_LABEL,
  SESSIONS_TOOLBAR_FACET_GROUPS,
  SESSIONS_TOOLBAR_FILTER_BUTTON,
  SESSIONS_TOOLBAR_OPTIONS_BUTTON,
  SESSIONS_TOOLBAR_SUMMARY_CARD_LABELS,
  SESSIONS_TOOLBAR_VIEW_BUTTON,
  SessionsToolbarMountHarness,
  sessionsToolbarOptionsRow,
} from "@repo/app/agents/components/sessions/__tests__/sessions-toolbar-mount-harness";
import {
  createAgentSessionListItemFixture,
  createAgentSessionUsageSummaryFixture,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSIONS_EXPORT_CSV_LABEL } from "@repo/app/agents/components/sessions/sessions-options-menu";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import { SESSIONS_COST_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { SESSIONS_COLUMN_LABELS } from "@repo/app/agents/lib/sessions-total-estimated-cost-columns";
import { SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { PRIORITY_COLUMN_LABEL } from "@repo/app/shared/lib/priority-constants";
import { summaryBandRankProbe } from "@repo/app/shared/testing/summary-band-rank-probe";
import { GRID_TABLE_METRIC_BAND_TEST_ID } from "@repo/design-system/components/ui/grid-table-list-surface";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import SessionsPage from "../page";

/** The Cost COLUMN toggle’s menu word, from the map the menu is built from. */
const SESSIONS_COST_COLUMN_MENU_LABEL =
  SESSIONS_COLUMN_LABELS[SESSIONS_COST_COLUMN_ID];

/**
 * ISS-7725 — the WEB adapter, with the REAL `SessionsToolbar` mounted.
 *
 * The shared page harness mocks the toolbar to a `<div>` of prop markers, so
 * every existing page assertion about the Options menu is really an assertion
 * about a prop the page passed. This suite deliberately does NOT import that
 * harness — the stand-in is registered by the module declaring it, so not
 * importing it is what makes the toolbar real here. The flag hook is likewise
 * unmocked, resolving through the provider {@link SessionsToolbarMountHarness}
 * mounts, so the Grid Parity read under test is the shipped one.
 */

const {
  searchParamsMock,
  useAgentSessionsMock,
  useAgentSessionsPageDataMock,
  useAgentSessionUsageMock,
  viewReadyOverrideMock,
} = vi.hoisted<{
  searchParamsMock: URLSearchParams;
  useAgentSessionsMock: Mock;
  useAgentSessionsPageDataMock: Mock;
  useAgentSessionUsageMock: Mock;
  viewReadyOverrideMock: { value: boolean | null };
}>(() => ({
  searchParamsMock: new URLSearchParams(),
  useAgentSessionsMock: vi.fn(),
  useAgentSessionsPageDataMock: vi.fn(),
  useAgentSessionUsageMock: vi.fn(),
  viewReadyOverrideMock: { value: null },
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: useAgentSessionsMock,
  useAgentSessionsPageData: useAgentSessionsPageDataMock,
  useAgentSessionUsage: useAgentSessionUsageMock,
}));

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

// The REAL `useSessionsViewState` runs; only `isViewReady` is pinnable, because
// the restore commits in a post-mount effect that `render()` has already
// flushed. That signal is the export row's gate, so a suite that cannot hold it
// shut cannot observe the closed half at all.
vi.mock("@repo/app/agents/hooks/use-sessions-view-state", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/agents/hooks/use-sessions-view-state")
    >();
  return {
    ...actual,
    useSessionsViewState: (persistKey?: string) => {
      const state = actual.useSessionsViewState(persistKey);
      if (viewReadyOverrideMock.value === null) {
        return state;
      }
      return { ...state, isViewReady: viewReadyOverrideMock.value };
    },
  };
});

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => searchParamsMock,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/sessions",
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: ReactNode }) => (
    <div data-testid="header">{children}</div>
  ),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// Typed fixture, not a literal: a partial usage object drops non-optional
// fields, so a new summary field fails tsc here instead of arriving missing.
const USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  { totalSessions: 1 }
);

function renderSessionsPage(enabledFlags: readonly string[] = []) {
  return render(
    <SessionsToolbarMountHarness enabledFlags={enabledFlags}>
      <SessionsPage />
    </SessionsToolbarMountHarness>
  );
}

/** A rendered Status chip's text, whatever value it carries. */
const STATUS_CHIP_TEXT = /^Status: \S+$/;

/**
 * The Status facet row, whose accessible name carries the selected-count badge
 * ("Status2") once anything is selected — so it cannot be matched by the bare
 * word the unfiltered cases use.
 */
const STATUS_FACET_ROW_NAME = /^Status\d*$/;

/** The request shape the last `useAgentSessions` call was given. */
function lastSessionsRequest(): { statuses?: readonly string[] } | undefined {
  return useAgentSessionsMock.mock.calls.at(-1)?.[0] as
    | { statuses?: readonly string[] }
    | undefined;
}

/** The chip text the active-filter bar renders for one status value. */
function statusChipLabel(status: string): string {
  return `Status: ${SESSION_STATUS_LABELS[status as keyof typeof SESSION_STATUS_LABELS] ?? status}`;
}

/**
 * Every Status chip currently rendered, read by PREFIX rather than by the three
 * expected labels — a chip carrying a retired value falls back to the raw wire
 * string (`Status: waiting`), which a label-keyed lookup would never find.
 *
 * Leaf elements only: the same string reads back off every ancestor of the
 * chip's text node, so an unfiltered walk reports one chip three times.
 */
function statusChipLabels(): string[] {
  return [...document.querySelectorAll("*")]
    .filter((node) => node.children.length === 0)
    .map((node) => node.textContent?.trim() ?? "")
    .filter((text) => STATUS_CHIP_TEXT.test(text));
}

/**
 * Opens the REAL Filter popover's Status submenu and reports both what the
 * facet row says it is holding and what the submenu offers.
 */
async function openStatusSubmenu(
  user: ReturnType<typeof userEvent.setup>
): Promise<{ facetRowName: string; optionNames: string[] }> {
  await user.click(
    screen.getByRole("button", { name: SESSIONS_TOOLBAR_FILTER_BUTTON })
  );
  const facetRow = screen.getByRole("menuitem", {
    name: STATUS_FACET_ROW_NAME,
  });
  const facetRowName = facetRow.textContent?.trim() ?? "";
  fireEvent.keyDown(facetRow, { key: "ArrowRight" });
  const submenu = (await screen.findAllByRole("menu")).at(-1) as HTMLElement;
  return {
    facetRowName,
    optionNames: within(submenu)
      .getAllByRole("menuitem")
      .map((option) => option.textContent?.trim() ?? ""),
  };
}

/** Opens the Options menu and returns it, failing loudly if the gate is closed. */
async function openOptionsMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: SESSIONS_TOOLBAR_OPTIONS_BUTTON })
  );
  return screen.getByRole("menu");
}

beforeEach(() => {
  localStorage.clear();
  viewReadyOverrideMock.value = null;
  for (const key of [...new Set(searchParamsMock.keys())]) {
    searchParamsMock.delete(key);
  }
  const list = { items: [createAgentSessionListItemFixture()], total: 1 };
  useAgentSessionsMock.mockReset();
  useAgentSessionsMock.mockReturnValue({ data: list, isLoading: false });
  // Seeded though the page currently lists via `useAgentSessions`: FEA-4157
  // moved that routing between the two hooks once, and the shared page harness
  // pins both for the same reason.
  useAgentSessionsPageDataMock.mockReset();
  useAgentSessionsPageDataMock.mockReturnValue({
    data: { list, usage: USAGE },
    isLoading: false,
    isLoadingError: false,
  });
  useAgentSessionUsageMock.mockReset();
  useAgentSessionUsageMock.mockReturnValue({ data: USAGE, isLoading: false });
});

describe("ISS-7725 — web Sessions adapter mounts the real toolbar", () => {
  it("renders the real toolbar's own controls, not a stand-in's prop markers", async () => {
    const user = userEvent.setup();
    renderSessionsPage();

    // The proof the toolbar is REAL. A stand-in reporting props renders neither
    // of these buttons, and no stand-in in this repo opens a facet list — so an
    // Options-menu assertion below cannot pass against a mock that slipped back.
    expect(
      screen.getByRole("button", { name: SESSIONS_TOOLBAR_VIEW_BUTTON })
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: SESSIONS_TOOLBAR_FILTER_BUTTON })
    );
    for (const group of SESSIONS_TOOLBAR_FACET_GROUPS) {
      expect(screen.getByRole("menuitem", { name: group })).toBeVisible();
    }
  });

  /**
   * ISS-10361 — the toolbar SHAPE no longer forks on the Grid Parity key.
   *
   * The case this replaces asserted that fork: Options only with the key on,
   * and the v1 `View` menu owning the column switches with it off. The operator
   * withdrew the gating ("Ship it unconditionally. No PostHog key, no flag of
   * any kind"), so that expectation is retired rather than failing — what is
   * left to pin is that the SAME Options menu, carrying the SAME column rows,
   * mounts however the harness is asked about a flag.
   *
   * ISS-10301 (review-soul, class B): the two renders USED to differ — the
   * second named `GRID_TABLE_V2_FEATURE_FLAG_KEY` to the harness. That key is
   * deleted, so a naive de-referencing left both arms calling
   * `renderSessionsPage([])` byte-identically while this docstring still claimed
   * they proved a fork could not re-grow — a case that could no longer fail for
   * the reason it named. The second arm now names a DIFFERENT live key
   * (`sessions-artifact-tags`, the one key this surface's column vocabulary
   * still gates on), so the pair once again measures "the Options menu and its
   * column rows do not depend on which flags are on" rather than running the
   * same input twice.
   */
  it("mounts the Options menu with its column rows on either flag set", async () => {
    const user = userEvent.setup();
    const noFlagsRender = renderSessionsPage([]);

    expect(
      sessionsToolbarOptionsRow(
        await openOptionsMenu(user),
        SESSIONS_TOOLBAR_COLUMN_LABEL
      )
    ).toBeVisible();
    noFlagsRender.unmount();

    renderSessionsPage([SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY]);
    const menu = await openOptionsMenu(user);
    expect(
      sessionsToolbarOptionsRow(menu, SESSIONS_TOOLBAR_COLUMN_LABEL)
    ).toBeVisible();
  });

  /**
   * ISS-10332 (re-review, PR #7723's successor): the Priority column ships
   * SHOWN, so its Options row is the only way to hide it — and it reaches this
   * menu only because this host names `includePriorityColumn`. Every other case
   * for that switch mounts `SessionsToolbar` with the prop set by hand, so
   * deleting the host's one line left them all green while the shipped surface
   * rendered a column with no switch. This asserts the wiring: it fails the
   * moment the host stops opting in.
   *
   * Located through `PRIORITY_COLUMN_LABEL`, the constant the column spec
   * renders, so a reworded label moves both sides together.
   */
  it("offers the shown-by-default Priority column a switch, because the host opts in", async () => {
    const user = userEvent.setup();
    renderSessionsPage([]);

    const menu = await openOptionsMenu(user);

    expect(
      sessionsToolbarOptionsRow(menu, PRIORITY_COLUMN_LABEL)
    ).toBeVisible();
  });

  /**
   * ISS-10636 (davetho review, PR #7560): the Cost COLUMN toggle and the Cost
   * summary-CARD toggle are rows of the SAME Options menu, so the two cannot
   * share a label — `getByRole("menuitem", { name })` resolving to both is the
   * accessible-name collision, not a test artifact.
   *
   * So the column keeps `SESSIONS_COLUMN_SPECS`' own word while the header above
   * the grid and the card row take the one dollar phrase. This case is what stops
   * either half drifting onto the other silently: unifying them makes the
   * `getByRole` below throw on multiple matches rather than pass quietly.
   */
  it("keeps the Cost column toggle and the Cost card row under different names (ISS-10636)", async () => {
    const user = userEvent.setup();
    renderSessionsPage([]);

    const menu = await openOptionsMenu(user);

    expect(
      sessionsToolbarOptionsRow(menu, SESSIONS_COST_COLUMN_MENU_LABEL)
    ).toBeVisible();
    expect(
      sessionsToolbarOptionsRow(menu, TOTAL_ESTIMATED_COST_LABEL)
    ).toBeVisible();
  });

  /**
   * ISS-10629 (davetho review, PR #7603): the retirement is enforced in
   * `dedupeSessionStatusFacetValues`, and until this case the ONLY coverage of
   * it ran against that parser in isolation. A real URL adapter could have
   * reintroduced a retired value — a second read of the params that skipped the
   * parser, an option list built from the displayed vocabulary — and every
   * surface spec stayed green, because none of them ever restored one.
   *
   * Restores a MIXED selection so the three assertions below cannot be
   * satisfied by a filter that dropped everything: `active` has to survive all
   * three.
   *
   * The parser deliberately does NOT rewrite the URL on mount, so nothing here
   * asserts a navigation — only what the surface OFFERS, SENDS, and SHOWS.
   */
  it("refuses a retired status restored from the URL — no option, no request value, no chip (ISS-10629)", async () => {
    const user = userEvent.setup();
    // ISS-10364 retired all three as `DISPLAYED_SESSION_STATUS` members, so
    // these are plain literals now — a URL `status` param is always a raw
    // string regardless, and this case is about a value RESTORED from one.
    for (const retired of ["waiting", "stale", "unknown"]) {
      searchParamsMock.append("status", retired);
    }
    searchParamsMock.append("status", SESSION_STATUS.ACTIVE);
    renderSessionsPage();

    // The three are NOT interchangeable, and only one of them kills a filter
    // that stopped filtering: SENDS and the facet row's selected count both
    // read the parsed list directly, so both redden when a retired value
    // survives the parse. The chip row drops a value it has no facet option
    // for, so its assertion cannot catch that mutation — it guards the other
    // direction, a chip row taught to render the displayed vocabulary.

    // SENDS: the list read is asked for the one surviving value.
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
    const status = await openStatusSubmenu(user);
    expect(status.facetRowName).toBe("Status1");
    expect(status.optionNames).toEqual([
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Active],
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Inactive],
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Error],
    ]);
  });

  it("offers the export row only once the saved-view restore gate has opened", async () => {
    const user = userEvent.setup();
    viewReadyOverrideMock.value = false;
    const heldRender = renderSessionsPage([]);

    expect(
      within(await openOptionsMenu(user)).queryByRole("menuitem", {
        name: SESSIONS_EXPORT_CSV_LABEL,
      })
    ).toBeNull();
    heldRender.unmount();

    // Same mount, same flag, gate OPEN — so the absence above is the gate and
    // not a row this surface never offers.
    viewReadyOverrideMock.value = true;
    renderSessionsPage([]);
    expect(
      within(await openOptionsMenu(user)).getByRole("menuitem", {
        name: SESSIONS_EXPORT_CSV_LABEL,
      })
    ).toBeVisible();
  });

  it("hides every summary card from the real menu and drops the empty band with them", async () => {
    const user = userEvent.setup();
    renderSessionsPage([]);

    // ISS-7052 Part A: with the gate ON this page renders `SessionsListSurfaceV2`,
    // so the padded wrapper under test is `GridTableListSurface`'s metric band
    // rather than the page's own sticky one. Same contract, different host.
    expect(screen.getByTestId(GRID_TABLE_METRIC_BAND_TEST_ID)).toBeVisible();
    expect(
      document.querySelectorAll('[data-slot="card"]').length
    ).toBeGreaterThan(0);

    const menu = await openOptionsMenu(user);
    for (const label of SESSIONS_TOOLBAR_SUMMARY_CARD_LABELS) {
      await user.click(sessionsToolbarOptionsRow(menu, label));
    }

    // Both halves: the cards are gone AND the page's padded sticky wrapper went
    // with them, so nothing at all sits between the toolbar and the list.
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(0);
    expect(screen.queryByTestId(GRID_TABLE_METRIC_BAND_TEST_ID)).toBeNull();
  });

  it("lays ONE Sessions strip whose every card spans the band (ISS-11472)", () => {
    // whitlockk review on #8082: the Sessions specs checked card count, rank and
    // floor, so removing `grow` from the shared band props again stayed green.
    // This is the band-edge assertion for the WEB shell — the desktop shell's
    // twin is
    // `apps/desktop/src/renderer/components/sessions/__tests__/sessions-view-responsive.test.tsx`.
    // Counted rather than probed for absence: `strips` is an equality against 1
    // (a shell that rendered no strip fails), and `cards` is floored above zero
    // beside the stretch equality so the per-card check cannot pass vacuously.
    renderSessionsPage([]);

    const probe = summaryBandRankProbe(document.body);
    expect(probe.strips).toBe(1);
    expect(probe.cards).toBeGreaterThan(0);
    expect(probe.stretchingCards).toBe(probe.cards);
  });
});
