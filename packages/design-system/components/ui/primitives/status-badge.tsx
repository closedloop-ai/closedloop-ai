"use client";

import type { BadgeProps } from "@closedloop-ai/design-system/components/ui/badge";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { Tone } from "../types";

/**
 * FEA-4035: `Tone` → `Badge` variant, replacing the parallel className map this
 * file used to hand-maintain.
 *
 * There were three tone→color sources in the repo — `badgeVariants`, this
 * component's `toneClasses`, and `ToneLabel`'s `TONE_TEXT_CLASS` — all named
 * some version of "tone", and this one had already DRIFTED on its `default`
 * row: it rendered a bordered neutral chip while `badgeVariants.default`
 * renders a solid primary one. Rather than repoint `default` at a visibly
 * different fill, the row it actually shipped is now the `neutral` variant in
 * `badge.tsx`, and this map names it. Every row here therefore resolves to the
 * SAME utilities the component rendered before (`badge-tone-parity.test.tsx`
 * asserts that, class for class), so nothing on screen moves.
 *
 * `danger` is this vocabulary's name for the soft destructive treatment that
 * `badgeVariants` calls `error`; `destructive` there is the SOLID red chip,
 * which is not what a status pill wants.
 */
const TONE_BADGE_VARIANT: Record<Tone, NonNullable<BadgeProps["variant"]>> = {
  default: "neutral",
  success: "success",
  warning: "warning",
  danger: "error",
  info: "info",
  accent: "accent",
  muted: "muted",
};

type ToneBadgeProps = {
  label: string;
  tone?: Tone;
  pulse?: boolean;
  /**
   * ISS-5279: pulse a RING around the whole pill — the treatment a Sessions row
   * uses to say its transcript is still uploading without spending a second pill
   * on the fact.
   *
   * A ring, deliberately, not the pill's opacity. Fading the pill dips the label
   * with it, and the label is the thing this treatment exists to keep (Parker,
   * PR review: 2.89:1 → 1.66:1 on the light success pill, twice a second). The
   * ring lives outside the content box, so the pill beats and the word holds.
   *
   * Composes with {@link pulse} but is not meant to be worn WITH it on a 24px
   * pill: two animations on one chip read as one busy pill rather than as two
   * facts (PR review), so a caller turning the ring on should hand the dot's
   * opacity pulse off and let the ring be the mark.
   *
   * The motion is never the only carrier of the state (WCAG 1.4.1). Visually
   * under a reduce-motion preference, the pulse becomes a persistent ring
   * ({@link STATUS_PULSE_RING_REDUCED_MOTION_CLASS}) so the mark is still SEEN;
   * non-visually, give the badge an `aria-label` — and, since a pill is not
   * natively focusable, a `tabIndex` when a tooltip explains it.
   */
  pulseRing?: boolean;
  /**
   * Render WITHOUT the leading state dot.
   *
   * For a pill that has to sit on the same line as toned status pills and match
   * their height, weight and type scale, but is not itself a state — the Sessions
   * row-qualifier overflow counter (`+2`) is the case this was added for
   * (ISS-5282, review cid 3731458708). Carrying the dot there would read as one
   * more row STATE rather than as a count of them, and the dot plus its gap
   * spends ~18px a narrow track cannot afford; but hand-rolling a plain `Badge`
   * instead — 12px medium at ~20px tall against this component's 11px semibold at
   * `h-6` — puts two pills of different heights and weights on one line, which
   * reads as a mistake rather than as a counter.
   *
   * Use it only for a non-state pill in state-pill company. A pill that DOES
   * carry a state keeps its dot: the dot is what makes the tone readable to
   * anyone who cannot resolve the fill color.
   */
  showDot?: boolean;
} & Omit<
  React.ComponentProps<typeof Badge>,
  "variant" | "children"
>;

export function ToneBadge({
  label,
  tone = "default",
  pulse = false,
  pulseRing = false,
  showDot = true,
  className,
  ...passthrough
}: ToneBadgeProps) {
  // `className` is destructured (merged into the tone classes below) so it is
  // NOT re-spread via `passthrough`; the rest (aria-label, data-*, ref, …) is.
  return (
    <Badge
      className={cn(
        "h-6 gap-1.5 rounded-full px-2.5 font-semibold text-[11px] tracking-[0.01em]",
        pulseRing && [
          STATUS_PULSE_RING_CLASS,
          STATUS_PULSE_RING_REDUCED_MOTION_CLASS,
          STATUS_PULSE_RING_FOCUS_CLASS,
        ],
        className
      )}
      variant={TONE_BADGE_VARIANT[tone]}
      {...passthrough}
    >
      {showDot ? <StatusDot aria-hidden="true" pulse={pulse} /> : null}
      {label}
    </Badge>
  );
}

const dotToneClasses: Record<Tone, string> = {
  default: "bg-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
  accent: "bg-primary",
  muted: "bg-muted-foreground",
};

/**
 * The small round state dot — the same mark {@link ToneBadge} carries, usable on
 * its own where a state needs indicating without a labelled pill.
 *
 * Extracted (ISS-5036) rather than re-rolled at the call site: the Sessions list
 * needed a standalone liveness dot beside the session name, and hand-rolling one
 * would have duplicated both the geometry and the pulse timing, leaving two dots
 * free to drift apart. `ToneBadge` now renders
 * THIS component, so the dot inside a pill and the dot standing alone are the
 * same mark by construction.
 *
 * Omit `tone` to inherit the parent's text color (`bg-current`) — what a dot
 * inside a toned pill wants. Pass a `tone` when the dot stands alone and has no
 * colored parent to inherit from.
 *
 * Decorative by default. A dot that is the ONLY carrier of a state — no adjacent
 * text saying the same thing — is not decorative: give it `role="img"` and an
 * `aria-label`, or the state exists only for sighted users.
 *
 * The pulse is decorative — it draws the eye to a row that needs attention — and
 * a filtered LIST where most rows carry the same pulsing mark turns a column
 * into a strobe. WCAG 2.2.2 (Pause, Stop, Hide) makes an indefinite animation
 * the viewer's call, so an OS "reduce motion" preference stills the dot and
 * leaves whatever carries the meaning — the pill's label, or the standalone
 * dot's `aria-label` — untouched (#4284 review).
 *
 * ISS-5279: the timing is now the named `--animate-status-pulse` theme token
 * behind a `motion-safe:` prefix (see {@link STATUS_PULSE_CLASS}), rather than
 * an inline `animate-[pulse_1.6s_…]` literal plus `motion-reduce:animate-none`.
 * Same 1.6s beat, same 50%-opacity dip, so nothing on screen moves — and
 * {@link ToneBadge}'s pill-level ring pulse runs on the same 1.6s period, so a
 * pill carrying both marks beats as one thing rather than as two.
 */
export function StatusDot({
  tone,
  pulse = false,
  className,
  ...passthrough
}: {
  tone?: Tone;
  pulse?: boolean;
} & React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone ? dotToneClasses[tone] : "bg-current",
        pulse && STATUS_PULSE_CLASS,
        className
      )}
      {...passthrough}
    />
  );
}

/**
 * ISS-5279: the dot's opacity pulse — the `--animate-status-pulse` theme token
 * behind its mandatory reduced-motion guard, kept together so no caller can
 * apply the animation and forget the guard.
 *
 * `motion-reduce:animate-none`, NOT `motion-safe:`, even though the sibling ring
 * uses `motion-safe:`. The two are not complements — a UA that reports no
 * preference at all matches neither, so switching the DOT to `motion-safe:`
 * would silently still it there. This dot renders on every Active pill across
 * Agents, Sessions, and the detail views, none of which this ticket touches, so
 * it keeps the exact guard it shipped with (PR review). The ring is new, and
 * needs `motion-safe:` so its `motion-reduce:` still rendering can take over.
 *
 * Declared at the bottom per the repo's append-new-declarations rule.
 */
const STATUS_PULSE_CLASS =
  "animate-status-pulse motion-reduce:animate-none" as const;

/**
 * ISS-5279: the pill's ring pulse — see the `--animate-status-pulse-ring`
 * declaration in `globals.css` for why it is a ring and not the pill's opacity.
 * Same `motion-safe:` pairing as {@link STATUS_PULSE_CLASS}.
 */
const STATUS_PULSE_RING_CLASS =
  "motion-safe:animate-status-pulse-ring" as const;

/**
 * ISS-5279: what the ring pulse becomes when the viewer has asked for less
 * motion — the animation's peak ring, held still.
 *
 * `motion-safe:`/`motion-reduce:` are exclusive, so without this a reduce-motion
 * user got an unmarked pill and the mark existed only in the accessibility tree.
 * That is a fair fallback for a screen-reader user and a poor one for the sighted
 * user who simply dislikes movement: they can see the pill perfectly well, they
 * just can't see WHICH pill is marked.
 *
 * `ring-2` at 55%, not a hairline: the pill already ships a `border-<tone>/25`,
 * so a 1px ring at low alpha reads as a slightly thicker border rather than as a
 * mark (Parker, PR review). Doubling the weight and the contrast against that
 * border is what makes it findable in a column at 1x.
 */
const STATUS_PULSE_RING_REDUCED_MOTION_CLASS =
  "motion-reduce:ring-2 motion-reduce:ring-current/55" as const;

/**
 * ISS-5279: the focus indicator for a pill that carries the ring mark — an
 * OUTLINE, not `Badge`'s own `focus-visible:ring-[3px]`.
 *
 * Both of this pill's other treatments occupy `box-shadow`: Tailwind implements
 * `ring-*` as a box-shadow, and `--animate-status-pulse-ring` animates
 * `box-shadow` directly. So on a marked pill the default focus ring is a
 * same-property, same-shape change over an existing ring — a slight shift in
 * width and hue under reduce-motion, and under motion-safe it is not drawn at
 * all, because an animation's declaration beats the static one it collides with.
 * A keyboard user tabbing the Status column had no reliable indication of where
 * they were, which `tabIndex={0}` made worse by adding a stop on every syncing
 * row (PR review).
 *
 * `outline` is a separate property, so it cannot be clobbered by either, and
 * `outline-offset-2` detaches it from the pill's edge — a gap no flush ring
 * produces, which is what makes focus legible against the mark rather than a
 * variation of it.
 */
const STATUS_PULSE_RING_FOCUS_CLASS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" as const;
