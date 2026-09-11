import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { SummaryCardRow, summaryCardClass } from "./summary-card-row";

/**
 * ISS-4966 (#4284 review, wongk): `SummaryCardRow` derives its own column rank
 * from the width it measures, and that rank is a LAYOUT contract — the
 * arithmetic behind it is unit-tested in
 * `__tests__/use-summary-card-columns.test.ts`, but the rank the row actually
 * PAINTS was not rendered anywhere. A regression in the measure-and-publish half
 * reopens either the 4 + 1 orphan this change closes or the sub-260px cards
 * ISS-4787 closed, and both stay green in the vitest suite.
 *
 * So these stories pin the three widths that decide it, on the five-card
 * Sessions strip that reported the orphan.
 *
 * Every story pins a VIEWPORT rather than wrapping the row in a fixed-width box,
 * for the reason `metric-card.stories.tsx` records for its own narrow story: the
 * row's `md:` tier is a media query and the derivation holds itself to the `md+`
 * tier through `matchMedia`, so both key off the VIEWPORT, not the element's
 * width. A narrow wrapper inside a wide canvas renders the wide case and proves
 * nothing.
 */

/**
 * The info popover the Sessions strip's Cost card carries in production. Present
 * in these stories on purpose: the trigger is what makes the two-line label a
 * LAYOUT problem rather than just a long string, under `MetricCard`'s flex label
 * region it strands in the card's top-right corner, and ISS-5068's dense path
 * re-flows the region so it trails the last word instead. A story without it
 * renders the one configuration where that cannot happen, so a regression that
 * puts the glyph back in the corner would render green.
 */
const COST_INFO = {
  what: "Spend not covered by a Claude subscription.",
  how: "Sums per-session API cost across the selected range.",
};

/**
 * The five cards the Sessions summary strip ships, in order. The Cost card
 * carried the only label long enough to wrap when these stories were written
 * ("Non-subscription Cost"), which is what made the shared label baseline
 * visible in them too. That label has since been shortened to "cost", which
 * BUYS slack and does not license lowering any floor — but it also means no
 * label in this strip reaches a second line at the widths rendered below, so
 * the wrapped renderings the band stories describe are what the layout WOULD
 * produce for a label that long, not what these fixtures paint today.
 */
function SessionsStripCards() {
  return (
    <>
      <MetricCard
        className={summaryCardClass(true)}
        detail="in the selected range"
        label="Sessions"
        value="1,284"
      />
      <MetricCard
        className={summaryCardClass(true)}
        detail="input + output"
        label="Total Tokens"
        value="41.2M"
      />
      <MetricCard
        className={summaryCardClass(true)}
        detail="+$412 if billed to API"
        info={COST_INFO}
        label="cost"
        value="$19,608"
      />
      <MetricCard
        className={summaryCardClass(true)}
        detail="merged in range"
        label="PRs Shipped"
        value="96"
      />
      <MetricCard
        className={summaryCardClass(true)}
        detail="across sessions in range"
        label="LOC / $ (Merged)"
        value="18.4"
      />
    </>
  );
}

/**
 * The strip as the Sessions page mounts it: grid mode (`wrapBelow`), which is
 * the mode the column derivation owns. Needs no provider — ISS-5366 retired the
 * three gates that used to select between these layouts, so every story below
 * renders the one shipped path and differs only by the VIEWPORT it is pinned at,
 * which is the row's real input.
 */
function DerivedStrip() {
  return (
    <SummaryCardRow wrapBelow>
      <SessionsStripCards />
    </SummaryCardRow>
  );
}

// No `autodocs` tag: every story below pins a VIEWPORT, which is the row's real
// input, and a docs page renders them all at the docs container's own width. All
// six would come out identical, showing none of the tiers they exist to pin.
// `activity-bucket-tooltip.stories.tsx` omits the tag for the same kind of reason.
/**
 * Lines up a row of metric cards, like the Sessions page's Sessions, Tokens,
 * and Cost summary bar, so they read as one strip instead of a hand built
 * row. Reach for it whenever you are showing a handful of key numbers side
 * by side and want them to size and space themselves consistently. It
 * automatically tightens each card's padding when the row gets narrow, and
 * keeps every card's label lined up on the same baseline so a longer label
 * on one card does not push its number out of line with its neighbors. It
 * can also wrap into a two column grid on narrow screens instead of
 * scrolling sideways.
 */
const meta = {
  title: "Composites/Layout/Summary Card Row",
  component: SummaryCardRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    busy: { control: "boolean" },
    children: { control: false },
    className: { control: "text" },
    minWidth: {
      control: { type: "number", min: 160, max: 400, step: 4 },
      description:
        "Explicit per-card floor in px. Leave it empty to take the row's own tier: the dense floor at compact, 260 at comfortable.",
    },
    wrapBelow: { control: "boolean" },
  },
  args: { busy: false, children: null as ReactNode, wrapBelow: true },
} satisfies Meta<typeof SummaryCardRow>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * ABOVE the band. Five cards already fit at the roomy 260px floor, so the tier
 * hands the comfortable card back — tightening here would cost legibility for no
 * layout gain. It is also the derivation's ceiling case: the rank must never be
 * NARROWER than the cards actually fit, or it strands width the `auto-fit`
 * template it replaces would have used.
 */
export const TierComfortableAboveTheBand: Story = {
  globals: { viewport: { value: "1512-900" } },
  render: () => <DerivedStrip />,
  name: "Comfortable above the band, where five already fit",
};

/**
 * INSIDE the band, at the reported 1079px desktop track. Five cards do not fit
 * roomy and do fit tight, so this is the width at which compact is earning its
 * keep — and the width the whole density feature was filed about. The current
 * launch track (1099) sits in the same band, so the answer is unchanged.
 *
 * Pinned at `1111-900`, NOT at 1240: under `layout: padded` the canvas sheds
 * 32px, so 1111 renders a 1079px track. At 1240 the cards come out ~229px, wide
 * enough that EVERY label including "cost" sits on one line, so
 * the story would render green while showing none of the risk it claims to show.
 *
 * This is also where the density and the column derivation have to AGREE. They
 * are one layout resolved by two rules, and the failure worth rendering is the
 * rank coming out narrower than the dense floor allows, re-introducing the wrap
 * the density removed. They cannot, by construction: the derivation reads its
 * floor from the SAME `--summary-card-min` the density publishes, so a lower
 * floor simply widens the rank it can close flush. Five cards in five columns
 * leave ZERO trailing cells, the best case its own rule can pick. If this ever
 * renders 3 + 2, the two have come apart.
 */
export const TierCompactInsideTheBand: Story = {
  globals: { viewport: { value: "1111-900" } },
  render: () => <DerivedStrip />,
  name: "Compact inside the band: one rank, zero empty cells",
};

/**
 * THE WIDTH PEOPLE ACTUALLY LAUNCH INTO — 1099px of track, and the first Sessions
 * screen a fresh desktop install paints.
 *
 * ISS-5366 (stage review). Every other story in this file brackets this width
 * without ever landing on it: `TierCompactInsideTheBand` renders 1079 (the track
 * the density defect was REPORTED at, back when the window opened at 1380) and
 * `DenseLabelTriggerOrphanBand` renders 1118. Neither is the shipped default, and
 * that gap is precisely how the trigger-orphan band came to be documented as
 * sitting "about 95px of window drag above the launch track" when the launch
 * track had moved INSIDE it — nothing rendered the real width, so nothing
 * contradicted the claim.
 *
 * Pinned at `1131-900`: under `layout: padded` the canvas sheds 32px, so 1131
 * renders the 1099px track. That number is one chain off `DEFAULT_WINDOW_WIDTH`
 * in `apps/desktop/src/shared/window-defaults.ts` — 1400, less the 16rem nav
 * rail, the page's inset gutter, the strip's own `px-4` and the renderer's
 * scrollbar. Five compact cards over it are `(1099 - 4 * 16) / 5 = 207px`.
 *
 * What to look at is the Cost card's label. 207px sits inside the 205.8–224.8px
 * trigger-orphan band, so before ISS-5070 item 5 landed a Cost card whose label
 * wraps rendered that label on one line with its info glyph stranded alone on
 * line two. It now reads "Non-subscription" / "Cost ⓘ" instead of
 * "Non-subscription Cost" / "ⓘ" — same two lines, same 32px reservation, same
 * shared value baseline across the rank, with the glyph attached to the word it
 * belongs to.
 *
 * The web shell lands in the same band at a 1440px viewport (~1139px track,
 * ~215px cards), so this story stands in for both surfaces' default.
 */
export const DenseLaunchTrack: Story = {
  globals: { viewport: { value: "1131-900" } },
  render: () => <DerivedStrip />,
  name: "Compact at the real 1099px desktop launch track",
};

/**
 * BELOW the band — the deliberate degradation, and the half a naive "narrower
 * means tighter" rule gets wrong. Nothing fits on one rank at either floor here,
 * so the strip wraps whatever the interior does; a cramped card buys no rank and
 * only costs legibility, so the roomier card comes back.
 *
 * It is also where ISS-4966's rank rule is now visible: at the roomy floor four
 * columns would leave the fifth card alone against three dead cells (the
 * FEA-2935 orphan at a quarter width), so the derivation skips that rank
 * entirely and lays out 3 + 2, whose final row carries the one trailing empty
 * cell that reads as the natural rhythm of an odd count. If this story ever
 * renders 4 + 1, the orphan is back.
 */
export const TierComfortableBelowTheBand: Story = {
  globals: { viewport: { value: "1000-900" } },
  render: () => <DerivedStrip />,
  name: "Comfortable below the band: three and two, never four and one",
};

/**
 * The middle of the trigger-orphan band, kept as the regression guard for the
 * fix that closed it.
 *
 * The compact path re-flows the label region to `block` so the info trigger
 * trails the last word. That makes the trigger a trailing inline box, and every
 * trailing inline box has a band of widths where the TEXT fits on one line but
 * the box's ~19px advance does not fit after it — so the line breaker used to
 * drop the glyph alone onto line two, flush under the label's first letter.
 * Measured at card widths 205.8–224.8px, which at five columns is a 1093–1188px
 * track. `1150-900` renders 1118 under `layout: padded`, the middle of it.
 *
 * READ THAT TRACK RANGE AGAINST THE SHIPPED DEFAULTS, which is what this doc
 * failed to do until ISS-5366 (stage review). It used to describe the band as
 * "14px above the reported 1079px track... about 95px of drag", i.e. a width a
 * user had to go looking for. That was true when the desktop opened at 1380 and
 * measured a 1079px track. The window then widened to 1400, which moved the
 * track to 1099 — INSIDE 1093–1188. The web shell at a 1440px viewport measures
 * ~1139, also inside. So the band was never off to the side of normal use; it is
 * where both surfaces open, and `DenseLaunchTrack` above now renders that exact
 * width rather than leaving it bracketed.
 *
 * Which is why the deferral did not survive the review: nothing BREAKS in the
 * band (the region holds its 32px reservation and the rank's value baseline stays
 * flush straight through), so the cost is purely how the line reads — a fair
 * trade while the density gate was closed and nobody saw it, and not an
 * acceptable shipped default once it is what a fresh install paints.
 *
 * It could never be fixed from the ROW — card width comes from the column count,
 * not from the floor the row publishes, so no floor moves the cards out of the
 * band, and shrinking the trigger's advance would only slide it. So it is fixed
 * in the primitive: `MetricCard` wraps its label and trigger in a nowrap island
 * (ISS-5070 item 5) that `SUMMARY_CARD_LABEL_REFLOW_CLASS` flips to `inline`. The
 * Cost card here reads "Non-subscription" / "Cost ⓘ".
 *
 * This story is now the guard rather than the record: if the glyph is ever alone
 * on line two here again, the island has come apart — most likely because
 * something moved the trigger inside the inner `white-space: normal` span, or
 * dropped one of the two `inline` flips, neither of which fails a jsdom test on
 * its own beyond the structural assertions in
 * `__tests__/metric-card-label-join.test.tsx`.
 */
export const DenseLabelTriggerOrphanBand: Story = {
  globals: { viewport: { value: "1150-900" } },
  render: () => <DerivedStrip />,
  name: "Compact: the width band that used to orphan the label's info trigger",
};

/**
 * BELOW `md`: FEA-3865's phone pairing, where the row's own static `grid-cols-2`
 * class owns the layout and an odd last card spans both columns. The derivation
 * has to get OUT OF THE WAY here — an inline `grid-template-columns` beats a
 * class at every width, so a rank published from a wider frame would push the
 * `md+` tier's 260px floor down onto a 360px phone and hand back cards under it.
 * The hook clears the property below the tier for exactly this reason (an earlier
 * revision clamped to a two-column floor instead and reopened ISS-4787 at the
 * band the strips ship at with a 16rem nav rail).
 */
export const TwoUpBelowMd: Story = {
  globals: { viewport: { value: "360-720" } },
  render: () => <DerivedStrip />,
  name: "Two up below md, with the odd card spanning",
};
