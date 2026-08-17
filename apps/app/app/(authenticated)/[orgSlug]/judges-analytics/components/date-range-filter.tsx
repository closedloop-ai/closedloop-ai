"use client";

import {
  JUDGES_ANALYTICS_DATE_RANGE_DAYS,
  JudgesAnalyticsDateRangePreset,
  judgesAnalyticsAllTimeRange,
} from "@repo/app/judges-analytics/lib/judges-analytics";
import { DateRangeFilter as SegmentedRangeFilter } from "@repo/app/shared/components/date-range-filter";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { format, parse, subDays } from "date-fns";

/** Parse "yyyy-MM-dd" as local midnight (not UTC) */
const toLocalDate = (dateStr: string) =>
  parse(dateStr, "yyyy-MM-dd", new Date());

type DateRangeFilterProps = {
  startDate: string;
  endDate: string;
  activePreset: JudgesAnalyticsDateRangePreset;
  onRangeChange: (
    start: string,
    end: string,
    preset: JudgesAnalyticsDateRangePreset
  ) => void;
};

/**
 * The presets exposed as a segmented control. `Custom` is driven by the date
 * pickers below, not a pill, so it is intentionally absent here; when it is
 * active no pill reads selected.
 */
const RANGE_PRESETS = [
  JudgesAnalyticsDateRangePreset.Day,
  JudgesAnalyticsDateRangePreset.Week,
  JudgesAnalyticsDateRangePreset.Month,
  JudgesAnalyticsDateRangePreset.Year,
  JudgesAnalyticsDateRangePreset.All,
] as const;

type RangePreset = (typeof RANGE_PRESETS)[number];

const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  [JudgesAnalyticsDateRangePreset.Day]: "Day",
  [JudgesAnalyticsDateRangePreset.Week]: "Week",
  [JudgesAnalyticsDateRangePreset.Month]: "Month",
  [JudgesAnalyticsDateRangePreset.Year]: "Year",
  [JudgesAnalyticsDateRangePreset.All]: "All time",
};

export function DateRangeFilter({
  startDate,
  endDate,
  activePreset,
  onRangeChange,
}: DateRangeFilterProps) {
  const handlePresetChange = (preset: RangePreset) => {
    if (preset === JudgesAnalyticsDateRangePreset.All) {
      const { start, end, preset: allPreset } = judgesAnalyticsAllTimeRange();
      onRangeChange(start, end, allPreset);
      return;
    }
    const end = new Date();
    const start = subDays(end, JUDGES_ANALYTICS_DATE_RANGE_DAYS[preset]);
    onRangeChange(
      format(start, "yyyy-MM-dd"),
      format(end, "yyyy-MM-dd"),
      preset
    );
  };

  const handleCustomDateChange = (
    dateType: "start" | "end",
    date: Date | null
  ) => {
    if (dateType === "start" && date) {
      onRangeChange(
        format(date, "yyyy-MM-dd"),
        endDate,
        JudgesAnalyticsDateRangePreset.Custom
      );
    } else if (dateType === "end" && date) {
      onRangeChange(
        startDate,
        format(date, "yyyy-MM-dd"),
        JudgesAnalyticsDateRangePreset.Custom
      );
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-4">
      <SegmentedRangeFilter<RangePreset>
        ariaLabel="Date range"
        labels={RANGE_PRESET_LABELS}
        onChange={handlePresetChange}
        ranges={RANGE_PRESETS}
        shortLabels={RANGE_PRESET_LABELS}
        value={activePreset as RangePreset}
      />

      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">Custom:</span>
        <DatePickerPopover
          onSelect={(date) => handleCustomDateChange("start", date)}
          placeholder="Start date"
          toDate={endDate ? toLocalDate(endDate) : new Date()}
          value={startDate ? toLocalDate(startDate) : null}
        />
        <span className="text-muted-foreground">to</span>
        <DatePickerPopover
          fromDate={startDate ? toLocalDate(startDate) : undefined}
          onSelect={(date) => handleCustomDateChange("end", date)}
          placeholder="End date"
          toDate={new Date()}
          value={endDate ? toLocalDate(endDate) : null}
        />
      </div>
    </div>
  );
}
