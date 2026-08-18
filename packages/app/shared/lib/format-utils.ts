/**
 * Shared formatting utilities for loops UI.
 */

const B = 1_000_000_000;
const M = 1_000_000;
const K = 1000;

/**
 * Format a token count for display with abbreviated tiers (k, M, B).
 * Uses 2 decimal places for abbreviated output.
 * Tiers up at 4 whole figures (e.g., 1232M → 1.23B).
 * Tiers down when value is less than 1 of current tier (e.g., 0.5M → 500k).
 */
export function formatTokenCount(count: number): string {
  if (count >= B) {
    return `${(count / B).toFixed(2)}B`;
  }
  if (count >= M) {
    const divided = count / M;
    if (divided >= 999.995) {
      return `${(count / B).toFixed(2)}B`;
    }
    return `${divided.toFixed(2)}M`;
  }
  if (count >= K) {
    const divided = count / K;
    if (divided >= 999.995) {
      return `${(count / M).toFixed(2)}M`;
    }
    return `${divided.toFixed(2)}k`;
  }
  return count.toString();
}

/**
 * Format elapsed time between two instants as "Xh Ym", "Xm Ys", or "Ys".
 * Accepts Date objects or ISO strings so both the web (Date) and desktop (ISO)
 * session tables can share one implementation.
 * If startedAt is null, returns "-".
 * If completedAt is null (e.g. a still-running session), measures against
 * Date.now() so the duration reflects live elapsed time rather than freezing.
 * Unparseable inputs return "-"; clock skew (end before start) clamps to "0s".
 *
 * NOTE for session "Duration": do not call this directly with a session's raw
 * timestamps. Resolve the window first via `resolveSessionDurationWindow` (in
 * `agents/lib/session-duration.ts`) and format through
 * `resolveSessionWallClockLabel`, so every Duration surface measures the same
 * span and a finished session is never measured against Date.now() — see
 * ISS-5131.
 */
export function formatDuration(
  startedAt: Date | string | null,
  completedAt: Date | string | null
): string {
  if (!startedAt) {
    return "-";
  }
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Total elapsed time between two instants expressed as a whole-minute chart
 * scale: the duration rounded UP to the next full minute. Used as the upper
 * bound of the session timeline's time axis so the scale always covers the
 * whole session.
 *
 * Examples: 5m 5s → 6, 75m 1s → 76, an exact 5m 0s → 5 (no extra minute).
 *
 * Mirrors formatDuration's input handling: accepts Date objects or ISO
 * strings, treats a null completedAt as a still-running session measured
 * against Date.now(), and clamps clock skew (end before start) to zero.
 * Always returns at least 1 — a sub-minute or zero-length session still gets
 * a 1-minute scale. Unparseable inputs return 1.
 */
export function getDurationScaleMinutes(
  startedAt: Date | string | null,
  completedAt: Date | string | null
): number {
  if (!startedAt) {
    return 1;
  }
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 1;
  }

  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  return Math.max(1, Math.ceil(totalSeconds / 60));
}

/**
 * Build URLSearchParams from a filters object, skipping null/undefined values.
 * Array values are serialized as repeated params (`?k=a&k=b`) — empty arrays are
 * skipped — so multi-select facets round-trip through the server's repeated-param
 * parsing.
 */
export function buildSearchParams(
  filters: Record<string, unknown>
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null) {
          params.append(key, String(entry));
        }
      }
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

export const DATE_RANGES = ["7d", "30d", "90d", "all"] as const;

export type DateRange = (typeof DATE_RANGES)[number];

/**
 * The default rolling window for the shared date-range control (FEA-4181 moved
 * it here from `useSharedDateRange` so the honest empty state can tell a
 * non-default window — a filter that is narrowing the list — from the default
 * without importing the zod-backed hook module into a bundle-sensitive surface).
 */
export const DEFAULT_DATE_RANGE: DateRange = "90d";

export const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** Compact labels for the inline time-window segmented control. */
export const DATE_RANGE_SHORT_LABELS: Record<DateRange, string> = {
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All",
};

export function parseDateRange(value: string | null): DateRange {
  if (value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "30d";
}

/**
 * The inclusive lower bound (ISO timestamp) for a rolling day window, or
 * `undefined` for an unbounded ("all") window (`days === undefined`). `now` is
 * injectable so callers/tests get deterministic output. Shared by every
 * time-window selector's start-date helper (`getStartDateForRange`,
 * `getAgentsRangeStartIso`, …) so the day-subtraction lives in one place; each
 * selector keeps its own range→days map local.
 */
export function getStartIsoForDays(
  days: number | undefined,
  now: Date = new Date()
): string | undefined {
  if (days === undefined) {
    return undefined;
  }
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

/**
 * FEA-3722: the single 7/30/90 day mapping for the bounded date ranges, read by
 * both `getStartDateForRange` (as a start-date string) and
 * `dateRangeToLookbackDays` (as a raw day count) so the numbers live in one place.
 */
const DATE_RANGE_DAYS: Record<Exclude<DateRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export function getStartDateForRange(
  range: DateRange,
  now: Date = new Date()
): string | undefined {
  return getStartIsoForDays(
    range === "all" ? undefined : DATE_RANGE_DAYS[range],
    now
  );
}

/** Return both bounds from one clock read so calendar-day windows survive DST. */
export function getDateWindowForRange(
  range: DateRange,
  now: Date = new Date()
): { startDate?: string; endDate?: string } {
  const startDate = getStartDateForRange(range, now);
  return startDate ? { startDate, endDate: now.toISOString() } : {};
}

/**
 * Return the inclusive N-day UTC window ending with the CURRENT UTC day.
 *
 * Its serialized bounds remain stable throughout a UTC calendar day, so
 * query-key consumers do not rely on component memo lifetime to stabilize
 * millisecond clock reads, and adjacent windows stay equal-width. The existing
 * rolling helpers remain instant-relative.
 *
 * ISS-5809: this window used to END at yesterday 23:59:59.999, excluding the
 * in-progress UTC day. That is the right shape for a period-over-period
 * COMPARISON (ISS-5264's rationale) but the wrong one for the row lists and
 * summary cards that consume it: a session active today failed the resulting
 * `lastActivityAt <= endDate` predicate and never reached the Sessions or
 * Branches list at all, so the newest visible row was whatever happened just
 * before UTC midnight and its relative timestamp grew through the day. The
 * window now ends with today.
 *
 * The comparison's like-for-like guarantee did not move here — it moved to the
 * producers, which derive the prior window from whatever bounds they are given
 * (`resolvePriorUsageWindow` for the Sessions cards,
 * `buildAdjacentBranchMetricWindows` for the Branches ones).
 *
 * Equal WIDTH is not the guarantee, and the first review of ISS-5809 caught this
 * file claiming it was. The current period is now partial by design — today is
 * still in progress, which is inherent to any window that shows current work — so
 * grading it against a COMPLETE prior period of the same nominal width reports the
 * time of day as a trend: a steady org reads ≈ -14% on a 7d range just after UTC
 * midnight and recovers to 0% by the next one. The producers therefore truncate
 * the PRIOR window to the span the current one has actually ELAPSED, so the two
 * populations cover equal elapsed time. A window already fully in the past is
 * unaffected, its elapsed span being its width.
 */
export function getStableUtcDateWindowForRange(
  range: DateRange,
  now: Date = new Date()
): { startDate?: string; endDate?: string } {
  if (range === "all") {
    return {};
  }
  const endDate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
  const startDate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - DATE_RANGE_DAYS[range] + 1
    )
  );
  return { startDate: startDate.toISOString(), endDate: endDate.toISOString() };
}

/**
 * FEA-3722: the rolling-window size (in days) for a date range, or `null` for
 * the unbounded "all" range. The same 7/30/90 mapping as `getStartDateForRange`,
 * exposed as a day count for callers (e.g. the desktop Coding Wrap) that thread
 * the window through an analytics query rather than a start-date string.
 */
export function dateRangeToLookbackDays(range: DateRange): number | null {
  return range === "all" ? null : DATE_RANGE_DAYS[range];
}

export function formatCost(cost: number | undefined): string {
  return `$${(cost ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How many extra decimals `formatCostPrecise` may add before it stops widening
 *  precision. Past this, more digits are noise rather than signal. */
const PRECISE_COST_MAX_FRACTION_DIGITS = 4;

/** The smallest magnitude `PRECISE_COST_MAX_FRACTION_DIGITS` can render as a
 *  nonzero figure ($0.0001). */
const PRECISE_COST_SMALLEST_UNIT = 10 ** -PRECISE_COST_MAX_FRACTION_DIGITS;

/** Below HALF the smallest unit, 4dp rounding lands on zero and the formatter
 *  has no figure left to show. AT half it rounds up to a real `$0.0001`, so the
 *  boundary is the rounding boundary — not the unit — or the bound would swallow
 *  values that still render faithfully. */
const PRECISE_COST_ZERO_ROUNDING_FLOOR = PRECISE_COST_SMALLEST_UNIT / 2;

/**
 * ISS-4919: what a real, nonzero cost too small for
 * {@link PRECISE_COST_SMALLEST_UNIT} renders as.
 *
 * Widening precision (FEA-3722) removed the `$0.00` lie for the sub-cent band
 * but not for the band beneath it: at 4dp a genuine $0.00001 still rounded to a
 * flat `$0.00`, which a reader cannot tell apart from "this cost nothing". Past
 * the last digit the formatter has, the honest statement is no longer a figure
 * — it is a BOUND. So the sub-floor band commits to the same "less than" form
 * the LOC/$ column already uses for exactly this reason (ISS-4866,
 * {@link LOC_PER_DOLLAR_COLUMN_BELOW_FLOOR}), rather than inventing a second
 * convention for the same fact.
 *
 * "Smaller than we can show" and "zero" stay different strings, which is the
 * whole point: an exact zero still renders `$0.00`, so the two never collide.
 */
export const PRECISE_COST_BELOW_FLOOR = `< $${PRECISE_COST_SMALLEST_UNIT.toFixed(
  PRECISE_COST_MAX_FRACTION_DIGITS
)}`;

/** Mirror of {@link PRECISE_COST_BELOW_FLOOR} for a negative magnitude, so a
 *  credit/refund below the floor reads as the bound it is rather than borrowing
 *  the positive form's sign. */
export const PRECISE_COST_ABOVE_NEGATIVE_FLOOR = `> -$${PRECISE_COST_SMALLEST_UNIT.toFixed(
  PRECISE_COST_MAX_FRACTION_DIGITS
)}`;

/**
 * Cost formatter for FINE-GRAINED figures that can legitimately fall below one
 * cent (e.g. a single hour's slice of a session's spend in the branch activity
 * timeline). Fixed-2dp `formatCost` renders any nonzero value under $0.005 as a
 * flat "$0.00", which — next to a bar that is visibly drawn and colored — reads
 * as a broken/lying UI. This widens `maximumFractionDigits` just enough that a
 * nonzero value shows a nonzero figure (up to 4dp, e.g. `$0.0037`), so the
 * number on screen matches the segment that's actually drawn. Values of a cent
 * or more (and exact/undefined zero) render identically to `formatCost` — the
 * extra precision only kicks in for the sub-cent case that would otherwise lie.
 *
 * ISS-4919: below the last digit this formatter has
 * ({@link PRECISE_COST_SMALLEST_UNIT}) even 4dp rounds a real cost back to
 * `$0.00`, so that band renders the {@link PRECISE_COST_BELOW_FLOOR} bound
 * instead. The guarantee callers can rely on: **a nonzero cost never renders as
 * an exact zero.**
 */
export function formatCostPrecise(cost: number | undefined): string {
  const value = cost ?? 0;
  const abs = Math.abs(value);
  // A cent or more (or exact zero) is already faithful at 2dp.
  if (abs === 0 || abs >= 0.01) {
    return formatCost(value);
  }
  // Once 4dp rounding lands on zero, no figure is faithful — state the bound
  // rather than round a real cost down to a fabricated zero.
  if (abs < PRECISE_COST_ZERO_ROUNDING_FLOOR) {
    return value < 0
      ? PRECISE_COST_ABOVE_NEGATIVE_FLOOR
      : PRECISE_COST_BELOW_FLOOR;
  }
  // Sub-cent: show enough decimals to expose a nonzero figure, but never so many
  // that we render a meaningless string of zeros for a truly negligible slice.
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: PRECISE_COST_MAX_FRACTION_DIGITS,
  })}`;
}

const TRAILING_ZERO_DECIMAL = /\.0$/;

function trimTrailingZero(value: number): string {
  return value.toFixed(1).replace(TRAILING_ZERO_DECIMAL, "");
}

/** 1dp compact display (k/M/B) — use formatTokenCount for 2dp token counts. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= B) {
    return `${trimTrailingZero(value / B)}B`;
  }
  if (abs >= M) {
    if (abs / M >= TIER_CARRY_THRESHOLD) {
      return `${trimTrailingZero(value / B)}B`;
    }
    return `${trimTrailingZero(value / M)}M`;
  }
  if (abs >= K) {
    if (abs / K >= TIER_CARRY_THRESHOLD) {
      return `${trimTrailingZero(value / M)}M`;
    }
    return `${trimTrailingZero(value / K)}k`;
  }
  return `${Math.round(value)}`;
}

export function formatLoc(value: number): string {
  if (Math.abs(value) >= K) {
    return `${trimTrailingZero(value / K)} KLOC`;
  }
  return Math.round(value).toLocaleString("en-US");
}

/**
 * Format a plain numeric value with comma separators.
 *
 * When `isFractional` is true (costs, rates, and other values that can have
 * a meaningful fractional part), decimal precision rules are applied:
 *   - Values less than 10: 2 decimal places (e.g., 9.50)
 *   - Values 10 or greater: rounded to nearest whole number (e.g., 1,234)
 *
 * When `isFractional` is false (integer counts), the value is always displayed
 * as a whole number with comma separators regardless of magnitude (e.g., 13,523).
 */
export function formatNumber(value: number, isFractional = false): string {
  if (isFractional && Math.abs(value) < 10) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return Math.round(value).toLocaleString("en-US");
}

/**
 * A value just under a tier ceiling whose 1dp rounding carries to 1000.0 must
 * tier up rather than render a non-canonical unit (e.g. 999_950 → "1M", not
 * "1000k"). Since output is 1dp, `toFixed(1)` rounds up at 999.95 (mirrors the
 * 2dp `>= 999.995` guard in formatTokenCount).
 */
const TIER_CARRY_THRESHOLD = 999.95;

/**
 * Whole-dollar currency for LARGE aggregate spend headlines (the "AI SPEND" /
 * "Estimated Cost" KPI cards). Rounds to the nearest dollar — cents on a big
 * aggregate (e.g. `$9,060.84` → `$9,061`) add noise, not signal — while keeping
 * the thousands separator. Use `formatCost` for per-session / per-branch /
 * table-row costs where the fractional part is meaningful (e.g. `$1.96`).
 *
 * Sub-dollar guard: a nonzero total below the $0.50 round-to-zero boundary
 * falls back to `formatCostPrecise` (e.g. `$0.12`) so an early/low-usage
 * dashboard never displays real AI spend as a flat `$0`. Exact zero (and
 * `undefined`) still render as `$0`.
 *
 * ISS-4919 / review of #4244: that fallback is `formatCostPrecise`, NOT fixed-2dp
 * `formatCost`. `formatCost` pushed the lie one decimal place down instead of
 * removing it — a real total of `$0.004` rendered as `$0.00` under a caption
 * reading "estimated cost in range", which is the same fabricated zero the
 * null-on-zero rule (`reportableSpendUsd`) exists to stop, just a cent lower.
 * `formatCostPrecise` is the canonical sub-cent formatter this repo already uses
 * for exactly that reason; from $0.01 up to the $0.50 round boundary the two are
 * byte-identical, so this only changes the sub-cent band that was lying.
 *
 * ISS-4919 (completing it): that fallback left one band still lying — below
 * `formatCostPrecise`'s 4dp floor a real cost rounded back to `$0.00`. It now
 * renders {@link WHOLE_CURRENCY_BELOW_FLOOR} instead, so the guarantee is
 * unconditional: **a nonzero total never renders as an exact zero**, and an
 * exact zero is the only thing that renders `$0`.
 */
export function formatCurrencyWhole(cost: number | undefined): string {
  const value = cost ?? 0;
  if (value !== 0 && Math.round(value) === 0) {
    // ISS-4919 (review thread): a whole-dollar tile bounds at the precision the
    // TILE shows, not at the deepest formatter's floor. `formatCostPrecise`'s
    // `< $0.0001` is right where 4dp genuinely renders (the branch timeline
    // tooltip, the trace); on an aggregate headline it is a precision this
    // surface uses nowhere else. Same rule the LOC/$ column already follows
    // (ISS-4866): bound at the column's own precision.
    if (Math.abs(value) < PRECISE_COST_ZERO_ROUNDING_FLOOR) {
      return value < 0
        ? WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR
        : WHOLE_CURRENCY_BELOW_FLOOR;
    }
    return formatCostPrecise(value);
  }
  return `$${Math.round(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/**
 * The precision a WHOLE-DOLLAR tile actually renders. Its sub-floor bound is
 * stated at this precision rather than at `formatCostPrecise`'s 4dp floor: a
 * `< $0.0001` under a `$9,061`-shaped headline is a precision the surface uses
 * nowhere else, and reads as a typo before it reads as a bound. Same rule the
 * LOC/$ column adopted for the identical fact in ISS-4866
 * ({@link LOC_PER_DOLLAR_TWO_DP_FLOOR} → `< 0.01`).
 */
const WHOLE_CURRENCY_BOUND_UNIT = 0.01;

/** What a real, nonzero aggregate too small for any renderable figure reads as
 *  on a whole-dollar tile. See {@link WHOLE_CURRENCY_BOUND_UNIT}. */
export const WHOLE_CURRENCY_BELOW_FLOOR = `< $${WHOLE_CURRENCY_BOUND_UNIT.toFixed(2)}`;

/** Negative mirror of {@link WHOLE_CURRENCY_BELOW_FLOOR}, for a credit/refund
 *  below the floor. */
export const WHOLE_CURRENCY_ABOVE_NEGATIVE_FLOOR = `> -$${WHOLE_CURRENCY_BOUND_UNIT.toFixed(2)}`;

/**
 * Rendered when a numeric metric has no computable value (unknown, not `0`).
 * SSOT for the honest-empty `—` sentinel shared by the insights KPI formatters
 * and the agent-spend cost card — kept in `shared/lib` so a slice-agnostic
 * component (e.g. the shared CostMetricCard) never has to reach into a feature
 * slice just for the placeholder string.
 */
export const KPI_NO_VALUE = "—";

/**
 * Whole-dollar formatter for a metric TILE/card value: an unavailable metric
 * (null / undefined / non-finite) renders the honest-empty {@link KPI_NO_VALUE}
 * `—` (never a misleading `$0`), and a finite number — including a genuine `0`
 * — formats as whole dollars via {@link formatCurrencyWhole}. This is the single
 * currency-tile guard both the insights KPI tiles and the shared cost card route
 * through, so the null/finite branch is defined once.
 */
export function formatCurrencyTileValue(
  value: number | null | undefined
): string {
  if (value == null || !Number.isFinite(value)) {
    return KPI_NO_VALUE;
  }
  return formatCurrencyWhole(value);
}

/**
 * Below this magnitude a fixed-2dp render would print `0.00` for a real,
 * measured efficiency — the exact lie ISS-4667 fixes. Values under it switch to
 * significant-digit precision instead (e.g. `0.0088`, not `0.00`).
 */
const LOC_PER_DOLLAR_TWO_DP_FLOOR = 0.01;

/** Significant digits used for a sub-`0.01` LOC/$ value (e.g. `0.0088`). */
const LOC_PER_DOLLAR_SMALL_SIGNIFICANT_DIGITS = 2;

/**
 * ISS-4667: the single display formatter for the canonical LOC/$ (lines per
 * dollar) code-efficiency metric. Used by every surface that renders it — the
 * session detail row, the Sessions/Branches summary cards, the Agents inventory
 * metric cell and group cards, and the pack detail — so precision and the
 * not-applicable state cannot drift between them.
 *
 *   - unavailable (`null` / `undefined` / non-finite) → the honest-empty
 *     {@link KPI_NO_VALUE} `—`. This is the distinct n/a state for a session
 *     with no lines changed or no cost; it is never rendered as `0.00`.
 *   - a real value under `0.01` → 2 significant digits, so a genuinely small
 *     but non-zero efficiency reads `0.0088` instead of flooring to `0.00`.
 *   - everything else → {@link formatNumber}'s adaptive precision (2dp under
 *     10, whole numbers at or above it).
 *
 * A finite `0` is a TRUE zero (merged work that landed no lines) and still
 * renders `0.00` — only an absent value gets the placeholder.
 */
export function formatLocPerDollar(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return KPI_NO_VALUE;
  }
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < LOC_PER_DOLLAR_TWO_DP_FLOOR) {
    return value.toLocaleString("en-US", {
      maximumSignificantDigits: LOC_PER_DOLLAR_SMALL_SIGNIFICANT_DIGITS,
    });
  }
  return formatNumber(value, true);
}

/** Fixed decimal places for the LOC/$ TABLE column (ISS-4866). */
const LOC_PER_DOLLAR_COLUMN_FRACTION_DIGITS = 2;

/**
 * Rendered for a real value the column's fixed precision cannot express — never
 * `0.00`, which would claim the component produced no lines per dollar when it
 * measurably did (the exact lie ISS-4667 removed from the adaptive formatter).
 */
const LOC_PER_DOLLAR_COLUMN_BELOW_FLOOR = "< 0.01";

/**
 * ISS-4866: the LOC/$ formatter for a TABLE COLUMN, as distinct from
 * {@link formatLocPerDollar}, which stays the formatter for a single-value KPI
 * card.
 *
 * A KPI card shows one number and should give it the precision it deserves, so
 * the adaptive rule is right there. A column shows a stack of numbers whose
 * whole job is to be compared against each other, and adaptive precision defeats
 * that: sorted descending the same metric renders `12`, then `0.88`, then
 * `0.0088` — three different shapes, no shared decimal position, and the eye has
 * to re-parse every row instead of scanning one.
 *
 * So the column commits to ONE precision, and pays the one debt that creates: a
 * real value below what 2dp can show becomes {@link
 * LOC_PER_DOLLAR_COLUMN_BELOW_FLOOR}, not a fabricated `0.00`. "Smaller than the
 * column can show" and "zero" stay different facts, which is the same
 * distinction the unavailable `—` makes against a true zero.
 */
export function formatLocPerDollarColumn(
  value: number | null | undefined
): string {
  if (value == null || !Number.isFinite(value)) {
    return KPI_NO_VALUE;
  }
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < LOC_PER_DOLLAR_TWO_DP_FLOOR) {
    return LOC_PER_DOLLAR_COLUMN_BELOW_FLOOR;
  }
  return value.toLocaleString("en-US", {
    maximumFractionDigits: LOC_PER_DOLLAR_COLUMN_FRACTION_DIGITS,
    minimumFractionDigits: LOC_PER_DOLLAR_COLUMN_FRACTION_DIGITS,
  });
}
