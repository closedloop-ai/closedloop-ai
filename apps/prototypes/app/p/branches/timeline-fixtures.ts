import type { TimelineColumn } from "./mock";

type TimelineSegments = TimelineColumn["segments"];
type TimelineTokens = TimelineColumn["tokens"];

/** Create an active timeline column from explicit token telemetry. */
export function timelineColumn(
  tokens: TimelineTokens,
  segments: TimelineSegments
): TimelineColumn {
  return { segments, tokens };
}

/** Create a timeline interval with no recorded session activity. */
export function idleTimelineColumn(): TimelineColumn {
  return {
    idle: true,
    segments: [],
    tokens: { input: 0, output: 0, cacheRead: 0 },
  };
}

/** Sum the fixture's actual token categories for display and bar sizing. */
export function timelineTokenTotal(column: TimelineColumn): number {
  return column.tokens.input + column.tokens.output + column.tokens.cacheRead;
}

/** Scale one timeline column against the largest token total in its timeline. */
export function timelineColumnHeightPct(
  column: TimelineColumn,
  maxTokens: number
): number {
  if (column.idle || maxTokens <= 0) {
    return 0;
  }
  return (timelineTokenTotal(column) / maxTokens) * 100;
}
