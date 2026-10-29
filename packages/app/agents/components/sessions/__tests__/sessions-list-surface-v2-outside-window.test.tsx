import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import {
  DateRange,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import {
  SESSIONS_FILTERED_EMPTY_TITLE,
  SESSIONS_GENUINELY_EMPTY_TITLE,
} from "../sessions-empty-state";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-11913 — a server-driven list the default window empties.
 *
 * The rows are one already-windowed page, so the surface cannot see sessions
 * older than the window; the host's unwindowed probe
 * (`hasSessionsOutsideWindow`) is the only evidence. Each case below is one
 * answer that probe can give, on the mount both shells use.
 */

const DEFAULT_VIEW: SessionsListViewState = {
  sortBy: null,
  sortDir: "asc",
  grouping: EMPTY_TABLE_GROUPING,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  dateRange: DEFAULT_DATE_RANGE,
  visibleColumnIds: new Set(["status"]),
  page: 0,
  scopeUserId: null,
};

const OLDER_ROW_NAME = "agent/older-than-the-window";

const DATE_RANGE_EMPTY_COPY =
  "No sessions were active in the selected date range.";

const FACET_FILTERED_EMPTY_COPY =
  "No sessions match the current filters. Try clearing or widening a filter.";

let restoreContainerWidth: (() => void) | null = null;

beforeEach(() => {
  restoreContainerWidth = stubContainerWidthPx(1440);
});

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderEmptyPage({
  hasSessionsOutsideWindow,
  value = DEFAULT_VIEW,
}: {
  hasSessionsOutsideWindow: boolean | undefined;
  value?: SessionsListViewState;
}) {
  const onChange = vi.fn();
  const view = render(
    <SessionsListSurfaceV2
      controlledView={{ onChange, totalRows: 0, value }}
      hasSessionsOutsideWindow={hasSessionsOutsideWindow}
      rows={[]}
      usage={undefined}
    />
  );
  return { ...view, onChange };
}

describe("SessionsListSurfaceV2 — sessions outside the window (ISS-11913)", () => {
  it("keeps the genuinely-empty state when the probe finds no sessions at all", () => {
    renderEmptyPage({ hasSessionsOutsideWindow: false });

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeNull();
  });

  it("names the window and offers Show all time when sessions exist outside it", () => {
    renderEmptyPage({ hasSessionsOutsideWindow: true });

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(screen.getByText(DATE_RANGE_EMPTY_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show all time" })
    ).toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_GENUINELY_EMPTY_TITLE)).toBeNull();
  });

  it("keeps the facet-filtered empty when a facet is also narrowing", () => {
    renderEmptyPage({
      hasSessionsOutsideWindow: true,
      value: {
        ...DEFAULT_VIEW,
        facets: {
          ...DEFAULT_SESSION_FACET_FILTERS,
          statuses: [SESSION_STATUS.ACTIVE],
        },
      },
    });

    expect(screen.getByText(FACET_FILTERED_EMPTY_COPY)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeNull();
  });

  it("Show all time widens the window to all time, and the sessions render", () => {
    const { onChange, rerender } = renderEmptyPage({
      hasSessionsOutsideWindow: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Show all time" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({
      dateRange: DateRange.AllTime,
      page: 0,
    });

    // The host writes the range back and re-reads, unwindowed.
    rerender(
      <SessionsListSurfaceV2
        controlledView={{
          onChange,
          totalRows: 1,
          value: { ...DEFAULT_VIEW, dateRange: DateRange.AllTime },
        }}
        hasSessionsOutsideWindow={undefined}
        rows={[createSessionTableRowFixture({ name: OLDER_ROW_NAME })]}
        usage={undefined}
      />
    );

    expect(screen.getByText(OLDER_ROW_NAME)).toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_FILTERED_EMPTY_TITLE)).toBeNull();
  });
});
