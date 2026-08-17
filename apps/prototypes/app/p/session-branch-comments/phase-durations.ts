import type { CostSegment, WaterfallSeg } from "./mock";

const HOURS_PATTERN = /(\d+)h/;
const MINUTES_PATTERN = /(\d+)m/;

/** Derive phase legend durations from the waterfall's wall-clock shares. */
export function alignPhaseDurations(
  costSegments: readonly CostSegment[],
  waterfall: readonly WaterfallSeg[],
  wallClockLabel: string
): CostSegment[] {
  const totalMinutes = parseDurationMinutes(wallClockLabel);
  const phasePct = new Map<string, number>();

  for (const segment of waterfall) {
    if (segment.type === "idle") {
      continue;
    }
    phasePct.set(segment.type, (phasePct.get(segment.type) ?? 0) + segment.pct);
  }

  return costSegments.map((segment) => ({
    ...segment,
    duration: formatDuration(
      Math.round((totalMinutes * (phasePct.get(segment.key) ?? 0)) / 100)
    ),
  }));
}

function parseDurationMinutes(label: string): number {
  const hours = Number(HOURS_PATTERN.exec(label)?.[1] ?? 0);
  const minutes = Number(MINUTES_PATTERN.exec(label)?.[1] ?? 0);
  return hours * 60 + minutes;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0
    ? `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`
    : `${remainingMinutes}m`;
}
