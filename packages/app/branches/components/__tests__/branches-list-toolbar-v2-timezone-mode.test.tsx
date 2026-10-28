import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  TIMEZONE_MODE_CONTROL_LABEL,
  TIMEZONE_MODE_LABELS,
  TimezoneMode,
} from "../../../shared/lib/date-window-timezone-mode";
import { BranchesListToolbarV2 } from "../branches-list-toolbar-v2";
import type { BranchesToolbarProps } from "../branches-toolbar-model";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

/**
 * ISS-9619 — the day-boundary control on the GRID-TABLE-V2 Branches toolbar.
 *
 * Same reason as the Sessions v2 suite: this generation renders the control from
 * its own expression, so the v1 Branches test cannot speak for it. Without these
 * cases the control can be deleted here with every other suite green.
 */

const VISIBLE_COLUMNS = new Set(["owner", "status", "repo"]);

function renderToolbar(overrides: Partial<BranchesToolbarProps> = {}) {
  return render(
    <BranchesListToolbarV2
      {...branchesToolbarPropsFixture({
        rows: [],
        visibleColumns: VISIBLE_COLUMNS,
        ...overrides,
      })}
    />
  );
}

describe("BranchesListToolbarV2 day-boundary control (ISS-9619)", () => {
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
});
