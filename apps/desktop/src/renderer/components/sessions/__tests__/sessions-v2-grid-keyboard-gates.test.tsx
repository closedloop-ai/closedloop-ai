import {
  GRID_SELECTABLE_ROW_SELECTOR,
  queryGridDataRows,
} from "@closedloop-ai/design-system/lib/grid-table-v2-row-drag";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { ArtifactTagAvailability } from "@repo/api/src/types/tag";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  rerenderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const onlineStatus = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../../shared-agent-sessions/use-online-status", () => ({
  useOnlineStatus: onlineStatus,
}));

/**
 * ISS-10188 — the three `GridTableV2` keyboard keys reach DESKTOP, which their
 * docblocks denied. Desktop mounts the grid through the shared tree
 * (`sessions-v2-view.tsx` → `SessionsListSurfaceV2` → `SessionsListGridV2`),
 * so a flip moves the desktop keyboard model and fails here first.
 *
 * Keys are LITERALS, not imports from the module whose placement they police.
 * Each gate is asserted in BOTH states against the SAME locator, so neither arm
 * can pass on a selector that matches nothing. `grid-table-v2` stays ON
 * throughout: with the outer gate closed the desktop renders v1 and consults
 * none of these keys.
 *
 * ISS-10528 took the THIRD key's marker out of that list. Desktop now supplies
 * bulk tags conditionally, so this file covers both the online flag-on selection
 * path and the exact flag-off/offline states that withhold it.
 */

const LOCAL_SOURCE_READY = {
  localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
};
const SELECTED_STATUS_NAME = /selected/i;

/**
 * Per gate: the key as PostHog spells it, and a locator only the open state can
 * emit — the attribute the primitive adds, never a `tabindex` both states paint.
 */
const GATES = [
  {
    key: "grid-table-v2-single-tab-stop",
    locator: "[data-grid-suppressed-tab-stop]",
    name: "single tab stop",
  },
  {
    key: "grid-table-v2-navigable-header-cells",
    locator: "[role='columnheader'][data-grid-cell]",
    name: "navigable header cells",
  },
] as const;

/**
 * The grid's DATA rows. Chrome rows carry `[data-grid-row]` too since ISS-8930,
 * so an unfiltered count would make "the grid rendered rows" true of a body that
 * painted only its header — and the absence assertion below would then hold for
 * a boot that seeded nothing.
 */
function dataRows(): HTMLElement[] {
  return queryGridDataRows(document);
}

function seedViewState(): void {
  sessionsViewHookMocks().useSessionsViewState.mockReturnValue({
    columnOrder: undefined,
    groupBy: "none",
    hiddenSummaryCards: new Set<string>(),
    isViewReady: true,
    resetView: vi.fn(),
    secondarySorts: [],
    setSort: vi.fn(),
    sortDir: "desc",
    sortKey: null,
    toggleColumn: vi.fn(),
    toggleSummaryCard: vi.fn(),
    visibleColumns: new Set<string>(["name", "status"]),
  });
}

const SEEDED_ROW_IDS = ["ses-1", "ses-2"] as const;
const TWO_SESSIONS_SELECTED = "2 sessions selected";

function seedRows(
  rows = SEEDED_ROW_IDS.map((id) => createAgentSessionListItemFixture({ id }))
): void {
  sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
    data: { list: listWith(rows) },
    isError: false,
    isFetching: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  seedViewState();
  seedRows();
  onlineStatus.mockReturnValue(true);
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue(LOCAL_SOURCE_READY),
    onDbChanged: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
});

describe("desktop Sessions GridTableV2 keyboard gates (ISS-10188)", () => {
  it.each(GATES)(
    "$name reaches the desktop grid unconditionally",
    async ({ locator }) => {
      // ISS-10245 retired all three keys ENABLED, so the closed arm that used to
      // open this case asserted a state the grid can no longer reach. The header
      // count below keeps it from going vacuous: a grid that rendered nothing
      // would satisfy neither assertion.
      await renderSessionsView();

      expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(0);
      expect(document.querySelectorAll(locator).length).toBeGreaterThan(0);
    }
  );

  /**
   * ISS-10528. Before it, this shell painted the marker and the drag it arms
   * spent the reader's native text selection to select nothing: capture taken,
   * `select-none` held, the closing click swallowed, every row resolving through
   * `suppressRowSelection`.
   */
  it.each([
    { flagEnabled: false, isOnline: true, state: "bulk-tag flag off" },
    { flagEnabled: true, isOnline: false, state: "offline" },
  ])(
    "withholds selection semantics while $state",
    async ({ flagEnabled, isOnline }) => {
      sessionsViewHookMocks().useFeatureFlagEnabledOptional.mockImplementation(
        (key: string) => key === SESSIONS_ARTIFACT_TAGS_FLAG_KEY && flagEnabled
      );
      onlineStatus.mockReturnValue(isOnline);
      await renderSessionsView();

      expect(
        document.querySelectorAll(GRID_SELECTABLE_ROW_SELECTOR)
      ).toHaveLength(0);
      // Anti-vacuity: EVERY seeded row was painted, so the count above is the
      // gesture being withheld rather than a list that never mounted.
      expect(dataRows()).toHaveLength(SEEDED_ROW_IDS.length);
      for (const row of dataRows()) {
        expect(row.hasAttribute("aria-selected")).toBe(false);
      }
      const firstRow = dataRows().at(0);
      if (!firstRow) {
        throw new Error("Expected a painted Desktop Sessions row");
      }
      fireEvent.click(firstRow);

      expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
      expect(
        screen.queryByRole("status", { name: SELECTED_STATUS_NAME })
      ).toBeNull();
      for (const row of dataRows()) {
        expect(row.hasAttribute("aria-selected")).toBe(false);
      }
    }
  );

  it("selects online writable rows and clears them when the Desktop result becomes empty", async () => {
    sessionsViewHookMocks().useFeatureFlagEnabledOptional.mockImplementation(
      (key: string) => key === SESSIONS_ARTIFACT_TAGS_FLAG_KEY
    );
    const writableRows = SEEDED_ROW_IDS.map((id) =>
      createAgentSessionListItemFixture({
        id,
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: false },
      })
    );
    seedRows(writableRows);
    const view = await renderSessionsView();
    fireEvent.click(dataRows()[0]!);
    fireEvent.click(dataRows()[1]!, { ctrlKey: true });
    expect(
      screen.getByRole("toolbar", {
        name: TWO_SESSIONS_SELECTED,
      })
    ).toBeTruthy();

    seedRows([]);
    await rerenderSessionsView(view);

    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByText("No sessions selected")).toBeTruthy();

    seedRows(writableRows);
    await rerenderSessionsView(view);

    for (const row of dataRows()) {
      expect(row.getAttribute("aria-selected")).toBe("false");
    }
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  // ISS-10245 retired all three keys ENABLED. The case that stood here asserted
  // that opening one key left the other two closed — mutual exclusivity that no
  // longer exists, since every marker is now unconditional. Each gate's own
  // marker is covered by the parameterised case above.
  it("paints every gate's marker on one render, with no key assigned", async () => {
    await renderSessionsView();

    // EVERY header, not merely one: a half-roving header row is worse for a
    // keyboard user than none at all.
    const headers = screen.getAllByRole("columnheader");
    expect(headers.length).toBeGreaterThan(0);
    expect(
      headers.filter((header) => header.hasAttribute("data-grid-cell"))
    ).toHaveLength(headers.length);
    expect(
      document.querySelectorAll("[data-grid-suppressed-tab-stop]").length
    ).toBeGreaterThan(0);
  });
});
