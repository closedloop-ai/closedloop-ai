import {
  Progress,
  ProgressTone,
} from "@repo/design-system/components/ui/progress";
import { cn } from "@repo/design-system/lib/utils";
import {
  formatAbsoluteDateTime,
  formatResetLabel,
  formatUsedLabel,
  toDateTimeAttribute,
} from "../lib/format";
import type { RateLimit } from "../types";

export type LimitBarProps = {
  title: string;
  limit: RateLimit;
  /** Injected for deterministic reset-label rendering in tests. */
  now?: Date;
  /** Extra descriptor appended before the reset text (e.g. credit summary). */
  subtext?: string | null;
  /**
   * Show the reset moment as a readable date and time next to the relative
   * label. The detail drawer sets this; the sidebar bars leave it off, where the
   * column is ~200px wide and the absolute time would wrap — there the datetime
   * still reaches the DOM through the `<time dateTime>` attribute and the title.
   */
  showResetDateTime?: boolean;
  /** Injectable time zone so tests are not hostage to the runner's TZ. */
  timeZone?: string;
  className?: string;
};

/**
 * One labeled usage meter: title + "N% used" over a Progress bar, with an
 * optional "Resets …" line. Read-only.
 *
 * The percentage is rendered as TEXT as well as a bar (PRD-538 R6): a bar alone
 * carries no value to a screen reader, and `aria-label` on the meter repeats the
 * same figure so the control is self-describing when reached out of context.
 *
 * `utilization` is handed to `Progress` unclamped on purpose. `Progress` already
 * resolves a value its contract cannot represent to an indeterminate hatch,
 * which is the honest rendering; pre-clamping a non-finite value to 0 would take
 * that decision away and paint an empty track next to "0% used" — a measured
 * zero the feature never measured. The text slot degrades the same way, to
 * "Usage unknown".
 *
 * That indeterminate bar ships `paused`, because `Progress` sweeps its sheen
 * over an indeterminate track unless told the work has stopped. Here nothing is
 * in flight: the snapshot arrived and simply carried no usable figure. Letting
 * it travel would read as "still loading" next to the real loading skeleton,
 * which is the exact conflation this slice exists to remove. The hatch stays,
 * so the bar still says "amount unknown" rather than looking empty or finished.
 */
export function LimitBar({
  title,
  limit,
  now,
  subtext,
  showResetDateTime,
  timeZone,
  className,
}: LimitBarProps) {
  const usageUnknown = !Number.isFinite(limit.utilization);
  const used = formatUsedLabel(limit.utilization);
  const usedText = used ?? "Usage unknown";
  const reset = formatResetLabel(limit.resetsAt, now);
  const resetDateTime = toDateTimeAttribute(limit.resetsAt);
  const resetAbsolute = formatAbsoluteDateTime(limit.resetsAt, timeZone);
  const resetText =
    showResetDateTime && resetAbsolute ? `${reset} (${resetAbsolute})` : reset;

  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      data-testid="limit-bar"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        {/* `title` because this span truncates: the sidebar column is ~14rem
            and the per-model week names are the longest thing that lands in it,
            so without it the clipped-off half is unrecoverable. */}
        <span className="min-w-0 truncate font-medium" title={title}>
          {title}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {usedText}
        </span>
      </div>
      <Progress
        aria-label={`${title}: ${usedText}`}
        paused={usageUnknown}
        tone={toneForUtilization(limit.utilization)}
        value={limit.utilization}
      />
      {subtext || reset ? (
        <span className="text-[11px] text-muted-foreground">
          {subtext}
          {subtext && reset ? " · " : null}
          {reset ? (
            <>
              {"Resets "}
              {resetDateTime ? (
                <time
                  dateTime={resetDateTime}
                  title={resetAbsolute ?? undefined}
                >
                  {resetText}
                </time>
              ) : (
                resetText
              )}
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const WARNING_UTILIZATION = 75;
const DESTRUCTIVE_UTILIZATION = 90;

/**
 * Colour the meter by how close the window is to its ceiling.
 *
 * The only question anyone brings to this bar is "am I about to get cut off",
 * and length alone answers it poorly at ~200px in a sidebar footer seen
 * peripherally. `Progress` ships the tones for exactly this (ISS-5115), so the
 * accent is reused rather than hand-rolled.
 *
 * The resting band is Neutral, not Default. Default is the brand accent, and
 * these bars live permanently in the sidebar footer: two saturated bars sitting
 * there at 20% used spend the loudest colour in the scale on its least urgent
 * state, and leave the step up to amber with much less to say. Starting neutral
 * means a coloured bar is itself the signal (wongk, PR #4572).
 *
 * A non-finite value is Neutral for a different reason: `Progress` renders it as
 * an indeterminate hatch, and tinting an amount we never measured with ANY
 * severity — including the brand accent — asserts something the snapshot does
 * not support. Unknown should be the quietest thing on screen, not the loudest.
 */
function toneForUtilization(utilization: number): ProgressTone {
  if (!Number.isFinite(utilization)) {
    return ProgressTone.Neutral;
  }
  if (utilization >= DESTRUCTIVE_UTILIZATION) {
    return ProgressTone.Destructive;
  }
  if (utilization >= WARNING_UTILIZATION) {
    return ProgressTone.Warning;
  }
  return ProgressTone.Neutral;
}
