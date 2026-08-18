import type { SharedBranchesQuery } from "../../shared/shared-branches-contract.js";

/** Parse a window bound to epoch ms; absent or unparseable means not applied. */
export function parseWindowBoundMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Keep only events whose own persisted timestamp is provably in the window. */
export function filterEventRowsByEventWindow<
  Row extends { createdAt: string | null },
>(rows: Row[], request: SharedBranchesQuery): Row[] {
  const startMs = parseWindowBoundMs(request.startDate);
  const endMs = parseWindowBoundMs(request.endDate);
  if (startMs === null && endMs === null) {
    return rows;
  }
  return rows.filter((row) => eventIsInWindow(row.createdAt, startMs, endMs));
}

/** Whether a valid date bound requires per-event rather than lifetime spend. */
export function isDateWindowActive(request: SharedBranchesQuery): boolean {
  return (
    parseWindowBoundMs(request.startDate) !== null ||
    parseWindowBoundMs(request.endDate) !== null
  );
}

function eventIsInWindow(
  createdAt: string | null,
  startMs: number | null,
  endMs: number | null
): boolean {
  if (!createdAt) {
    return false;
  }
  const eventMs = Date.parse(createdAt);
  if (Number.isNaN(eventMs)) {
    return false;
  }
  if (startMs !== null && eventMs < startMs) {
    return false;
  }
  return endMs === null || eventMs <= endMs;
}
