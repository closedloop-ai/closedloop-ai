"use client";

import {
  SUMMARY_CARD_MIN_PROPERTY,
  useSummaryCardColumns,
} from "@repo/app/shared/hooks/use-summary-card-columns";
import { useSummaryCardDensity } from "@repo/app/shared/hooks/use-summary-card-density";
import { useSummaryLabelBaseline } from "@repo/app/shared/hooks/use-summary-label-baseline";
import {
  CARD_DENSITY_VARIANT_CLASS,
  CardDensity,
} from "@repo/design-system/components/ui/card-density";
import { cn } from "@repo/design-system/lib/utils";
import type { CSSProperties, ReactNode } from "react";

/**
 * The per-card floor every summary strip lays out against, published as
 * `--summary-card-min`.
 *
 * This number is LOAD-BEARING, not decorative: the longest label the strips
 * shipped when it was chosen ("Non-subscription Cost") breaks onto a third line
 * at a 256px card, which overflows the two-line label reservation below and drops
 * that card's value out of its rank's shared baseline (ISS-4787, and its desktop
 * regression). So 260 carries about 4px of slack over the worst label we had when
 * it was measured — that label has since been shortened, which BUYS slack and
 * does not license lowering this. A longer metric label,
 * or a lower floor, reopens that defect — check a new label against this width
 * before adding it.
 */
const DEFAULT_CARD_MIN_WIDTH = 260;

/**
 * ISS-5068: the per-card floor the DENSE strip lays out against, published as
 * `--summary-card-min` whenever the resolved density is compact. It is lower
 * than the floor above, and that is only safe because the density class below
 * buys the width back on the INSIDE of the card.
 *
 * Two limits bracket it, and they fail in opposite ways.
 *
 * LAYOUT ceiling, 203. The desktop Sessions strip measures a 1099px track at the
 * launch width (it was 1079 at the old 1380px default; see
 * `apps/desktop/src/shared/window-defaults.ts` for the derivation), so five on
 * one rank need `5 * min + 4 * 16 <= 1099`, i.e. `min <= 206`. 192 sits 14px
 * under it, and stayed under the tighter 203 the old track allowed. This is the side that fails SILENTLY:
 * any later chrome change that drops the track below `5 * 192 + 64 = 1024px` puts
 * the strip back onto two ranks with nothing failing in a unit test.
 * `apps/desktop/test/e2e/sessions-summary-strip-density.spec.ts` measures the real
 * launch width and is the guard for exactly that.
 *
 * LABEL floor, 192. "Non-subscription Cost" was the longest label either strip
 * shipped when this was measured (ISS-4787), and 192 is the width it was MEASURED
 * to hold on two lines on a BADGED card. Measure the badged card, not a bare one:
 * `MetricCard`'s header
 * is a `flex justify-between gap-4` row, so the "Sample" badge every Branches
 * card without a KPI renders spends the gap plus the badge out of the same width.
 * A bare card holds two lines down to 167, which is optimistic. Crossing this
 * floor is loud, the rank's shared value baseline visibly breaks.
 *
 * Re-measure BOTH limits before moving it, on a badged card.
 */
const DENSE_CARD_MIN_WIDTH = 192;

/**
 * ISS-5070: the strip's own label rule — the one that is NOT about `Card`'s slot
 * geometry.
 *
 * The card interior itself (padding, gap, the caption reservation, the footer
 * and bordered-seam gutters item 1a added) lives in
 * `CARD_DENSITY_VARIANT_CLASS`, beside the `Card` primitive whose values it
 * steps down from, and is switched by the `data-density` attribute this row
 * sets. What is left here is the LABEL RE-FLOW, which is a `MetricCard` concern
 * rather than a `Card` one: it is about where `MetricCard` puts an info trigger
 * inside its description slot, and no other `Card` consumer composes that slot
 * the same way.
 *
 * `MetricCard` ships its label region as a flex row, so a label that wraps to
 * two lines (which "Non-subscription Cost" did at BOTH floors) strands the info
 * glyph beside line one in the card's top-right corner, the same slot the
 * "Sample" badge uses, where it reads as a card-level control. `block` drops the
 * region out of flex so the trigger trails the last word at any label length.
 *
 * ISS-5366 (stage review): this used to be keyed on `data-density=compact`, so
 * the SAME control had two placements — inline after the label at a ~1100px
 * track, stranded in the corner at ~1600 — and a reader moved it by dragging
 * their window, with no cause they could see. That was defensible while the
 * density gate was closed and only compact renders reached anyone; retiring the
 * gate makes both placements shipped behavior at once, which is worse than
 * either alone. The prefix is gone, so the trigger trails the last word at BOTH
 * densities.
 *
 * The two rules it carries were re-checked against a comfortable card before
 * dropping the prefix, and neither is density-specific: `MetricCard` renders one
 * trigger with one `triggerClassName` (`h-6 -my-1 -mx-1.5`) at every width, and
 * the label's `leading-4` line box below is applied by the row at both
 * densities, so the arithmetic each rule depends on is identical.
 *
 * At a layout level this belongs in `MetricCard`, since the stranding hits every
 * consumer at any narrow width. It stays scoped to the strip here because
 * lifting it into the primitive moves the glyph for EVERY `Card` consumer,
 * including the Insights KPI tiles — that is ISS-5070 item 6, which needs its
 * own re-verification against those tiles.
 *
 * `ml-0` restores the 6px the flex `gap-1.5` used to supply: `InfoHint` widens
 * its hit box with `px-1.5` and `MetricCard` cancels it with `-mx-1.5`, so
 * zeroing margin-left leaves that `px-1.5` uncancelled, the same 6px by another
 * route. Do NOT "fix" this to `ml-1.5`, which stacks 6px on 6px and measures
 * 12.00px against the shipped 6.00px.
 *
 * `align-top`, NOT `align-middle`, is load-bearing. The trigger's margin box is
 * 16px (`h-6` pulled back by `-my-1`), exactly the label's `leading-4` line box.
 * `vertical-align: middle` centres it about a pixel below the strut's descent and
 * GROWS the line, so the region measures 33.06px against the 32px `min-h-8`
 * reserves and that card's value drops off the rank's shared baseline, which is
 * the ISS-4787 break this row exists to prevent. `sessions-summary-strip-density`
 * (desktop E2E) asserts the dense strip's 32px reservation as an equality, so
 * this is pinned rather than left to eye. The legibility twins
 * assert the same region against the DERIVED reservation, which at their widths
 * is 16px — a 33.06px region fails there too, by an even wider margin.
 *
 * CLOSED by ISS-5366 (stage review), by taking ISS-5070 item 5 rather than
 * deferring it a third time. `display: block` makes the trigger a TRAILING INLINE
 * BOX, and every trailing inline box has a band of card widths (205.8 to 224.8px)
 * where the label fits one line but the trigger's ~19px advance does not fit
 * after it, so the line breaker dropped the glyph alone onto line two, flush
 * under its label.
 *
 * An earlier revision of this comment placed that band "about 95px of window drag
 * above the launch track", i.e. somewhere a user had to go looking for. It is
 * not. Both surfaces OPEN inside it:
 *
 *  - DESKTOP, the 1400px default window: a 1099px track
 *    (`apps/desktop/src/shared/window-defaults.ts`) over five compact cards is
 *    `(1099 - 4 * 16) / 5 = 207px`.
 *  - WEB at a 1440px viewport: 1440 less the 16rem sidebar and the host's `px-4`
 *    gutters is a 1152px track, ~1139 once the renderer reserves its scrollbar,
 *    so `(1139 - 64) / 5 = 215px`.
 *
 * So it was not an edge case, it was the first Sessions screen a fresh install
 * paints — which is why "nothing load-bearing breaks" (the 32px reservation and
 * the rank's value baseline do both hold straight through the band) stopped being
 * a good enough reason to leave it. It was a fair trade while the density gate
 * was closed and nobody saw it; it is not an acceptable shipped default.
 *
 * No floor closes it from this row — card width comes from the column count, not
 * from the floor published here — so the fix is in the primitive, and it is the
 * two `contents` spans `MetricCard` now wraps its label region in
 * (`METRIC_CARD_LABEL_JOIN_SLOT` / `METRIC_CARD_LABEL_TEXT_SLOT`, exported from
 * `metric-card.tsx`; the selectors below are written as literals because Tailwind
 * extracts candidates from source text, and `metric-card-label-join.test.tsx`
 * asserts the two files stay in step).
 * Flipping both to `inline` here turns them into a real NOWRAP ISLAND: the outer
 * one suppresses the soft-wrap opportunity between the label and the trigger, the
 * inner one keeps `white-space: normal` over the label text so the label still
 * wraps between its own words. In the band a Cost card whose label wraps reads
 * "Non-subscription" / "Cost ⓘ" instead of "Non-subscription Cost" / "ⓘ".
 *
 * The reservation is unaffected, which is what makes this safe to land without a
 * containerised visual pass: both renderings are TWO `leading-4` line boxes, so
 * the region measures the same 32px it did before and no card's value moves off
 * the rank's shared baseline. Below the band (label already wrapped, glyph
 * already trailing "Cost") and above it (everything on one line) render
 * byte-identically to before — the band is the only width whose output changes.
 *
 * This does NOT move the glyph for other `Card` consumers, and deliberately so:
 * `display: contents` means both spans dissolve wherever the region stays
 * `MetricCard`'s default flex row, so the Insights KPI tiles, the Dashboard and
 * Branches keep the exact box tree they had. Lifting the re-flow itself into the
 * primitive is still ISS-5070 item 6, still unlanded, and still needs the visual
 * pass against those tiles that this change does not.
 *
 * `DenseLaunchTrack` and `DenseLabelTriggerOrphanBand` in the stories render the
 * launch width and the middle of the band, so the join stays visible instead of
 * described.
 */
const SUMMARY_CARD_LABEL_REFLOW_CLASS =
  "[&_[data-slot=card-description]]:block [&_[data-slot=metric-card-label-join]]:inline [&_[data-slot=metric-card-label-text]]:inline [&_[data-slot=metric-card-label-join]>button]:ml-0 [&_[data-slot=metric-card-label-join]>button]:align-top";

// ISS-5068 / ISS-5070 item 3, CLOSED by ISS-5366 (stage review). An earlier
// revision of this row published a `--summary-card-height-offset` so the two
// skeleton hosts could subtract the height a dense card gives back from their
// reserved literals (`h-[124px]` on the Sessions strip, `h-[112px]` on the
// desktop Branches fallback) and not jump when the data landed. It is gone, and
// it is not coming back, because the literals it was correcting are the actual
// defect: one shared constant cannot describe both hosts (a Sessions card
// renders a caption-only `CardContent`, a Branches `BranchKpiCard` renders a
// delta chip row above that caption, so the height each gives back differs by
// that reservation), and deriving a per-host number would be two unmeasured
// constants where there was one.
//
// The Sessions strip no longer has a literal to correct. Its loading state is
// five real `MetricCard` shells in their `loading` state — see
// `packages/app/agents/components/sessions/sessions-summary-cards-loading.tsx`
// — so the reserved height IS the card's height at whatever density this row
// resolves, and no measurement has to be kept in sync. That is why the
// deferral note that used to sit here is gone rather than updated.
//
// The desktop Branches fallback (`branches-loading.tsx`) and the dashboard
// (`dashboard-loading.tsx`) still reserve `h-[112px]` slabs. They are outside
// this change's surface, and the same treatment is what closes them.

/**
 * The auto-fit track template every grid-laid summary strip shares: fit as many
 * whole `--summary-card-min` cards as the width holds, wrap the rest, and let each
 * track absorb the remainder (`1fr`). Declared once because both grid layouts
 * below use it — a second copy of the expression is how the floor's shape drifts
 * on one path and not the other.
 *
 * Below `md` (768px) the strips stack or pair instead; `auto-fit` self-limits, so
 * no host needs its own breakpoint tier above that.
 */
/**
 * The columns a `wrapBelow` row pins below `md` — FEA-3865's phone pairing, the
 * `grid-cols-2` in the row's own class list. Named because the density tier has
 * to reason about that rank (see `belowMdColumns`), and a bare `2` in the hook
 * call could not be checked against the class it is meant to mirror.
 */
const MOBILE_PAIRED_COLUMN_COUNT = 2;

const SUMMARY_CARD_AUTO_FIT_TRACKS_CLASS =
  "md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))]";

// Summary cards lay out in a single non-wrapping row that overflows
// horizontally and scrolls with the table (the host page shares one scroll
// container), per the Claude Design prototype. Each card takes its width from
// the row's `--summary-card-min` custom property (default 260px) and never
// shrinks. Shared by the Sessions and Branches summary-card rows.
//
// FEA-3865: below the row's `wrapBelow` breakpoint the width relaxes to `w-full`
// so cards fill a two-column grid instead of forcing horizontal scroll on a
// phone. The width class reads the same custom property, so a caller that does
// not opt into `wrapBelow` renders byte-identically to the fixed 260px row.
export const SUMMARY_CARD_CLASS = "w-[var(--summary-card-min)] shrink-0";

// The `wrapBelow` companion: the card ALWAYS fills its grid cell (`w-full`), at
// every width. Below `md` that's the two-column mobile grid; at `md+` it's the
// auto-fit min-width grid (see `SummaryCardRow`), which wraps six cards onto
// multiple rows when the width can't hold them all rather than pushing the last
// ones off-screen behind horizontal scroll (FEA-3574 review — six 260px cards
// overflow a 1440 laptop with the app sidebar). The breakpoint is `md` (768px),
// NOT `xs` — the same width `GridTable` flips the table beneath the strip from a
// scrolling grid to a card list (CARD_FALLBACK_BREAKPOINT) — so the whole
// surface migrates together and never keeps a horizontal scrollbar the cards
// removed.
const SUMMARY_CARD_WRAP_CLASS = "w-full";

// ISS-4787: the strip's cards render side by side and read as one rank of
// numbers, so a card whose label wraps to two lines ("Non-subscription Cost" at
// the strip's card width) used to start its value a whole line-height below its
// one-line siblings and break that shared baseline.
//
// The reservation lives HERE, on the row, not on the `MetricCard` primitive
// (ISS-4787 review, wongk + stage): a floor inside the card would charge every
// consumer — including the Insights KPI tiles, which are pinned to a fixed-height
// grid host and would push their trend footer into the gutter, and the solo cards
// that pay a blank line for an alignment they have no sibling to share. Scoping it
// to the row means only the surfaces that actually lay cards out in a rank take
// the constraint.
// `leading-4` pins the label's line box to 1rem so a reserved two lines fill the
// `min-h-8` (2rem) box exactly rather than overshooting it into a sub-pixel
// stagger. It is also the line box `align-top` on the info trigger is measured
// against (see `SUMMARY_CARD_LABEL_REFLOW_CLASS`), so the two rules are one
// decision and must move together.
//
// ISS-5366: an `items-start` rule used to sit beside it, top-aligning a
// FLEX-composed label region inside the reserved box so `MetricCard`'s
// `flex items-center` description could not centre its label and break the
// row's shared first-line alignment. It is gone because the label re-flow above
// now sets `display: block` on that same region at BOTH densities, which makes
// `align-items` inert on it by construction rather than only at compact. It was
// not carrying a comfortable-density render any more, and a rule that cannot
// fire is worse than no rule: the next reader has to re-derive that it is dead.
// If the re-flow is ever narrowed back to one density, restore this with it.
const SUMMARY_CARD_LABEL_LEADING_CLASS =
  "[&_[data-slot=card-description]]:leading-4";

// ISS-4887: the derived reservation, and since ISS-5062 the ONLY one. The floor
// comes from `--summary-card-label-min`, which `useSummaryLabelBaseline`
// publishes on the row as the tallest label region ACTUALLY rendered at the
// current width — so the track sizes itself at the `md+` auto-fit grid, the
// `max-md:` two-column fallback, AND the desktop pane, with no magic line count.
//
// The `2rem` fallback is the ISS-4787 fixed two-line floor, byte-for-byte, so
// any frame before the first measurement (SSR, a jsdom render, an environment
// with no ResizeObserver) reserves exactly what shipped then rather than
// collapsing the labels. It is why the `summary-strip-label-baseline` gate could
// come out cleanly: the flag-off path was not a second implementation, it was
// this same fallback held permanently — a FLOOR of two lines, not a clamp, so a
// label that genuinely needs a third line still gets it (and that card alone
// gives up the shared baseline) rather than being elided.
const SUMMARY_CARD_LABEL_ROW_BASELINE_CLASS = `[&_[data-slot=card-description]]:min-h-[var(--summary-card-label-min,2rem)] ${SUMMARY_CARD_LABEL_LEADING_CLASS}`;

export function SummaryCardRow({
  children,
  className,
  minWidth,
  wrapBelow = false,
  busy = false,
}: {
  children: ReactNode;
  className?: string;
  /**
   * Per-card minimum width in px, published as `--summary-card-min` for the
   * card class to consume. Omit it to take the row's own floor: the ISS-5068
   * dense floor at compact density, or 260 at comfortable. An explicit value
   * always wins, so a caller that has measured its own surface is never
   * overridden by the resolved tier.
   */
  minWidth?: number;
  /**
   * FEA-3865: below the `md` breakpoint (768px — the same width `GridTable`
   * flips the table beneath the strip to a card list), wrap the cards into a
   * two-column, full-width grid instead of a non-wrapping horizontally-scrolling
   * row. At `md+` the layout returns to the flex row. Defaults to `false`, so
   * existing callers keep the single-row, horizontal-scroll behavior
   * byte-for-byte.
   */
  wrapBelow?: boolean;
  /**
   * Marks the row as an in-progress loading region (`aria-busy`) so assistive
   * tech announces that its cards are updating, rather than reading skeletoned
   * value slots as stale content. Used when a card's value is hydrating (e.g. the
   * Sessions bar's always-available cards during a first-launch import). Defaults
   * to `false`, so existing callers render byte-identically.
   */
  busy?: boolean;
}) {
  // ISS-4887, rolled out and un-gated by ISS-5062: the label reservation is
  // derived from the row's own tallest label at every mount. There is no second
  // path — see `SUMMARY_CARD_LABEL_ROW_BASELINE_CLASS`, whose `2rem` fallback IS
  // what the removed flag's off branch used to render.
  const { ref: rowRef } = useSummaryLabelBaseline();
  // ISS-5068 + ISS-5149 (gates retired by ISS-5366, both shipped ON): the strip
  // measures the track it is laid into and lays out compact only where the
  // compact floor is what buys a single rank — comfortable above that band (the
  // cards already fit) and comfortable below it too (nothing fits at either
  // floor, so a cramped card buys nothing and costs legibility).
  //
  // The tighter card interior and the lower floor it pays for are ONE decision,
  // not two: the floor is only safe because the padding came down, so applying
  // half of it would be the ISS-4787 baseline regression.
  const measuredDensity = useSummaryCardDensity(rowRef, {
    // ISS-5366 (stage review): below `md` a `wrapBelow` row pins the static
    // two-column grid declared in `className` below, so the tier's one-rank
    // question does not describe the layout it is answering for — five cards
    // never fit one rank there at either floor, so a phone always resolved
    // COMFORTABLE and the narrowest cards on any surface got the roomiest
    // interior. Declaring the pinned count switches it to the question that
    // regime actually poses. A non-`wrapBelow` row is a flex line with no fixed
    // rank, so it declares none and keeps the one-rank question at every width.
    belowMdColumns: wrapBelow ? MOBILE_PAIRED_COLUMN_COUNT : undefined,
    comfortableMinWidth: DEFAULT_CARD_MIN_WIDTH,
    compactMinWidth: DENSE_CARD_MIN_WIDTH,
  });
  // A `null` measurement is "not measured yet", NOT "comfortable", so the strip
  // renders compact from the first frame and never flashes the roomier card on
  // the way in. Only a tier that actually MEASURED a width where compact buys
  // nothing hands the roomy card back.
  const density =
    measuredDensity === CardDensity.Comfortable
      ? CardDensity.Comfortable
      : CardDensity.Compact;
  const resolvedMinWidth =
    minWidth ??
    (density === CardDensity.Compact
      ? DENSE_CARD_MIN_WIDTH
      : DEFAULT_CARD_MIN_WIDTH);
  // ISS-4966 (gate retired by ISS-5366, shipped ON): derive the strip's COLUMN
  // COUNT from the width the row actually has, instead of letting `auto-fit`
  // maximise columns and strand the last card of an odd-count strip. Still
  // scoped to `wrapBelow`, the row's grid mode — a flex line has no columns to
  // choose, so the derivation is inert there by construction.
  //
  // The density above composes with it rather than competing: this derivation
  // reads its floor from the SAME `--summary-card-min`, so a lower floor widens
  // the rank it can close flush. At the desktop launch width a five-card strip
  // goes from "three fit, close 3 + 2" to "five fit, zero trailing cells" — the
  // outcome both issues want, and they agree by construction.
  //
  // `resolvedMinWidth` is passed so the derivation re-measures when the floor
  // MOVES, not only when the row happens to resize. A live row can republish
  // `--summary-card-min` without a remount (the density tier re-resolving at a
  // new track width), and the derivation reads that property to bake a fixed
  // `grid-template-columns` onto the row, so without this it would keep a rank
  // computed from the OLD floor until some unrelated ResizeObserver fire
  // refreshed it. It does refresh today, but only incidentally: the density
  // class also changes the row's height. That is a side effect of a rule that
  // could later change only widths, so the dependency is declared rather than
  // relied upon.
  useSummaryCardColumns(wrapBelow, rowRef, resolvedMinWidth);
  const style = {
    [SUMMARY_CARD_MIN_PROPERTY]: `${resolvedMinWidth}px`,
  } as CSSProperties;
  return (
    <div
      aria-busy={busy || undefined}
      className={cn(
        // ISS-5070: the density variant, applied unconditionally and switched by
        // `data-density` below. It is inert at comfortable density, which is
        // what makes the density a NAMED THING rather than a conditionally
        // concatenated selector patch.
        CARD_DENSITY_VARIANT_CLASS,
        // ISS-5070 / ISS-5366: the info trigger trails the last word of the
        // label at BOTH densities, so the control does not relocate when the
        // window is dragged across the tier boundary.
        SUMMARY_CARD_LABEL_REFLOW_CLASS,
        // `wrapBelow`: a two-column grid below `md` (an odd last card spans both
        // columns so it never orphans half-width), then an AUTO-FIT min-width
        // grid at `md+` that wraps cards onto multiple rows when the width can't
        // hold them all — never a non-wrapping flex row that pushes the last
        // cards off-screen behind horizontal scroll (FEA-3574 review). Non-`wrap`
        // callers (Branches) keep the fixed-width, horizontally-scrolling flex
        // row byte-for-byte.
        wrapBelow
          ? // Below `md` the two-column grid can orphan a half-width last card
            // when the count is odd (five cards → 2 + 2 + 1). Let an odd final
            // child span both columns so the row always closes out flush;
            // scoped `max-md:` so the `md+` auto-fit grid is unaffected, and a
            // no-op when the count is even.
            `grid grid-cols-2 gap-4 ${SUMMARY_CARD_AUTO_FIT_TRACKS_CLASS} max-md:[&>*:last-child:nth-child(odd)]:col-span-2`
          : "flex gap-4",
        // ISS-4787 / ISS-4887: the shared label-region baseline, scoped to this
        // strip and derived from the row's own tallest label.
        SUMMARY_CARD_LABEL_ROW_BASELINE_CLASS,
        className
      )}
      data-density={density}
      ref={rowRef}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * The per-card sizing class for a `SummaryCardRow`. Pass the row's `wrapBelow`
 * to keep the card and its row in the same layout mode: `wrapBelow` cards fill
 * their grid cell below `md` and pin to the shared min-width at `md+`; otherwise
 * every card is the fixed non-shrinking min-width, exactly as before.
 */
export function summaryCardClass(wrapBelow = false): string {
  return wrapBelow ? SUMMARY_CARD_WRAP_CLASS : SUMMARY_CARD_CLASS;
}

// ISS-4787 follow-up (stage review): a `SUMMARY_CARD_GRID_CLASS` export used to
// live here so the desktop Sessions and Branches strips could lay out in a grid
// instead of this row's default flex line. It is gone, and the desktop hosts now
// pass `wrapBelow` like every other grid caller.
//
// It had to override the row's own `display` to work, which is the tell that it
// was re-implementing a mode the row already owns — and the two copies had drifted:
// the class stacked ONE card per row below `md` while the row's `wrapBelow` paired
// them two-up and spanned an odd last card, and it set `gap-3` against the row's
// `gap-4`, so the same Sessions strip rendered 12px gutters on desktop and 16px on
// web. Both divergences disappear by construction now that one layout owner is
// left. The `md+` auto-fit derivation the follow-up actually needed is unchanged —
// it is `SUMMARY_CARD_AUTO_FIT_TRACKS_CLASS` above, which the row already applied.
