import type { ActivityHeatmap } from "@repo/api/src/types/insights";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { BotIcon, LayersIcon, UserIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Fragment, useMemo, useState } from "react";
import { SectionHeader } from "./section-header";

type Mode = "both" | "agent" | "human";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const CELL = 13;
const GAP = 2;

// Deliberate, semantic 3-way palette — intentionally NOT the prototype's single
// purple scale. The dashboard adds a Both/Agent/Human toggle, so each population
// gets its own hue: Human = emerald (interactive), Agent = violet (autonomous),
// Both = indigo (the aggregate). 5 density steps, index 0 = near-background
// "empty", tuned for the light theme — light → saturated as density climbs.
const LIGHT_PALETTE: Record<Mode, [string, string, string, string, string]> = {
  both: ["#eef0fb", "#c7cdf6", "#a5adf0", "#818ce8", "#5b63d6"],
  human: ["#eafaf3", "#b6ecd3", "#7fdcb4", "#42c98e", "#16a36a"],
  agent: ["#f3f0fd", "#d9cffb", "#bfa9f6", "#a07cef", "#7c4fe0"],
};

// Dark-theme palette is inverted: against a dark background the ramp runs dark →
// light, so the low-density ("Less") steps stay close to the background and the
// high-density ("More") steps glow. Same three hues as the light palette.
const DARK_PALETTE: Record<Mode, [string, string, string, string, string]> = {
  both: ["#23264d", "#3a4086", "#5159c0", "#7e88ec", "#b9c0f7"],
  human: ["#10322a", "#155f43", "#1f9468", "#3fd08f", "#9aedc6"],
  agent: ["#2a1f4d", "#46318a", "#6a4cc6", "#9a7cef", "#cdb8f8"],
};

const MODES: { key: Mode; label: string; Icon: typeof LayersIcon }[] = [
  { key: "both", label: "Both", Icon: LayersIcon },
  { key: "agent", label: "Agent", Icon: BotIcon },
  { key: "human", label: "Human", Icon: UserIcon },
];

function cellValue(
  cell: { human: number; agent: number } | undefined,
  mode: Mode
): number {
  if (!cell) {
    return 0;
  }
  if (mode === "human") {
    return cell.human;
  }
  if (mode === "agent") {
    return cell.agent;
  }
  return cell.human + cell.agent;
}

function level(value: number, max: number): number {
  if (value <= 0) {
    return 0;
  }
  const t = Math.log(value + 1) / Math.log(Math.max(max, 1) + 1);
  return Math.min(4, 1 + Math.floor(t * 4));
}

function formatDay(day: string): string {
  const parts = day.split("-");
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : day;
}

/**
 * Hour-of-day (rows, 24h) × day (columns) event-density heatmap for the
 * overview dashboard, with a Both/Agent/Human toggle. "Human" = interactive
 * sessions (submitted a user prompt); "Agent" = headless/`-p` / spawned runs.
 * Data comes from the Utilization insights (`charts.activityHeatmap`); renders a
 * graceful empty state without it.
 */
export function EventActivityHeatmap({
  heatmap,
  periodLabel = "Last 90 days",
}: {
  heatmap: ActivityHeatmap | undefined;
  periodLabel?: string;
}) {
  const [mode, setMode] = useState<Mode>("both");
  const { resolvedTheme } = useTheme();

  const { byKey, max } = useMemo(() => {
    const map = new Map<string, { human: number; agent: number }>();
    let peak = 0;
    for (const cell of heatmap?.cells ?? []) {
      map.set(`${cell.day}:${cell.hour}`, {
        human: cell.human,
        agent: cell.agent,
      });
      peak = Math.max(peak, cellValue(cell, mode));
    }
    return { byKey: map, max: peak };
  }, [heatmap, mode]);

  const days = heatmap?.days ?? [];
  const palette = (resolvedTheme === "dark" ? DARK_PALETTE : LIGHT_PALETTE)[
    mode
  ];

  return (
    <div className="flex flex-col">
      <SectionHeader
        actions={
          <ToggleGroup
            onValueChange={(next) => {
              if (next) {
                setMode(next as Mode);
              }
            }}
            type="single"
            value={mode}
            variant="outline"
          >
            {MODES.map(({ key, label, Icon }) => (
              <ToggleGroupItem aria-label={label} key={key} value={key}>
                <Icon className="size-3.5" />
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
        description={`${periodLabel} · hourly event density`}
        title="Event Activity"
      />

      {days.length === 0 ? (
        <div className="grid min-h-[240px] place-items-center text-[var(--muted-foreground)] text-sm">
          No activity in range yet
        </div>
      ) : (
        // The grid scales to fill the card width (day columns flex), so the
        // whole 90×24 heatmap fits with no scrolling.
        <div>
          <div
            className="text-[10px] text-[var(--muted-foreground)]"
            style={{
              display: "grid",
              gridTemplateColumns: `auto repeat(${days.length}, minmax(0, 1fr))`,
              gap: GAP,
              width: "100%",
            }}
          >
            {HOURS.map((hour) => (
              <Fragment key={hour}>
                <div
                  className="pr-2 text-right tabular-nums leading-none"
                  style={{ height: CELL, lineHeight: `${CELL}px` }}
                >
                  {hour % 3 === 0 ? `${String(hour).padStart(2, "0")}:00` : ""}
                </div>
                {days.map((day) => {
                  const value = cellValue(byKey.get(`${day}:${hour}`), mode);
                  return (
                    <div
                      key={`${day}:${hour}`}
                      style={{
                        height: CELL,
                        borderRadius: 2,
                        background: palette[level(value, max)],
                      }}
                      title={`${day} ${String(hour).padStart(2, "0")}:00 · ${value} events`}
                    />
                  );
                })}
              </Fragment>
            ))}
            {/* day axis labels (~weekly) */}
            <div />
            {days.map((day, index) => (
              <div
                className="overflow-visible whitespace-nowrap pt-1 leading-none"
                key={`label:${day}`}
              >
                {index % 7 === 0 ? formatDay(day) : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-3 text-[11px] text-[var(--muted-foreground)]">
        Less
        {palette.map((color) => (
          <span
            key={color}
            style={{
              width: CELL,
              height: CELL,
              borderRadius: 2,
              background: color,
              display: "inline-block",
            }}
          />
        ))}
        More
      </div>
    </div>
  );
}
