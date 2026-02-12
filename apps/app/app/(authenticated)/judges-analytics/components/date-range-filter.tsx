"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { format, parse, subDays } from "date-fns";
import { useState } from "react";

const ALL_TIME_START = "2000-01-01";

/** Parse "yyyy-MM-dd" as local midnight (not UTC) */
const toLocalDate = (dateStr: string) =>
  parse(dateStr, "yyyy-MM-dd", new Date());

type DateRangeFilterProps = {
  startDate: string;
  endDate: string;
  onRangeChange: (start: string, end: string) => void;
};

export function DateRangeFilter({
  startDate,
  endDate,
  onRangeChange,
}: DateRangeFilterProps) {
  const [activePreset, setActivePreset] = useState<
    "day" | "week" | "month" | "year" | "all" | "custom" | null
  >("month");

  const handlePresetClick = (
    preset: "day" | "week" | "month" | "year",
    days: number
  ) => {
    const end = new Date();
    const start = subDays(end, days);
    setActivePreset(preset);
    onRangeChange(format(start, "yyyy-MM-dd"), format(end, "yyyy-MM-dd"));
  };

  const handleAllTimeClick = () => {
    setActivePreset("all");
    onRangeChange(ALL_TIME_START, format(new Date(), "yyyy-MM-dd"));
  };

  const handleCustomDateChange = (
    dateType: "start" | "end",
    date: Date | null
  ) => {
    setActivePreset("custom");

    if (dateType === "start" && date) {
      onRangeChange(format(date, "yyyy-MM-dd"), endDate);
    } else if (dateType === "end" && date) {
      onRangeChange(startDate, format(date, "yyyy-MM-dd"));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex gap-2">
        <Button
          className={activePreset === "day" ? "bg-accent" : ""}
          onClick={() => handlePresetClick("day", 1)}
          variant="outline"
        >
          Day
        </Button>
        <Button
          className={activePreset === "week" ? "bg-accent" : ""}
          onClick={() => handlePresetClick("week", 7)}
          variant="outline"
        >
          Week
        </Button>
        <Button
          className={activePreset === "month" ? "bg-accent" : ""}
          onClick={() => handlePresetClick("month", 30)}
          variant="outline"
        >
          Month
        </Button>
        <Button
          className={activePreset === "year" ? "bg-accent" : ""}
          onClick={() => handlePresetClick("year", 365)}
          variant="outline"
        >
          Year
        </Button>
        <Button
          className={activePreset === "all" ? "bg-accent" : ""}
          onClick={handleAllTimeClick}
          variant="outline"
        >
          All time
        </Button>
      </div>

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
