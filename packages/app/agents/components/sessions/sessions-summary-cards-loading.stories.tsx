import {
  LOC_PER_DOLLAR_LABEL,
  LOC_PER_DOLLAR_MERGED_LABEL,
} from "@repo/api/src/utils/loc-per-dollar";
import { summaryCardClass } from "@repo/app/shared/components/summary-card-row";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { SESSIONS_COST_METRIC_CARD_LABEL } from "./cost-metric-card";
import { SESSIONS_METRIC_CARD_LABEL } from "./sessions-summary-card-labels";
import { SessionsSummaryCardsLoading } from "./sessions-summary-cards-loading";

/**
 * ISS-5698: the Sessions summary strip while the usage read is still pending.
 *
 * ISS-5366 replaced five hardcoded `h-[124px]` slabs with five real `MetricCard`
 * shells in their `loading` state, so the reserved height IS the settled card's
 * height at whatever density the row resolves and there is no literal left to
 * keep in sync. That makes this component's contract a VISUAL one, it settles
 * into `sessions-summary-cards.stories.tsx`'s `Default` with no jump, which is
 * exactly what a unit test cannot see and a story can.
 *
 * The other contract is honesty, and it is the reason each story below exists as
 * its own state rather than as an args-table row. A pending read must not look
 * like a settled one: the value slots shimmer instead of rendering `0` or
 * `$0.00`, the caption says the row is loading, and the delta slot reserves with
 * a skeleton rather than printing "No prior period", a verdict the read has not
 * returned. The one thing stated as fact is the LABEL, which is known before the
 * read.
 *
 * Every prop here is resolved by the CALLER (`SessionsSummaryCards`), so the
 * stories are that caller's real permutations, not invented ones.
 */

/**
 * The caption the web and desktop hosts pass for an ordinary pending read.
 *
 * Mirrors `LOADING_DETAIL` in `sessions-summary-cards.tsx`, which is module-
 * private there. The caption is deliberately the CALLER's to resolve (it picks
 * between this and the import wording), so there is no exported constant to
 * import, and re-exporting one only for a story would widen that module's
 * surface.
 */
const LOADING_DETAIL = "Loading…";

/** The stronger caption, for a genuine first-launch import. */
const IMPORTING_HISTORY_DETAIL = "Importing your history";

/**
 * This is the placeholder shown in place of the Sessions summary cards while
 * their data is still loading. It renders five real metric cards already
 * labeled with their final names, each one just shimmering where its value
 * would go, rather than five plain grey rectangles, so the row settles into
 * its final layout with no visible jump once the data arrives. Use it
 * instead of a generic skeleton block specifically because the reserved
 * height always matches the real card's height at whatever density the page
 * is showing, with nothing left to keep in sync by hand.
 */
const meta = {
  title: "Composites/Sessions/Listing/Sessions Summary Cards Loading",
  component: SessionsSummaryCardsLoading,
  tags: ["autodocs"],
  argTypes: {
    loadingDetail: {
      control: "text",
      description:
        "The caption every shell carries. The only slot that can say WHY the strip is blank.",
    },
    locPerDollarLabel: {
      control: { type: "radio" },
      options: [LOC_PER_DOLLAR_LABEL, LOC_PER_DOLLAR_MERGED_LABEL],
      description:
        "The fifth card's label, resolved by the caller from a flag so the shell and the settled row agree.",
    },
    reservesDeltaSlot: {
      control: "boolean",
      description:
        "Does the host surface compare against a prior period? Reserved only where it will be filled.",
    },
    wrapBelow: {
      control: "boolean",
      description:
        "Wrap into a two-column grid below md instead of scrolling the fixed-width row sideways.",
    },
    cardClassName: {
      control: false,
      description:
        "Per-card sizing, resolved by the caller from its layout mode via summaryCardClass.",
    },
  },
  parameters: { layout: "padded" },
  args: {
    // Both production hosts opt into the wrapping grid, so the shell lays out the
    // way it actually ships rather than as the legacy scrolling flex row.
    cardClassName: summaryCardClass(true),
    loadingDetail: LOADING_DETAIL,
    locPerDollarLabel: LOC_PER_DOLLAR_MERGED_LABEL,
    reservesDeltaSlot: true,
    wrapBelow: true,
  },
} satisfies Meta<typeof SessionsSummaryCardsLoading>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The 1099px desktop launch track, once `layout: padded` sheds its 32px from a
 * 1131px canvas. That is the width a fresh desktop install opens at, derived in
 * `apps/desktop/src/shared/window-defaults.ts` and pinned the same way
 * `sessions-summary-cards.stories.tsx` pins it. The density tier resolves compact
 * there, which is the regime the reserved height has to be right in.
 */
const LAUNCH_TRACK_VIEWPORT = { viewport: { value: "1131-900" } };

/** Skeleton count in a shell that reserves the delta slot: five values, five deltas. */
const COMPARING_SKELETON_COUNT = 10;

/** Skeleton count without the delta reservation: the five value slots alone. */
const NON_COMPARING_SKELETON_COUNT = 5;

/**
 * The WEB Sessions page: a comparing surface, so the shell reserves the delta row
 * its settled cards will carry.
 *
 * The `play` is the honesty guard. It asserts the labels are present (they are
 * known before the read, and are why a reader can already tell which five metrics
 * are coming) and that no fabricated zero is on screen. That is the documented
 * failure mode for this strip, where a `$0.00` meaning "not computed yet" is
 * indistinguishable from a real zero. It also counts the skeletons, which is what
 * separates this story from {@link NonComparingSurface} at the DOM level; without
 * it, dropping `reservesDeltaSlot` would render a shorter shell and the sweep
 * would stay green.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(SESSIONS_METRIC_CARD_LABEL)).toBeVisible();
    await expect(
      canvas.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
    ).toBeVisible();
    await expect(canvas.getByText(LOC_PER_DOLLAR_MERGED_LABEL)).toBeVisible();
    // Nothing numeric is claimed while the read is pending.
    await expect(canvas.queryByText(FABRICATED_ZERO)).not.toBeInTheDocument();
    await expect(
      canvas.queryByText(FABRICATED_ZERO_COST)
    ).not.toBeInTheDocument();
    // The reserved delta row is a skeleton, NOT the settled card's placeholder:
    // the row does not yet know whether a prior period exists.
    await expect(
      canvas.queryByText(SETTLED_NO_PRIOR_PERIOD_COPY)
    ).not.toBeInTheDocument();
    await expect(
      canvasElement.querySelectorAll(SKELETON_SELECTOR)
    ).toHaveLength(COMPARING_SKELETON_COUNT);
  },
};

/**
 * The DESKTOP Sessions view, whose local producer has no prior-window read, so it
 * never compares periods.
 *
 * Its settled cards carry no delta row at all, so reserving one here would make
 * the shell TALLER than the card that replaces it: the same settle, in the other
 * direction. Render it beside {@link Default}. The pair is the whole reason
 * `reservesDeltaSlot` is a prop rather than a constant.
 */
export const NonComparingSurface: Story = {
  args: { reservesDeltaSlot: false },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(SKELETON_SELECTOR)
    ).toHaveLength(NON_COMPARING_SKELETON_COUNT);
  },
};

/**
 * A genuine first-launch import rather than an ordinary pending read. The caption
 * is the only slot that can say WHY the strip is blank, and it earns the stronger
 * wording only when an import is actually in flight. Otherwise the shell would
 * tell a returning user their history is being imported when it is merely being
 * re-read.
 */
export const ImportingHistory: Story = {
  args: { loadingDetail: IMPORTING_HISTORY_DETAIL },
};

/**
 * The fifth card's label is picked by the caller from a flag and passed in, so
 * the loading shell and the settled row cannot disagree about which label it
 * carries. This is the shorter of the two, the bare unit with no "(Merged)"
 * scope, and it is the one worth looking at because its SHORTNESS changes the
 * row's shared label reservation: with every label on one line the strip reserves
 * one line, not two.
 */
export const UnscopedLocPerDollarLabel: Story = {
  args: { locPerDollarLabel: LOC_PER_DOLLAR_LABEL },
};

/**
 * The shell at the width people actually open the app at, where the density tier
 * resolves COMPACT.
 *
 * This is the story that shows ISS-5366 closed. The old fixed-height slab did not
 * move with density, so at every width the tier picks compact, which includes
 * this one and therefore every first load, the skeleton was taller than the card
 * that replaced it and the strip (and the table under it) jumped on arrival.
 * Render it beside `Dense: default` in `sessions-summary-cards.stories.tsx`; the
 * two should agree on height, and that is the whole assertion.
 */
export const DenseLaunchTrack: Story = {
  globals: LAUNCH_TRACK_VIEWPORT,
  name: "Dense: the 1099px desktop launch track",
};

/**
 * The phone rank. Below `md` a `wrapBelow` row pins a two-column grid and lets an
 * odd last card span both columns, so five shells close out flush rather than
 * orphaning a half-width fifth. The tier resolves compact there too, which is the
 * narrowest interior any label has to hold two lines in.
 */
export const MobilePairedRank: Story = {
  globals: { viewport: { value: "390-844" } },
};

/**
 * `wrapBelow` off: the component's own default, and the legacy non-wrapping flex
 * row where each shell takes the fixed `--summary-card-min` width and the row
 * scrolls horizontally.
 *
 * No Sessions host ships this today (both pass `wrapBelow`), so it is here as the
 * default-prop state a new caller would land on by omission: five 260px shells
 * that overflow rather than wrap. Worth seeing before someone adopts the shell
 * without the layout mode its settled sibling uses.
 */
export const FixedWidthScrollingRow: Story = {
  args: { cardClassName: summaryCardClass(false), wrapBelow: false },
};

/** A fabricated count: what a shell rendering zeros instead of shimmering prints. */
const FABRICATED_ZERO = "0";

/** The same lie in the Cost slot, which is the one ISS-5401 was filed for. */
const FABRICATED_ZERO_COST = "$0.00";

/**
 * The SETTLED card's delta placeholder (`SUMMARY_NO_PRIOR_PERIOD`). The loading
 * shell must not print it: it is a verdict about whether a prior period exists,
 * and the pending read has not returned one.
 */
const SETTLED_NO_PRIOR_PERIOD_COPY = "No prior period";

/** `Skeleton` marks itself with this slot; the count is how the shell is measured. */
const SKELETON_SELECTOR = '[data-slot="skeleton"]';
