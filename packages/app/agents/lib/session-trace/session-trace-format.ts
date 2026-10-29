/**
 * @file session-trace-format.ts
 * @description Display formatters for the session Trace tab.
 *
 * Durations step units rather than running minutes past legibility, because
 * "3180m 0s" for 53 hours is a real defect this repo has already shipped and
 * fixed once (ISS-6958).
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const TENTHS_PER_SECOND = 10;
const MS_PER_TENTH = MS_PER_SECOND / TENTHS_PER_SECOND;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const TENTHS_PER_MINUTE = SECONDS_PER_MINUTE * TENTHS_PER_SECOND;

/**
 * Compact elapsed span: `42ms`, `1.4s`, `2m 6s`, `1h 12m`.
 *
 * WHICH UNIT IS CHOSEN IS DECIDED BY THE ROUNDED VALUE, NOT THE RAW ONE.
 * Flooring the higher unit and rounding the lower one independently prints a
 * pair the clock cannot hold: 179,600 ms floors to 2 minutes and rounds to 60
 * seconds, so it reads `2m 60s`. Each branch below rounds to the unit it is
 * about to PRINT and hands the carry to the next unit up, so a value that
 * rounds past its own ceiling is promoted rather than printed impossibly.
 */
export function formatSessionTraceDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const wholeMs = Math.round(ms);
  if (wholeMs < MS_PER_SECOND) {
    return `${wholeMs}ms`;
  }
  const tenths = Math.round(ms / MS_PER_TENTH);
  if (tenths < TENTHS_PER_MINUTE) {
    return `${(tenths / TENTHS_PER_SECOND).toFixed(1)}s`;
  }
  const wholeSeconds = Math.round(ms / MS_PER_SECOND);
  if (wholeSeconds < SECONDS_PER_HOUR) {
    return `${Math.floor(wholeSeconds / SECONDS_PER_MINUTE)}m ${wholeSeconds % SECONDS_PER_MINUTE}s`;
  }
  // Truncated, not rounded, because `formatDuration` in the Sessions table
  // (`packages/app/agents/components/sessions/web-master-legacy-preview/mock.ts`) truncates and the reader walks from that table
  // into this tab. Rounding here rendered the traced session's 3,718,003 ms as
  // "1h 2m" beside the row's "1h 1m" — one session, two durations, which is the
  // exact disagreement one shared fixture exists to make impossible. The carry
  // out of the seconds branch above is still honoured, so a span that rounded
  // up to a whole hour is not truncated back to `0h 59m`.
  const carriedMs = Math.max(ms, wholeSeconds * MS_PER_SECOND);
  const hours = Math.floor(carriedMs / MS_PER_HOUR);
  const minutes = Math.floor((carriedMs % MS_PER_HOUR) / MS_PER_MINUTE);
  return `${hours}h ${minutes}m`;
}

/** Thousands-separated integer, or an em dash when there is no value. */
export function formatSessionTraceCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return value.toLocaleString("en-US");
}

/**
 * Turn spend. Sub-cent values keep four places so a $0.0402 skill does not
 * render as "$0.04" beside a $0.0512 one and lose the comparison.
 */
export function formatSessionTraceCost(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** `ag-2 · from ag-1`, or just the agent when it has no recorded parent. */
export function formatSessionTraceAgentLineage(
  agentId: string | undefined,
  parentAgentId: string | undefined
): string {
  if (agentId === undefined) {
    return "—";
  }
  if (parentAgentId === undefined) {
    return agentId;
  }
  return `${agentId} · from ${parentAgentId}`;
}
