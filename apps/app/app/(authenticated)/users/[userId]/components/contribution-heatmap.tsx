"use client";

import type { ContributionDay } from "@repo/api/src/types/user";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { memo, useMemo } from "react";

type ContributionHeatmapProps = {
  data: ContributionDay[];
};

const CELL_SIZE = 13;
const CELL_GAP = 2;
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function getIntensity(count: number, max: number): string {
  if (count === 0) {
    return "bg-muted";
  }
  const ratio = count / max;
  if (ratio <= 0.25) {
    return "bg-emerald-200 dark:bg-emerald-900";
  }
  if (ratio <= 0.5) {
    return "bg-emerald-400 dark:bg-emerald-700";
  }
  if (ratio <= 0.75) {
    return "bg-emerald-500 dark:bg-emerald-500";
  }
  return "bg-emerald-700 dark:bg-emerald-300";
}

export const ContributionHeatmap = memo(
  ({ data }: ContributionHeatmapProps) => {
    const { weeks, maxCount, monthHeaders } = useMemo(() => {
      const maxC = Math.max(...data.map((d) => d.count), 1);

      // Group days into weeks (columns)
      const wks: ContributionDay[][] = [];
      let currentWeek: ContributionDay[] = [];

      for (const day of data) {
        const dow = new Date(day.date).getUTCDay();
        if (dow === 0 && currentWeek.length > 0) {
          wks.push(currentWeek);
          currentWeek = [];
        }
        currentWeek.push(day);
      }
      if (currentWeek.length > 0) {
        wks.push(currentWeek);
      }

      // Compute month headers with positions
      const headers: { label: string; col: number }[] = [];
      let lastMonth = -1;
      for (let col = 0; col < wks.length; col++) {
        const firstDay = wks[col][0];
        const month = new Date(firstDay.date).getUTCMonth();
        if (month !== lastMonth) {
          headers.push({ label: MONTH_LABELS[month], col });
          lastMonth = month;
        }
      }

      return { weeks: wks, maxCount: maxC, monthHeaders: headers };
    }, [data]);

    const totalWidth = weeks.length * (CELL_SIZE + CELL_GAP);

    return (
      <TooltipProvider delayDuration={100}>
        <div className="overflow-x-auto">
          {/* Month labels */}
          <div className="relative mb-1 h-4" style={{ width: totalWidth }}>
            {monthHeaders.map((m) => (
              <span
                className="absolute text-muted-foreground text-xs"
                key={`${m.label}-${m.col}`}
                style={{ left: m.col * (CELL_SIZE + CELL_GAP) }}
              >
                {m.label}
              </span>
            ))}
          </div>

          {/* Grid */}
          <div className="flex gap-[2px]">
            {weeks.map((week) => (
              <div className="flex flex-col gap-[2px]" key={week[0].date}>
                {week.map((day) => (
                  <Tooltip key={day.date}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "rounded-sm",
                          getIntensity(day.count, maxCount)
                        )}
                        style={{
                          width: CELL_SIZE,
                          height: CELL_SIZE,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">
                        <span className="font-medium">
                          {day.count} contribution{day.count === 1 ? "" : "s"}
                        </span>{" "}
                        on {day.date}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            ))}
          </div>
        </div>
      </TooltipProvider>
    );
  }
);

ContributionHeatmap.displayName = "ContributionHeatmap";
