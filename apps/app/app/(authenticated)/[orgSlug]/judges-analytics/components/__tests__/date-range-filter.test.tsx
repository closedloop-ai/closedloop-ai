import { JudgesAnalyticsDateRangePreset } from "@repo/app/judges-analytics/lib/judges-analytics";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DateRangeFilter } from "../date-range-filter";

/** Fixed "now" used for every preset-click assertion below (local time, no UTC offset ambiguity). */
const FIXED_NOW = new Date(2026, 7, 19, 12, 0, 0);
/** The date the mocked DatePickerPopover "selects" when its button is clicked. */
const TEST_SELECTED_DATE = new Date(2026, 7, 10, 0, 0, 0);

vi.mock("@repo/app/shared/components/date-range-filter", () => ({
  DateRangeFilter: ({
    ranges,
    labels,
    onChange,
  }: {
    ranges: readonly string[];
    labels: Record<string, string>;
    onChange: (range: string) => void;
  }) => (
    <div>
      {ranges.map((range) => (
        <button key={range} onClick={() => onChange(range)} type="button">
          {labels[range]}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/date-picker-popover", () => ({
  DatePickerPopover: ({
    onSelect,
    placeholder,
    value,
  }: {
    onSelect: (date: Date | null) => void;
    placeholder?: string;
    value?: Date | null;
  }) => (
    <button onClick={() => onSelect(TEST_SELECTED_DATE)} type="button">
      {value ? format(value, "yyyy-MM-dd") : placeholder}
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DateRangeFilter - segmented presets", () => {
  test("renders Day, Week, Month, Year, and All time preset buttons", () => {
    render(
      <DateRangeFilter
        activePreset={JudgesAnalyticsDateRangePreset.Month}
        endDate="2026-08-19"
        onRangeChange={vi.fn()}
        startDate="2026-07-20"
      />
    );

    expect(screen.getByRole("button", { name: "Day" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Month" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Year" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "All time" })
    ).toBeInTheDocument();
  });
});

describe("DateRangeFilter - preset selection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
  });

  test("clicking Week calls onRangeChange with a 7-day window and the week preset", async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    render(
      <DateRangeFilter
        activePreset={JudgesAnalyticsDateRangePreset.Month}
        endDate="2026-08-19"
        onRangeChange={onRangeChange}
        startDate="2026-07-20"
      />
    );

    await user.click(screen.getByRole("button", { name: "Week" }));

    expect(onRangeChange).toHaveBeenCalledWith(
      "2026-08-12",
      "2026-08-19",
      JudgesAnalyticsDateRangePreset.Week
    );
  });

  test("clicking All time calls onRangeChange with the fixed all-time start date", async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    render(
      <DateRangeFilter
        activePreset={JudgesAnalyticsDateRangePreset.Month}
        endDate="2026-08-19"
        onRangeChange={onRangeChange}
        startDate="2026-07-20"
      />
    );

    await user.click(screen.getByRole("button", { name: "All time" }));

    expect(onRangeChange).toHaveBeenCalledWith(
      "2000-01-01",
      "2026-08-19",
      JudgesAnalyticsDateRangePreset.All
    );
  });
});

describe("DateRangeFilter - custom date pickers", () => {
  test("renders the current start and end dates", () => {
    render(
      <DateRangeFilter
        activePreset={JudgesAnalyticsDateRangePreset.Custom}
        endDate="2026-08-19"
        onRangeChange={vi.fn()}
        startDate="2026-07-20"
      />
    );

    expect(
      screen.getByRole("button", { name: "2026-07-20" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "2026-08-19" })
    ).toBeInTheDocument();
  });

  test("changing the custom start date calls onRangeChange with the Custom preset", async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    render(
      <DateRangeFilter
        activePreset={JudgesAnalyticsDateRangePreset.Custom}
        endDate="2026-08-19"
        onRangeChange={onRangeChange}
        startDate="2026-07-20"
      />
    );

    await user.click(screen.getByRole("button", { name: "2026-07-20" }));

    expect(onRangeChange).toHaveBeenCalledWith(
      "2026-08-10",
      "2026-08-19",
      JudgesAnalyticsDateRangePreset.Custom
    );
  });

  test("changing the custom end date calls onRangeChange with the Custom preset", async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    render(
      <DateRangeFilter
        activePreset={JudgesAnalyticsDateRangePreset.Custom}
        endDate="2026-08-19"
        onRangeChange={onRangeChange}
        startDate="2026-07-20"
      />
    );

    await user.click(screen.getByRole("button", { name: "2026-08-19" }));

    expect(onRangeChange).toHaveBeenCalledWith(
      "2026-07-20",
      "2026-08-10",
      JudgesAnalyticsDateRangePreset.Custom
    );
  });
});
