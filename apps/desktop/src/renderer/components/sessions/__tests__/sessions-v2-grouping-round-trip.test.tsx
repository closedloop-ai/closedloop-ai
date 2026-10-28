import {
  type TableFieldOption,
  TableGroupOrder,
} from "@closedloop-ai/design-system/components/ui/table-toolbar-model";
import type { SessionsListViewState } from "@repo/app/agents/components/sessions/sessions-list-view-state";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { SESSIONS_PRIORITY_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { createLocalAgentSessionsDataSource } from "../../../shared-agent-sessions/local-agent-sessions-data-source";

/**
 * ISS-9107 AC8 — the desktop host round-trips the WHOLE grouping state, not just
 * the primary dimension.
 *
 * `grouping` is a Split axis: only the primary level fits
 * `SessionsHostViewState.groupBy`, so the sub-level and both levels' order and
 * show-empty-groups have nowhere to go unless the host keeps them. A host that
 * drops them renders a Group menu whose sub-group, order and swap controls move
 * and snap straight back on the next commit — the ISS-8335 defect, and a
 * "control that appears and does nothing" under AC4.
 *
 * Driven through the SURFACE SEAM rather than the rendered menu: the contract is
 * that whatever the surface reports through `controlledView.onChange` comes back
 * in `controlledView.value`. A probe reports one settled view and reads the next
 * one, which is exactly the round trip, and fails when the host forgets the
 * half its own vocabulary cannot carry.
 */

const controlled: {
  groupOptions: readonly TableFieldOption[] | null;
  priorityColumn: boolean | null;
  value: SessionsListViewState | null;
  patch: Partial<SessionsListViewState> | null;
} = { groupOptions: null, priorityColumn: null, value: null, patch: null };

/**
 * Whether the active sessions source offers the priority write: when `local` is
 * set, the method is whatever the REAL local source built over that preload
 * offers, so the case pins the local probe rather than a hand-set key.
 */
const { priorityWrite } = vi.hoisted(() => ({
  priorityWrite: {
    supported: true,
    local: null as null | { preloadCarriesWrite: boolean },
  },
}));

vi.mock("@repo/app/agents/data-source/provider", async (original) => {
  const actual =
    await original<typeof import("@repo/app/agents/data-source/provider")>();
  return {
    ...actual,
    useAgentSessionsDataSource: () => {
      const { updatePriority, ...source } = actual.useAgentSessionsDataSource();
      if (priorityWrite.local) {
        return {
          ...source,
          updatePriority: localSourceUpdatePriority(
            priorityWrite.local.preloadCarriesWrite
          ),
        };
      }
      return priorityWrite.supported
        ? { ...source, updatePriority: updatePriority ?? vi.fn() }
        : source;
    },
  };
});

vi.mock(
  "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  () => ({
    SESSIONS_HISTORY_LIST_TEST_ID: "sessions-history-list",
    SessionsListSurfaceV2: (props: {
      controlledView?: {
        onChange: (next: SessionsListViewState) => void;
        value: SessionsListViewState;
      };
      groupOptions?: readonly TableFieldOption[];
      renderPriority?: unknown;
    }) => {
      const view = props.controlledView;
      controlled.value = view?.value ?? null;
      controlled.groupOptions = props.groupOptions ?? null;
      controlled.priorityColumn = props.renderPriority !== undefined;
      // The trigger lives INSIDE the tree under test so the click and the
      // re-render it causes are one commit; a button in a second React root
      // updates this one outside its `act` scope and the assertion then reads a
      // stale render.
      return (
        <button
          data-testid="report-grouping"
          onClick={() =>
            view?.onChange({ ...view.value, ...(controlled.patch ?? {}) })
          }
          type="button"
        >
          report
        </button>
      );
    },
  })
);

import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const LOCAL_SOURCE_READY = {
  localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
};
const REPORT_BUTTON = "report-grouping";

/**
 * The persisted primary dimension, as a real store.
 *
 * `reconcileSessionsGrouping` keeps the host's richer copy only while it still
 * AGREES with what the shell persisted, so an inert `setGroupBy` would make the
 * reconciler discard on every commit and this suite would report the drop it is
 * meant to detect for the wrong reason.
 */
let persistedGroupBy = "none";

beforeEach(() => {
  vi.clearAllMocks();
  controlled.groupOptions = null;
  controlled.priorityColumn = null;
  controlled.value = null;
  controlled.patch = null;
  priorityWrite.supported = true;
  priorityWrite.local = null;
  applyDefaultSessionsViewHooks();
  persistedGroupBy = "none";
  sessionsViewHookMocks().useSessionsViewState.mockImplementation(() => ({
    columnOrder: undefined,
    groupBy: persistedGroupBy,
    hiddenSummaryCards: new Set<string>(),
    isViewReady: true,
    resetView: vi.fn(),
    secondarySorts: [],
    setColumnOrder: vi.fn(),
    setGroupBy: (next: string) => {
      persistedGroupBy = next;
    },
    setSecondarySorts: vi.fn(),
    setSort: vi.fn(),
    sortDir: "desc",
    sortKey: null,
    toggleColumn: vi.fn(),
    toggleSummaryCard: vi.fn(),
    visibleColumns: new Set<string>(["name", "status"]),
  }));
  sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
    data: { list: listWith([{ id: "ses-1" }]) },
    isError: false,
    isFetching: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue(LOCAL_SOURCE_READY),
    onDbChanged: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
});

/** Re-reports the surface's own view with `patch` folded in, then re-reads it. */
function reportGrouping(patch: Partial<SessionsListViewState>): void {
  if (!controlled.value) {
    throw new Error("the desktop v2 branch supplied no controlled view");
  }
  controlled.patch = patch;
  fireEvent.click(screen.getByTestId(REPORT_BUTTON));
}

describe("desktop v2 grouping round trip (ISS-9107 AC8)", () => {
  it("keeps the sub-group, its order and show-empty-groups across the next render", async () => {
    await renderSessionsView();

    // The PRIMARY stays where the shell persists it, because that half already
    // round-trips through `groupBy` and moving it here would only prove the
    // reconciler's agreement check. What is under test is everything the host
    // vocabulary CANNOT carry: the sub-level, and both levels' order and
    // show-empty-groups.
    reportGrouping({
      grouping: {
        primary: {
          fieldId: null,
          order: TableGroupOrder.Descending,
          showEmptyGroups: true,
        },
        secondary: {
          fieldId: "harness",
          order: TableGroupOrder.Ascending,
          showEmptyGroups: false,
        },
      },
    });

    const next = controlled.value?.grouping;
    expect(next?.secondary?.fieldId).toBe("harness");
    expect(next?.secondary?.order).toBe(TableGroupOrder.Ascending);
    expect(next?.primary?.order).toBe(TableGroupOrder.Descending);
    expect(next?.primary?.showEmptyGroups).toBe(true);
  });
});

// A version-skewed source that cannot write Priority must not advertise the
// column or grouping operand as an enabled rollback capability.
describe("desktop v2 group options", () => {
  it.each([
    [false, false],
    [true, true],
  ])(
    "matches Priority visibility to the row operand and write support (%s)",
    async (supported, expected) => {
      priorityWrite.supported = supported;
      const rowWithPriority = { id: "ses-1", priority: null };
      sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
        data: { list: listWith([rowWithPriority]) },
        isError: false,
        isFetching: false,
        isLoading: false,
        isPlaceholderData: false,
        refetch: vi.fn(),
      });
      await renderSessionsView();

      const offered = controlled.groupOptions?.map((option) => option.id) ?? [];
      expect(offered).toContain(SessionGroupBy.Status);
      expect(offered.includes(SESSIONS_PRIORITY_COLUMN_ID)).toBe(expected);
      expect(controlled.priorityColumn).toBe(expected);
    }
  );
});

// An older local producer omits the priority operand entirely. That absence,
// not the write method by itself, removes the column and grouping option.
describe("desktop local mode priority", () => {
  it.each([true, false])(
    "follows the local source's own write (preload carries it: %s)",
    async (preloadCarriesWrite) => {
      priorityWrite.local = { preloadCarriesWrite };
      const localRow = {
        id: "ses-1",
        ...(preloadCarriesWrite ? { priority: null } : {}),
      };
      sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
        data: {
          list: listWith([localRow]),
        },
        isError: false,
        isFetching: false,
        isLoading: false,
        isPlaceholderData: false,
        refetch: vi.fn(),
      });
      await renderSessionsView();

      const offered = controlled.groupOptions?.map((option) => option.id) ?? [];
      expect(offered.includes(SESSIONS_PRIORITY_COLUMN_ID)).toBe(
        preloadCarriesWrite
      );
      expect(controlled.priorityColumn).toBe(preloadCarriesWrite);
    }
  );
});

/** The `updatePriority` the real local source offers over a minimal preload. */
function localSourceUpdatePriority(preloadCarriesWrite: boolean) {
  return createLocalAgentSessionsDataSource({
    agentSessionsApi: {
      ...(preloadCarriesWrite ? { updatePriority: vi.fn() } : {}),
    },
  } as Parameters<typeof createLocalAgentSessionsDataSource>[0]).updatePriority;
}
