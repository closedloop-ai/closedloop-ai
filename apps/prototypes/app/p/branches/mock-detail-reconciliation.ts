import type { TimelineColumn } from "./mock";
import type { BranchScenario } from "./mock-detail";
import { idleTimelineColumn } from "./timeline-fixtures";

/** Keeps a Detail scenario's lanes, legend, bars, and event anchors aligned. */
export function reconcileBranchScenario(
  scenario: BranchScenario,
  requestedSessionCount: number
) {
  const count = Math.max(
    0,
    Math.min(requestedSessionCount, scenario.sessions.length)
  );
  const sessions = scenario.sessions.slice(0, count);
  const colorSet = new Set(sessions.map((session) => session.color));
  const legend = sessions.map((session) => ({
    actorId: session.actorId,
    name: session.actor,
    color: session.color,
  }));
  const columns: TimelineColumn[] = scenario.timelineColumns.map((column) => {
    if (column.idle) {
      return column;
    }
    const segments = column.segments.filter((segment) =>
      colorSet.has(segment.color)
    );
    const visiblePct = segments.reduce(
      (total, segment) => total + segment.pct,
      0
    );
    if (segments.length === 0) {
      return idleTimelineColumn();
    }
    return {
      ...column,
      segments: segments.map((segment) => ({
        ...segment,
        pct: (segment.pct / visiblePct) * 100,
      })),
    };
  });
  const eventDots = scenario.eventDots.filter((event) => {
    const columnIndex = Math.min(
      Math.floor((event.leftPct / 100) * columns.length),
      columns.length - 1
    );
    return columns[columnIndex]?.idle !== true;
  });
  return {
    columns,
    eventDots,
    legend,
    sessions,
    trace: scenario.trace,
  };
}
