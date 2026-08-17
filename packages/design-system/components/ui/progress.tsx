"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@closedloop-ai/design-system/lib/utils"

const ProgressTone = {
  Default: "default",
  Neutral: "neutral",
  Success: "success",
  Warning: "warning",
  Destructive: "destructive",
} as const

type ProgressTone = (typeof ProgressTone)[keyof typeof ProgressTone]

type ProgressToneStyles = {
  track: string
  fill: string
  hatch: string
  sheen: string
}

/**
 * ISS-5115: tone is owned here rather than by each caller. Recolouring a bar
 * used to mean reaching into the indicator with a
 * `[&>[data-slot=progress-indicator]]:bg-*` child selector, which every caller
 * hand-rolled and which only ever recoloured the determinate fill — it left the
 * track and the indeterminate hatch and sheen on the default tone.
 */
const PROGRESS_TONE_STYLES = {
  [ProgressTone.Default]: {
    track: "bg-primary/20",
    fill: "bg-primary",
    hatch: "text-primary",
    sheen: "via-primary/60",
  },
  // The quiet end of a severity scale. `Default` spends the brand accent, which
  // is the loudest colour available, so a scale that only escalates from it puts
  // its loudest step on its least urgent state and leaves the step up to amber
  // meaning less than it should. Use `Neutral` for the resting band, and for a
  // value the caller could not measure at all — asserting no severity is the
  // honest rendering of an amount nobody knows (wongk, PR #4572).
  [ProgressTone.Neutral]: {
    track: "bg-muted-foreground/20",
    fill: "bg-muted-foreground",
    hatch: "text-muted-foreground",
    sheen: "via-muted-foreground/60",
  },
  [ProgressTone.Success]: {
    track: "bg-success/20",
    fill: "bg-success",
    hatch: "text-success",
    sheen: "via-success/60",
  },
  [ProgressTone.Warning]: {
    track: "bg-warning/20",
    fill: "bg-warning",
    hatch: "text-warning",
    sheen: "via-warning/60",
  },
  [ProgressTone.Destructive]: {
    track: "bg-destructive/20",
    fill: "bg-destructive",
    hatch: "text-destructive",
    sheen: "via-destructive/60",
  },
} as const satisfies Record<ProgressTone, ProgressToneStyles>

type ProgressProps = React.ComponentProps<typeof ProgressPrimitive.Root> & {
  /**
   * Freezes the indeterminate sweep. Use it when work is known to have stopped
   * advancing (stalled, paused, needs attention) so a travelling bar cannot
   * imply progress that is not happening. Ignored when `value` is a number.
   */
  paused?: boolean
  /**
   * Sweeps the liveness sheen over a DETERMINATE fill as well. Use it when the
   * value is known but the thread that advances it can block, so a frozen count
   * reads as loading rather than as hung. Redundant on an indeterminate bar,
   * which always sweeps unless `paused`.
   */
  sweep?: boolean
  /**
   * Semantic colour of the track, fill and indeterminate treatment. Prefer this
   * over recolouring the indicator from the call site.
   */
  tone?: ProgressTone
}

/**
 * ISS-5115: `value` is now forwarded to Radix. It previously was not, so every
 * bar in the app rendered as `data-state="indeterminate"` with no
 * `aria-valuenow` regardless of the number passed in — a determinate bar that
 * announced nothing.
 *
 * A value the contract cannot represent resolves to indeterminate rather than
 * to an invented one: non-finite, or above `max`. Clamping an overshoot DOWN to
 * `max` would be the worst possible lie, because Radix reads `value === max` as
 * `data-state="complete"` — so a caller whose ratio overshot (a total that
 * shrank, a double count) would get an affirmative "finished". Below zero
 * clamps to zero, which under-claims and is safe. `max` itself is validated the
 * same way, since a zero or non-finite `max` would otherwise divide into a
 * `NaN` transform that the browser drops, leaving a full-width bar next to an
 * `aria-valuenow` of 0. Radix would also `console.error` on either, and browser
 * code must never emit that.
 *
 * `value == null` is Radix's indeterminate contract: it drops `aria-valuenow`,
 * so an indeterminate bar stays honest about not knowing how far along it is.
 * The sighted rendering has to be honest too, which rules out three options: a
 * partial fill and a travelling sliver each put a hard edge at some position in
 * the track and the eye reads that edge as a percentage; a uniform full-width
 * wash has no edge but reads as 100%; and an empty track reads as 0%. So the
 * indeterminate state is a diagonal hatch across the whole track — no edge to
 * read as a position, no solid fill to read as an amount — with a soft gradient
 * sheen passing over it while work is running.
 *
 * `paused` and `prefers-reduced-motion` drop only the sheen. The hatch stays in
 * both cases, so a paused bar reads as held rather than reset, and a
 * reduced-motion user (the one person who cannot see the sweep) still gets
 * "amount unknown" rather than a bar that looks finished.
 *
 * `sweep` opts a DETERMINATE bar into the same sheen. It is for the case where
 * the value is known but the thread that updates it can block: the sheen is a
 * CSS animation, so it runs on the compositor and the bar keeps visibly moving
 * while a frozen count would otherwise read as hung rather than as loading.
 */
function Progress({
  className,
  max = 100,
  paused = false,
  sweep = false,
  tone = ProgressTone.Default,
  value,
  ...props
}: ProgressProps) {
  const resolvedMax = resolveProgressMax(max)
  const resolvedValue = resolveProgressValue(value, resolvedMax)
  const toneStyles = PROGRESS_TONE_STYLES[tone]
  const showSheen = !paused && (resolvedValue === null || sweep)

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full",
        toneStyles.track,
        className
      )}
      max={resolvedMax}
      value={resolvedValue}
      {...props}
    >
      {resolvedValue === null ? (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          data-paused={paused ? "true" : undefined}
          className={cn(
            "progress-hatch absolute inset-0 rounded-full",
            toneStyles.hatch
          )}
        />
      ) : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn("h-full w-full flex-1 transition-all", toneStyles.fill)}
          style={{
            transform: `translateX(-${100 - (resolvedValue / resolvedMax) * 100}%)`,
          }}
        />
      )}
      {showSheen ? (
        <span
          aria-hidden="true"
          data-slot="progress-sheen"
          className={cn(
            "motion-safe:animate-progress-indeterminate absolute inset-y-0 left-0 hidden w-1/3 bg-gradient-to-r from-transparent to-transparent motion-safe:block",
            toneStyles.sheen
          )}
        />
      ) : null}
    </ProgressPrimitive.Root>
  )
}

const DEFAULT_PROGRESS_MAX = 100

function resolveProgressMax(max: number | undefined): number {
  return typeof max === "number" && Number.isFinite(max) && max > 0
    ? max
    : DEFAULT_PROGRESS_MAX
}

function resolveProgressValue(
  value: number | null | undefined,
  max: number
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value > max) {
    return null
  }
  return Math.max(0, value)
}

export { Progress, ProgressTone }
