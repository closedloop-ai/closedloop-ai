"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { useId, useRef } from "react";
import {
  ACTIVITY_HEATMAP_EMPTY_LEVEL_COLOR,
  ACTIVITY_HEATMAP_RAMP_ALPHA,
} from "./activity-heatmap-colors";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";
import type { AnalyticsHeatmapWeek } from "../types";

type ActivityHeatmapProps = {
  weeks: AnalyticsHeatmapWeek[];
  className?: string;
  /**
   * Accessible name for the whole grid. Insights lets several heatmaps share a
   * dashboard, so each instance should carry its own name (e.g. "Contributions"
   * or a tile title); screen-reader grid navigation otherwise lists multiple
   * indistinct "Activity by day" regions. Defaults to "Activity by day".
   */
  label?: string;
  /**
   * Formats a cell's value for its tooltip and accessible label. Defaults to a
   * plain event count (e.g. "1,024 events") so the primitive stays
   * product-agnostic; callers whose cells carry another unit (currency,
   * tokens, …) pass their own formatter.
   */
  valueFormatter?: (count: number) => string;
  /**
   * CSS custom property (without the surrounding `var(...)`) the density ramp
   * is mixed from — always a design-system color token so the chart stays
   * on-theme in light and dark. Defaults to `--primary`; product surfaces that
   * read a different hue (e.g. contributions as green commits) pass their own
   * token such as `--success`.
   */
  accentVar?: string;
};

// Fixed-grid layout constants. Cell footprint and inter-cell gap are structural
// dimensions of a calendar lattice (like the Insights turn-density heatmap's
// CELL/GAP), not themeable surface values — they carry no color.
const CELL_SIZE = 13;
const CELL_GAP = 3;
const COLUMN_STRIDE = CELL_SIZE + CELL_GAP;
const DAYS_PER_WEEK = 7;

// Density ramp expressed as opacity over the accent token. Driving the ramp off
// a single design-system color keeps the chart on-theme in both light and dark
// (the token flips with the theme; the alpha steps ride on top), replacing the
// previous hardcoded blue→violet rgb() literals that rendered near-black on
// light backgrounds. The floor sits at 0.34 (not 0.16) so the lightest active
// day stays clearly distinct from an empty --muted day — the single distinction
// the chart exists to make. Empty days fall back to --muted.
const RAMP_ALPHA = ACTIVITY_HEATMAP_RAMP_ALPHA;
const RAMP_LEVELS = RAMP_ALPHA.length;

// Weekday rows, GitHub-style: Sun at top, only alternate rows labeled to keep
// the axis legible at 13px cells.
const WEEKDAY_ROWS = [
  { day: 0, label: "" },
  { day: 1, label: "Mon" },
  { day: 2, label: "" },
  { day: 3, label: "Wed" },
  { day: 4, label: "" },
  { day: 5, label: "Fri" },
  { day: 6, label: "" },
] as const;

function formatEventCount(count: number): string {
  return `${count.toLocaleString()} events`;
}

// Parse a YYYY-MM-DD key at noon UTC (avoids DST/offset edge cases shifting the
// weekday) and format for humans.
function parseDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function formatDayLabel(date: string): string {
  return parseDate(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function cellLevel(count: number, max: number): number {
  if (count <= 0) {
    return 0;
  }
  // Scale so a single contribution on a small-max chart still reads as the
  // lightest *active* step (1) rather than jumping to the middle of the ramp.
  const t = Math.log(count + 1) / Math.log(Math.max(max, 2) + 1);
  return Math.min(RAMP_LEVELS, 1 + Math.floor(t * (RAMP_LEVELS - 1)));
}

function levelStyle(level: number, accentVar: string) {
  if (level === 0) {
    return { backgroundColor: ACTIVITY_HEATMAP_EMPTY_LEVEL_COLOR };
  }
  return {
    backgroundColor: `color-mix(in oklch, var(${accentVar}) ${
      RAMP_ALPHA[level - 1]! * 100
    }%, transparent)`,
  };
}

type PositionedCell = { date: string; count: number };

// Index cells by (weekColumn, weekday) so the visual grid stays column-per-week
// while each ARIA row is a weekday. Uses the first cell's real weekday to offset
// a partial leading week, so index 0 of a Wednesday-started series lands under
// Wed, not Sun (the server range ends today and is not Sunday-aligned).
function buildGrid(weeks: AnalyticsHeatmapWeek[]): {
  columns: number;
  cellAt: Map<string, PositionedCell>;
  maxCount: number;
  monthLabels: Array<{ column: number; label: string }>;
} {
  const cellAt = new Map<string, PositionedCell>();
  const monthLabels: Array<{ column: number; label: string }> = [];
  let column = 0;
  let maxCount = 0;
  let lastMonth = "";

  for (const week of weeks) {
    const firstCell = week[0];
    if (!firstCell) {
      continue;
    }
    const startWeekday = parseDate(firstCell.date).getUTCDay();
    for (let i = 0; i < week.length; i++) {
      const cell = week[i]!;
      const weekday = (startWeekday + i) % DAYS_PER_WEEK;
      // A week whose cells span a Sunday boundary would wrap; the server groups
      // strictly Sun-started weeks, but guard anyway so a wrap opens a column.
      const wrapped = i > 0 && weekday === 0;
      if (wrapped) {
        column += 1;
      }
      cellAt.set(`${column}:${weekday}`, cell);
      maxCount = Math.max(maxCount, cell.count);
    }
    const month = parseDate(firstCell.date).toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    if (month !== lastMonth) {
      monthLabels.push({ column, label: month });
      lastMonth = month;
    }
    column += 1;
  }

  return { columns: column, cellAt, maxCount, monthLabels };
}

export function ActivityHeatmap({
  weeks,
  className,
  label = "Activity by day",
  valueFormatter = formatEventCount,
  accentVar = "--primary",
}: ActivityHeatmapProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const { columns, cellAt, maxCount, monthLabels } = buildGrid(weeks);
  const effectiveMax = Math.max(1, maxCount);

  // Roving tabindex: exactly one cell is in the page tab order; arrow keys move
  // focus within the grid. Without this a year is 365 tab stops. The first
  // populated cell is the initial tabbable one.
  let firstFocusableKey = "";
  for (let c = 0; c < columns && !firstFocusableKey; c++) {
    for (const { day } of WEEKDAY_ROWS) {
      if (cellAt.has(`${c}:${day}`)) {
        firstFocusableKey = `${c}:${day}`;
        break;
      }
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = arrowDelta(event.key);
    if (!delta) {
      return;
    }
    const active = globalThis.document.activeElement as HTMLElement | null;
    const col = Number(active?.dataset.col);
    const day = Number(active?.dataset.day);
    if (Number.isNaN(col) || Number.isNaN(day)) {
      return;
    }
    const next = nextFocusable(cellAt, columns, col, day, delta);
    if (next) {
      event.preventDefault();
      gridRef.current
        ?.querySelector<HTMLElement>(
          `[data-col="${next.col}"][data-day="${next.day}"]`
        )
        ?.focus();
    }
  };

  return (
    <TooltipProvider delayDuration={100}>
      <div className={cn("space-y-3", className)}>
        <div className="relative ml-8 h-4">
          {monthLabels.map((item) => (
            <span
              className="absolute text-muted-foreground text-xs"
              key={`${item.label}-${item.column}`}
              style={{ left: item.column * COLUMN_STRIDE }}
            >
              {item.label}
            </span>
          ))}
        </div>
        <span className="sr-only" id={labelId}>
          {label}
        </span>
        {/* Weekday-per-row grid: each ARIA row is a weekday and its cells are the
            weeks, matching how a year reads (7 weekday rows × ~53 week columns).
            Cells use a roving tabindex so the grid is one tab stop with arrow-key
            navigation, and each carries its value as an accessible name plus a
            hover/focus tooltip so pointer, keyboard, and screen-reader users all
            get the per-day readout. */}
        {/* biome-ignore lint/a11y/useSemanticElements: an activity grid is a composite grid widget, not a data <table> */}
        <div
          aria-labelledby={labelId}
          className="flex gap-2"
          onKeyDown={handleKeyDown}
          ref={gridRef}
          role="grid"
        >
          <div aria-hidden="true" className="flex flex-col gap-[3px]">
            {WEEKDAY_ROWS.map((row) => (
              <div
                className="flex items-center justify-end pr-1 text-muted-foreground text-xs"
                key={row.day}
                style={{ height: CELL_SIZE, width: 28 }}
              >
                {row.label}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-[3px]">
            {WEEKDAY_ROWS.map((row) => (
              <div className="flex gap-[3px]" key={row.day} role="row">
                {Array.from({ length: columns }, (_, columnIndex) => {
                  const key = `${columnIndex}:${row.day}`;
                  const cell = cellAt.get(key);
                  if (!cell) {
                    return (
                      <div
                        aria-hidden="true"
                        key={key}
                        style={{ width: CELL_SIZE, height: CELL_SIZE }}
                      />
                    );
                  }
                  const level = cellLevel(cell.count, effectiveMax);
                  const readout = `${formatDayLabel(cell.date)}: ${valueFormatter(
                    cell.count
                  )}`;
                  return (
                    <Tooltip key={key}>
                      <TooltipTrigger asChild>
                        <div
                          aria-label={readout}
                          className="rounded-[2px] border border-border/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
                          data-col={columnIndex}
                          data-day={row.day}
                          role="gridcell"
                          style={{
                            width: CELL_SIZE,
                            height: CELL_SIZE,
                            ...levelStyle(level, accentVar),
                          }}
                          tabIndex={key === firstFocusableKey ? 0 : -1}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">{readout}</p>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <span>Less</span>
          {Array.from({ length: RAMP_LEVELS + 1 }, (_, level) => (
            <div
              aria-hidden="true"
              className="rounded-[2px] border border-border/60"
              key={level}
              style={{
                width: CELL_SIZE,
                height: CELL_SIZE,
                ...levelStyle(level, accentVar),
              }}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </TooltipProvider>
  );
}

type Delta = { col: number; day: number };

function arrowDelta(key: string): Delta | null {
  switch (key) {
    case "ArrowRight":
      return { col: 1, day: 0 };
    case "ArrowLeft":
      return { col: -1, day: 0 };
    case "ArrowDown":
      return { col: 0, day: 1 };
    case "ArrowUp":
      return { col: 0, day: -1 };
    default:
      return null;
  }
}

// Step in the requested direction, skipping empty (padding) positions so arrow
// navigation only lands on real days.
function nextFocusable(
  cellAt: Map<string, PositionedCell>,
  columns: number,
  col: number,
  day: number,
  delta: Delta
): { col: number; day: number } | null {
  let nextCol = col + delta.col;
  let nextDay = day + delta.day;
  while (
    nextCol >= 0 &&
    nextCol < columns &&
    nextDay >= 0 &&
    nextDay < DAYS_PER_WEEK
  ) {
    if (cellAt.has(`${nextCol}:${nextDay}`)) {
      return { col: nextCol, day: nextDay };
    }
    nextCol += delta.col;
    nextDay += delta.day;
  }
  return null;
}
