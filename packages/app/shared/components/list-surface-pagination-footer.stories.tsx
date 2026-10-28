import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ListPageRange } from "../lib/list-pagination-readout";
import { ListSurfacePaginationFooter } from "./list-surface-pagination-footer";

/**
 * ISS-9225 (#6777 review, whitlockk) — the ONE footer both v2 list surfaces render,
 * in the states its render tests cannot see.
 *
 * `__tests__/list-surface-pagination-footer.test.tsx` asserts the BEHAVIOUR this
 * component owns: which ladder it offers, which page it pages from, and when the
 * sentence is withheld. None of that is geometry. The three configurations below
 * that change the strip's SHAPE — the inert placeholder page, the footer with no
 * rows-per-page control, and the sub-`sm` stack — all render green in jsdom
 * whatever they look like, because the assertions there are on roles, names and
 * text content.
 *
 * That is the gap a promoted, prop-driven component owes a story for.
 */

/**
 * Sessions' sentence LENGTH, not Sessions' sentence. The shipped copy lives in
 * `agents/lib/sessions-range-readout.ts` and `branches/lib/branches-range-readout.ts`
 * and is each surface's to own — `packages/app/shared` imports neither slice
 * today, and a story is not a reason to open that edge.
 *
 * Length is nonetheless the load-bearing property here: the left group is
 * `shrink-0` against a `w-full` pager, so how long this string is decides
 * whether the two fit on one line. These two fixtures bracket the shipped range
 * — the announced sentence with a unit at the top, the terse range at the
 * bottom — so the stories render the widest and narrowest left group the
 * component is actually handed.
 */
/**
 * The component's own `formatRange` contract, named so every fixture below is
 * annotated with it. Without the annotation each one infers its own narrower
 * return (`string`, or `null`), `StoryObj<typeof meta>` pins the args to
 * whichever one `meta` happens to hold, and a story overriding it stops
 * typechecking — the declining fixture is exactly the case that breaks.
 */
type FormatRange = (range: ListPageRange, total: number) => string | null;

const ANNOUNCED_SENTENCE: FormatRange = ({ from, to }, total) =>
  `Showing ${from}-${to} of ${total} sessions`;

const TERSE_RANGE: FormatRange = ({ from, to }, total) =>
  `${from}–${to} of ${total}`;

/** A surface declining its sentence on a page with no rows. */
const NO_SENTENCE: FormatRange = () => null;

/**
 * The band `GridTableListSurface` drops the footer into, copied from it rather
 * than approximated. The footer passes `border-t-0 p-0` and `w-full` precisely
 * because this wrapper already owns the rule and the padding, so a story that
 * renders the bare component paints a strip with neither, and every spacing
 * judgement made against it is made against the wrong element.
 */
const inListSurfaceBand: Decorator = (Story) => (
  <div className="flex min-w-0 justify-end border-t px-4 py-3">
    <Story />
  </div>
);

const meta = {
  title: "Composites v1.0/App Shell/List Surface Pagination Footer",
  component: ListSurfacePaginationFooter,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [inListSurfaceBand],
  args: {
    formatRange: ANNOUNCED_SENTENCE,
    isPlaceholderPage: false,
    onPageChange: () => undefined,
    onPageSizeChange: () => undefined,
    page: 0,
    pageSize: 25,
    rowsOnPage: 25,
    total: 240,
    totalPages: 10,
  },
} satisfies Meta<typeof ListSurfacePaginationFooter>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The steady state: rows-per-page select, readout, and a live pager. The select
 * and the sentence are one control and its state, so they share a baseline and
 * the readout drops to `text-xs` to match the trigger — compare against
 * {@link WithoutRowsPerPage}, where it is `text-sm` because there is nothing
 * beside it to match.
 */
export const Default: Story = {};

/**
 * Branches' terse range on the same page, which is the shortest left group the
 * component is handed. Present because the two surfaces deliberately keep
 * different wording, and the strip has to hold its shape across both.
 */
export const TerseRange: Story = {
  args: { formatRange: TERSE_RANGE },
};

/**
 * The rows on screen are not the page `page` names — a read is in flight and the
 * table below is showing the previous page. Every control is inert and the
 * sentence is gone, but the strip keeps its height, so the table does not jump
 * as pages change.
 *
 * The disabled rendering is the whole point of this story: nothing in jsdom
 * distinguishes a greyed-out control from a live one that happens to carry
 * `aria-disabled`.
 */
export const PlaceholderPage: Story = {
  args: { isPlaceholderPage: true },
};

/**
 * The sibling that makes the one above legible. The range is not yet knowable —
 * a first read, or a bookmarked page awaiting its clamp — so the sentence is
 * withheld, but the reader can still page away. Side by side with
 * {@link PlaceholderPage} these look different; a rule that conflated them
 * would show up here as two identical strips.
 */
export const RangeUnsettled: Story = {
  args: { isRangeUnsettled: true },
};

/**
 * A surface with no rows-per-page control to offer: withholding the handler
 * withholds the select. The readout takes `text-sm` here rather than the
 * `text-xs` it uses beside the trigger, which is a size change no role or text
 * assertion can observe.
 */
export const WithoutRowsPerPage: Story = {
  args: { onPageSizeChange: undefined },
};

/**
 * One page of results. The pager stays mounted and inert instead of vanishing,
 * so the strip does not change height as a filter narrows the list down to a
 * single page and back.
 */
export const SinglePage: Story = {
  args: { rowsOnPage: 8, total: 8, totalPages: 1 },
};

/**
 * Neither a sentence nor a select: an empty page on a surface that declines its
 * readout, because the empty state above already says there is nothing. The
 * left group is then omitted ENTIRELY rather than rendered empty — an invisible
 * flex child here would push the pager off the right edge under
 * `sm:justify-between`, which is a regression the design-system shell has
 * shipped once before.
 */
export const BarePager: Story = {
  args: {
    formatRange: NO_SENTENCE,
    onPageSizeChange: undefined,
    rowsOnPage: 0,
    total: 0,
    totalPages: 1,
  },
};

/**
 * Below `sm` the strip stops being a row: it stacks and centres, select and
 * sentence above the pager.
 *
 * This pins a VIEWPORT rather than wrapping the footer in a narrow box, for the
 * reason `summary-card-row.stories.tsx` records for its own narrow story — the
 * breakpoint is a media query, so a narrow wrapper inside a wide canvas renders
 * the WIDE case and proves nothing. It carries the longest sentence for the
 * same reason: this is where the left group and the pager stop fitting.
 */
export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
