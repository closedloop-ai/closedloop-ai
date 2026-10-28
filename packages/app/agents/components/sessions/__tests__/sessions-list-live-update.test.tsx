import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { sessionsRangeReadout } from "@repo/app/agents/lib/sessions-range-readout";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { userKeys } from "@repo/app/users/hooks/use-users";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import {
  SESSIONS_LEAD_SORT_FIELD,
  type SessionsListSortField,
} from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "ses-live-1";
const ROW_NAME = "agent/active-work";
const BASE_ROW = createSessionTableRowFixture({
  id: ROW_ID,
  name: ROW_NAME,
  status: SESSION_STATUS.ACTIVE,
  user: { id: VIEWER_ID, name: "Session owner" },
});
const SECOND_ROW = createSessionTableRowFixture({
  id: "ses-live-2",
  name: "agent/other-work",
});
const FAVORITES = {
  favoriteIds: new Set<string>(),
  onChange: () => undefined,
  onToggleFavorite: () => undefined,
};

let restoreWidth: (() => void) | undefined;

function renderedRowIds(): string[] {
  const ids = new Set([BASE_ROW.id, SECOND_ROW.id]);
  return Array.from(document.querySelectorAll("[data-grid-row-id]"))
    .map((row) => row.getAttribute("data-grid-row-id") ?? "")
    .filter((id) => ids.has(id));
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  restoreWidth?.();
  restoreWidth = undefined;
});

function liveList({
  isPending = false,
  onSelectionChange,
  rows,
  sortBy = null,
  tableScrollRef,
}: {
  isPending?: boolean;
  sortBy?: SessionsListSortField | null;
  onSelectionChange: (ids: ReadonlySet<string>) => void;
  rows: readonly SessionTableRow[];
  tableScrollRef: (node: HTMLElement | null) => void;
}) {
  return (
    <AppCoreStoryProviders
      queryData={[[userKeys.currentUser(), { id: VIEWER_ID }]]}
    >
      <SessionsListSurfaceV2
        controlledView={{
          onChange: () => undefined,
          totalRows: rows.length,
          value: {
            dateRange: DEFAULT_DATE_RANGE,
            facets: DEFAULT_SESSION_FACET_FILTERS,
            grouping: EMPTY_TABLE_GROUPING,
            page: 0,
            scopeUserId: null,
            sortBy,
            sortDir: "desc",
            visibleColumnIds: new Set(["status"]),
          },
        }}
        favorites={FAVORITES}
        getSessionHref={(row) => `/sessions/${row.id}`}
        isPending={isPending}
        rows={rows}
        selection={{
          onChange: onSelectionChange,
          selectedIds: new Set([ROW_ID]),
        }}
        tableScrollRef={tableScrollRef}
        usage={undefined}
      />
    </AppCoreStoryProviders>
  );
}

describe("Sessions material live-update announcement", () => {
  it("announces a settled same-count replacement without losing selection, draft, focus or scroll", async () => {
    restoreWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    let scroller: HTMLElement | null = null;
    const tableScrollRef = (node: HTMLElement | null) => {
      scroller = node;
    };
    const firstRows = [BASE_ROW, SECOND_ROW];
    const { rerender } = render(
      liveList({ onSelectionChange, rows: firstRows, tableScrollRef })
    );
    const status = screen.getByTestId("sessions-live-update-status");
    // `<output>` is an implicit polite `status` region. No explicit `aria-live`:
    // a modal's hideOthers would keep this page exposed behind it.
    expect(status.tagName).toBe("OUTPUT");
    expect(status).not.toHaveAttribute("aria-live");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toBeEmptyDOMElement();

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: `Edit session name for ${ROW_NAME}`,
      })
    );
    const field = screen.getByRole("textbox", {
      name: `Edit session name for ${ROW_NAME}`,
    });
    await user.clear(field);
    await user.type(field, "uncommitted name");
    expect(field).toHaveFocus();
    const scrollBand = scroller as HTMLElement | null;
    if (!scrollBand) {
      throw new Error("Expected the shared list scroll band");
    }
    scrollBand.scrollTop = 120;
    onSelectionChange.mockClear();

    const nextRows = [
      { ...BASE_ROW, status: SESSION_STATUS.INACTIVE },
      SECOND_ROW,
    ];
    // A revision refresh holds last-good rows; it is not a first-load `isPending`
    // transition, which deliberately replaces the grid with a skeleton.
    rerender(liveList({ onSelectionChange, rows: nextRows, tableScrollRef }));

    await waitFor(() =>
      expect(status).toHaveTextContent(
        sessionsRangeReadout({
          pageIndex: 0,
          pageSize: 25,
          rowsOnPage: 2,
          total: 2,
        }) ?? ""
      )
    );
    expect(field).toHaveValue("uncommitted name");
    expect(field).toHaveFocus();
    expect(scroller).toBe(scrollBand);
    expect(scrollBand.scrollTop).toBe(120);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(
      document.querySelector(`[data-grid-row-id="${ROW_ID}"]`)
    ).toHaveAttribute("aria-selected", "true");
  });

  it("re-baselines instead of announcing when the reader re-sorts the page", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    restoreWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    const tableScrollRef = () => undefined;
    const { rerender } = render(
      liveList({
        onSelectionChange,
        rows: [BASE_ROW, SECOND_ROW],
        tableScrollRef,
      })
    );
    const status = screen.getByTestId("sessions-live-update-status");
    expect(renderedRowIds()).toEqual([BASE_ROW.id, SECOND_ROW.id]);
    // A controlled host is server-driven: the reader's sort arrives as the
    // producer's reordered page for the new view.
    rerender(
      liveList({
        onSelectionChange,
        rows: [SECOND_ROW, BASE_ROW],
        sortBy: SESSIONS_LEAD_SORT_FIELD,
        tableScrollRef,
      })
    );
    // The reader's own sort really reordered the page, and it is not news.
    expect(renderedRowIds()).toEqual([SECOND_ROW.id, BASE_ROW.id]);
    // Flush the hook's deferred write, so an announcement would have landed.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(status).toBeEmptyDOMElement();
  });

  it("still announces a same-view replacement after a re-sort", async () => {
    restoreWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    const tableScrollRef = () => undefined;
    const { rerender } = render(
      liveList({ onSelectionChange, rows: [BASE_ROW], tableScrollRef })
    );
    const status = screen.getByTestId("sessions-live-update-status");
    rerender(
      liveList({
        onSelectionChange,
        rows: [BASE_ROW],
        sortBy: SESSIONS_LEAD_SORT_FIELD,
        tableScrollRef,
      })
    );
    rerender(
      liveList({
        onSelectionChange,
        rows: [{ ...BASE_ROW, status: SESSION_STATUS.INACTIVE }],
        sortBy: SESSIONS_LEAD_SORT_FIELD,
        tableScrollRef,
      })
    );
    await waitFor(() => expect(status).not.toBeEmptyDOMElement());
  });

  it("does not announce a clock-only duration tick", () => {
    restoreWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    const tableScrollRef = () => undefined;
    const { rerender } = render(
      liveList({ onSelectionChange, rows: [BASE_ROW], tableScrollRef })
    );
    const status = screen.getByTestId("sessions-live-update-status");
    expect(status).toBeEmptyDOMElement();
    rerender(
      liveList({
        onSelectionChange,
        rows: [{ ...BASE_ROW, durationLabel: "2h 1m", durationMs: 7_260_000 }],
        tableScrollRef,
      })
    );
    expect(status).toBeEmptyDOMElement();
  });

  it("leaves changed totals to the existing footer live region", async () => {
    restoreWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    const tableScrollRef = () => undefined;
    const { rerender } = render(
      liveList({ onSelectionChange, rows: [BASE_ROW], tableScrollRef })
    );
    const status = screen.getByTestId("sessions-live-update-status");
    expect(status).toBeEmptyDOMElement();
    rerender(
      liveList({
        onSelectionChange,
        rows: [{ ...BASE_ROW, status: SESSION_STATUS.INACTIVE }],
        tableScrollRef,
      })
    );
    await waitFor(() => expect(status).not.toBeEmptyDOMElement());
    rerender(
      liveList({
        onSelectionChange,
        rows: [BASE_ROW, SECOND_ROW],
        tableScrollRef,
      })
    );
    await waitFor(() => expect(status).toBeEmptyDOMElement());
    expect(
      await screen.findByText(
        sessionsRangeReadout({
          pageIndex: 0,
          pageSize: 25,
          rowsOnPage: 2,
          total: 2,
        }) ?? ""
      )
    ).toBeTruthy();
  });
});
