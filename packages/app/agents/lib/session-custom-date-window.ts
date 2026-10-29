import { z } from "zod";
import { SESSION_DATE_RANGE_PARAM } from "./session-date-range-param";

/**
 * FEA-4201 — an EXPLICIT from/to window on the Sessions listing, as URL params.
 *
 * The listing's window is otherwise one of four rolling presets
 * (`?range=7d|30d|90d|all`, see {@link file://./session-date-range-param.ts}),
 * and a preset cannot name a single day. Every Insights drill-down the PRD asks
 * for — "clicking Jan 1 on Model Spend over Time lands on Sessions filtered to
 * that day" — needs both bounds, so the window has to be expressible as an
 * interval rather than a lookback.
 *
 * Bounds are UTC CALENDAR DAYS (`YYYY-MM-DD`), inclusive at both ends. That is
 * deliberately the same vocabulary the Insights producers already emit for a
 * chart datum (`TimeSeriesPoint.date`, `ActivityHeatmapCell.day`), so a
 * drill-down writes the datum's own field through unchanged: no reformatting, no
 * timezone re-interpretation between the bucket a user clicked and the window
 * they land on. It also matches the UTC-day quantization the preset window
 * already uses (`getStableUtcDateWindowForRange`), so both windows are stable
 * within a UTC day and hash to a stable query key.
 *
 * The params are OPTIONAL and independent of `?range=`: absent means the preset
 * decides, exactly as before, so every existing Sessions link keeps its
 * behaviour. Present-and-valid overrides the preset.
 */

/** Inclusive lower bound of the explicit window, a `YYYY-MM-DD` UTC day. */
export const SESSION_DATE_FROM_PARAM = "from";

/** Inclusive upper bound of the explicit window, a `YYYY-MM-DD` UTC day. */
export const SESSION_DATE_TO_PARAM = "to";

/**
 * Both explicit-window params, as one list.
 *
 * Every write that changes the Sessions window clears them TOGETHER — the range
 * picker, a new custom window, and Clear filters on either surface. A caller
 * that spells the pair out itself is one edit away from clearing only half of
 * it, which parses back to a half-window and silently leaves the listing
 * narrowed with nothing on screen explaining why.
 */
export const SESSION_CUSTOM_WINDOW_PARAMS = [
  SESSION_DATE_FROM_PARAM,
  SESSION_DATE_TO_PARAM,
] as const;

/**
 * FEA-4201 — every window param the URL owns rather than the saved view: the
 * ISS-5355 rolling preset (`?range=`) and the explicit interval
 * (`?from=`/`?to=`).
 *
 * Every write that changes the window clears all three TOGETHER. They are three
 * spellings of ONE decision, so leaving any of them behind lets an inbound link
 * keep deciding the rows after the user has picked something else.
 *
 * Lives HERE, beside the params it unions, rather than in either shell: this set
 * is the whole reason the two Sessions surfaces can resolve one URL to one
 * window, and a shell-local copy is precisely how they come to disagree. Desktop
 * does not itself READ `?range=`, which is what makes its copy so easy to get
 * wrong — a stale `range=90d` it declines to strip costs it nothing locally and
 * still narrows the listing for whoever opens the link on web.
 */
export const SESSION_URL_OWNED_WINDOW_PARAMS = [
  SESSION_DATE_RANGE_PARAM,
  ...SESSION_CUSTOM_WINDOW_PARAMS,
] as const;

/**
 * Widest window the params may express, in inclusive days. A span past this is
 * REJECTED, not narrowed — see {@link parseSessionCustomDateWindowParams}.
 *
 * These arrive from a URL — a hand-edited link, a stale bookmark, a crawler —
 * so the span is untrusted and unbounded input to a range scan. A year covers
 * every window the presets offer (the widest bounded preset is 90d) with room
 * for a genuine annual review, and caps what one link can ask the row scan for.
 */
export const MAX_SESSION_CUSTOM_WINDOW_DAYS = 366;

/** An explicit, inclusive Sessions window as two UTC calendar days. */
export type SessionCustomDateWindow = {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  to: string;
};

const MS_PER_DAY = 86_400_000;

const CALENDAR_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` UTC calendar day that actually exists.
 *
 * The shape check alone is not enough: `Date.parse` accepts `2026-02-30` and
 * rolls it forward to March 2, so a malformed day would silently become a
 * DIFFERENT window rather than being rejected. Re-serializing the parsed instant
 * and requiring it to equal the input is what rejects the roll-over.
 */
const calendarDaySchema = z
  .string()
  .regex(CALENDAR_DAY_PATTERN)
  .refine((value) => toUtcDayStartMs(value) !== null, "Not a calendar day");

const customDateWindowSchema = z.object({
  from: calendarDaySchema,
  to: calendarDaySchema,
});

/**
 * The explicit window carried by `?from=`/`?to=`, or `null` when the URL does
 * not describe one.
 *
 * `null` — "the preset decides" — is the answer for EVERY input that is not an
 * unambiguous, IN-BOUNDS window, because an inbound link must never be able to
 * narrow the listing in a way the reader cannot account for:
 *  - either param missing: one bound is a lookback, not an interval, and which
 *    end is open would have to be invented.
 *  - either param malformed or not a real calendar day.
 *  - `to` before `from`: an inverted range has no rows. Swapping the bounds
 *    would invent an intent the URL did not express.
 *  - a span wider than {@link MAX_SESSION_CUSTOM_WINDOW_DAYS}.
 *
 * That last one was a silent forward CLAMP until review. Narrowing `from` and
 * returning an ordinary window made a repaired request indistinguishable from an
 * exact one: the control stated the clamped days with full confidence, the
 * address bar still carried what was asked for, and nothing on screen reconciled
 * the two. Falling back to the preset is the same visible degradation every
 * other rejected input already gets, and the lit preset pill then says which
 * window is in charge.
 */
export function parseSessionCustomDateWindowParams(
  params: Pick<URLSearchParams, "get">
): SessionCustomDateWindow | null {
  const parsed = customDateWindowSchema.safeParse({
    from: params.get(SESSION_DATE_FROM_PARAM) ?? undefined,
    to: params.get(SESSION_DATE_TO_PARAM) ?? undefined,
  });
  if (!parsed.success) {
    return null;
  }
  return acceptSessionCustomDateWindow(parsed.data);
}

/**
 * The window as the `{ startDate, endDate }` ISO instants the sessions query
 * contract takes — inclusive of the whole `from` day and the whole `to` day.
 *
 * The upper bound is the last millisecond of `to` rather than its midnight:
 * `lastActivityAt <= endDate` against `to`'s midnight would return only sessions
 * that happened to be active at exactly 00:00:00.000 UTC, so a single-day
 * drill-down would come back empty on a day that has rows.
 */
export function sessionCustomDateWindowBounds(
  window: SessionCustomDateWindow
): {
  startDate: string;
  endDate: string;
} {
  return {
    startDate: `${window.from}T00:00:00.000Z`,
    endDate: `${window.to}T23:59:59.999Z`,
  };
}

/**
 * Writes the explicit window into `params`, or deletes both params when the
 * window is `null` so a listing back on its preset keeps a clean URL.
 *
 * Both params are always written or deleted TOGETHER: a half-written window
 * parses back to `null`, which would silently drop the caller's filter.
 */
export function writeSessionCustomDateWindowParams(
  params: URLSearchParams,
  window: SessionCustomDateWindow | null
): void {
  if (window === null) {
    params.delete(SESSION_DATE_FROM_PARAM);
    params.delete(SESSION_DATE_TO_PARAM);
    return;
  }
  params.set(SESSION_DATE_FROM_PARAM, window.from);
  params.set(SESSION_DATE_TO_PARAM, window.to);
}

/**
 * The window's inclusive day count, or `undefined` when a preset is in charge.
 *
 * Exists so a caption can name the period the figures beside it were actually
 * compared over. A preset caption read while an explicit window decides the rows
 * names a period nothing was computed over.
 */
export function sessionCustomDateWindowDays(
  window: SessionCustomDateWindow | null
): number | undefined {
  if (window === null) {
    return undefined;
  }
  const fromMs = toUtcDayStartMs(window.from);
  const toMs = toUtcDayStartMs(window.to);
  if (fromMs === null || toMs === null) {
    return undefined;
  }
  return Math.round((toMs - fromMs) / MS_PER_DAY) + 1;
}

/**
 * The window the Sessions listing actually reads over: the explicit one when the
 * URL carries a valid pair, otherwise the rolling preset.
 *
 * The precedence lives HERE, in one named seam both shells call, rather than in
 * each shell's own conditional — the two listings must never resolve the same
 * URL to two different windows, and a per-shell `??` is exactly how that drifts.
 * It mirrors `useSessionsEffectiveDateRange`: an inbound link's window wins over
 * the viewer's ambient preference for as long as it is in the URL.
 */
export function resolveSessionDateWindow(
  customWindow: SessionCustomDateWindow | null,
  presetWindow: { startDate?: string; endDate?: string }
): { startDate?: string; endDate?: string } {
  if (customWindow === null) {
    return presetWindow;
  }
  return sessionCustomDateWindowBounds(customWindow);
}

/**
 * "Jan 1, 2026" / "Jan 1 - Jan 8, 2026" / "Dec 28, 2025 - Jan 3, 2026" for a
 * readout or a button label.
 *
 * The year is stated ONCE when both ends share it. This label lives on a control
 * inside a wrapping toolbar run, so the repeated year is ~6 characters that push
 * the sibling Filter and View controls onto a second line for no information.
 */
export function formatSessionCustomDateWindow(
  window: SessionCustomDateWindow
): string {
  const to = formatCalendarDay(window.to);
  if (window.from === window.to) {
    return to;
  }
  const sharesYear = window.from.slice(0, 4) === window.to.slice(0, 4);
  const from = sharesYear
    ? MONTH_DAY_FORMATTER.format(new Date(`${window.from}T00:00:00.000Z`))
    : formatCalendarDay(window.from);
  return `${from} - ${to}`;
}

/**
 * The day a calendar control means by a `Date`, as `YYYY-MM-DD`.
 *
 * A date picker hands back local midnight for the cell the user clicked, so
 * `toISOString()` on it names the PREVIOUS day for every viewer east of UTC —
 * click "Jan 1" in Tokyo and the window silently becomes Dec 31. Reading the
 * local Y/M/D fields keeps the string equal to the cell the user actually
 * pressed, which is the only day they can hold this window to.
 */
export function fromLocalCalendarDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Inverse of {@link fromLocalCalendarDate}, for seeding a calendar control. */
export function toLocalCalendarDate(day: string): Date | undefined {
  const parts = day.split("-").map(Number);
  const [year, month, date] = parts;
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  return new Date(year, month - 1, date);
}

/**
 * Midnight-UTC epoch ms for a `YYYY-MM-DD` day, or `null` when the string is not
 * a real calendar day (see {@link calendarDaySchema}).
 */
function toUtcDayStartMs(day: string): number | null {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString().startsWith(day) ? parsed : null;
}

/**
 * The window itself when the contract accepts it, `null` when it does not —
 * inverted `to`/`from`, or a span past
 * {@link MAX_SESSION_CUSTOM_WINDOW_DAYS}.
 *
 * Exported so a PICKER can ask the same question the URL parser asks. A control
 * that re-derived the limit — comparing its own day count against the constant —
 * would be a second copy of the acceptance rule, free to drift from the one that
 * decides whether the params survive the next render. When they drift the
 * failure is silent in the worst direction: the control writes a pair it
 * believes in, {@link parseSessionCustomDateWindowParams} throws it away, and the
 * listing falls back to the preset with nothing on screen saying why.
 */
export function acceptSessionCustomDateWindow(
  window: SessionCustomDateWindow
): SessionCustomDateWindow | null {
  const fromMs = toUtcDayStartMs(window.from);
  const toMs = toUtcDayStartMs(window.to);
  if (fromMs === null || toMs === null || toMs < fromMs) {
    return null;
  }
  const spanDays = Math.round((toMs - fromMs) / MS_PER_DAY) + 1;
  return spanDays <= MAX_SESSION_CUSTOM_WINDOW_DAYS ? window : null;
}

/** The same day without its year, for the lower bound of a same-year window. */
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const CALENDAR_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function formatCalendarDay(day: string): string {
  const ms = toUtcDayStartMs(day);
  return ms === null ? day : CALENDAR_DAY_FORMATTER.format(new Date(ms));
}
