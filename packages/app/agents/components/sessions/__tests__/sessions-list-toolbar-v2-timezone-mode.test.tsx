import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  TIMEZONE_MODE_CONTROL_LABEL,
  TIMEZONE_MODE_LABELS,
  TimezoneMode,
} from "../../../../shared/lib/date-window-timezone-mode";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "../../../../shared/lib/facet-filter";
import { TABLE_DATE_RANGE_OPTIONS } from "../../../../shared/lib/table-date-range-options";
import { SessionsListToolbarV2 } from "../sessions-list-toolbar-v2";

/**
 * ISS-9619 — the day-boundary control on the GRID-TABLE-V2 Sessions toolbar.
 *
 * The v1 toolbar has its own suite, and that is exactly why this one exists: the
 * two generations spell the control's presence and its suppression rule
 * SEPARATELY, so a test that only drives v1 stays green while the control is
 * deleted from the generation the product is moving to. Each case below names a
 * mutation it kills.
 */

function renderToolbar(
  overrides: Partial<Parameters<typeof SessionsListToolbarV2>[0]> = {}
) {
  return render(
    <SessionsListToolbarV2
      columns={[]}
      dateRange="7d"
      dateRangeOptions={TABLE_DATE_RANGE_OPTIONS}
      filterController={NOOP_TABLE_FILTERS_CONTROLLER}
      filterViewModel={buildFacetOnlyFiltersViewModel(undefined)}
      hiddenSummaryCardIds={new Set()}
      onApplySavedView={() => undefined}
      onClearFilters={() => undefined}
      onDateRangeChange={() => undefined}
      onSaveView={() => undefined}
      onToggleColumn={() => undefined}
      onToggleSummaryCard={() => undefined}
      // ISS-10361 collapsed the flat sort/group props into one optional slot.
      // Kept wired rather than dropped: omitting it renders no sort or group
      // menu at all, which is a different toolbar from the one this suite's
      // day-boundary cases are meant to sit beside.
      sortGrouping={{
        grouping: EMPTY_TABLE_GROUPING,
        groupOptions: [],
        onClearSort: () => undefined,
        onGroupingChange: () => undefined,
        onSort: () => undefined,
        onSortsChange: () => undefined,
        sortBy: null,
        sortOptions: [],
        sorts: [],
      }}
      visibleColumnIds={new Set()}
      {...overrides}
    />
  );
}

describe("SessionsListToolbarV2 day-boundary control (ISS-9619)", () => {
  it("renders no control when the host supplies no writer", () => {
    renderToolbar();

    expect(
      screen.queryByRole("radiogroup", { name: TIMEZONE_MODE_CONTROL_LABEL })
    ).not.toBeInTheDocument();
  });

  /** Kills: deleting `TimezoneModeFilter` from this toolbar's leading slot. */
  it("renders the control and reports the mode the reader picks", async () => {
    const user = userEvent.setup();
    const onTimezoneModeChange = vi.fn();
    renderToolbar({ onTimezoneModeChange, timezoneMode: TimezoneMode.Utc });

    const group = screen.getByRole("radiogroup", {
      name: TIMEZONE_MODE_CONTROL_LABEL,
    });
    await user.click(
      within(group).getByRole("radio", {
        name: TIMEZONE_MODE_LABELS[TimezoneMode.Local],
      })
    );

    expect(onTimezoneModeChange).toHaveBeenCalledWith(TimezoneMode.Local);
  });

  /** Kills: deleting or inverting this toolbar's own custom-window suppression. */
  it("withholds the control while an explicit window owns the day boundary", () => {
    renderToolbar({
      customDateWindow: { from: "2026-08-01", to: "2026-08-07" },
      onCustomDateWindowChange: () => undefined,
      onTimezoneModeChange: () => undefined,
      timezoneMode: TimezoneMode.Utc,
    });

    expect(
      screen.queryByRole("radiogroup", { name: TIMEZONE_MODE_CONTROL_LABEL })
    ).not.toBeInTheDocument();
  });
});
