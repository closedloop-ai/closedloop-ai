import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { Meta, StoryObj } from "@storybook/react";
import { createAgentSessionUsageSummaryFixture } from "./session-list-fixtures";
import { SessionsSummaryCards } from "./sessions-summary-cards";

/**
 * The reported ISS-4773 shape, sharing its numbers with
 * `__tests__/sessions-summary-cards-cost-basis.test.tsx` so the story and the
 * suite pin ONE payload: a subscription-heavy account whose non-subscription
 * bucket ($16,825) is almost entirely usage the collector could not classify.
 * Only $42 of it was ever billed to an API key. Its three lanes reconcile with
 * `totalEstimatedCost`, so it resolves to the breakdown presentation.
 *
 * An override that BREAKS that reconciliation drops the card to the shipped
 * fallback — which is deliberate in `CostVersionSkewFallback` and
 * `LocalFallbackWithCostDisclosure`, and would silently pin the wrong frame
 * anywhere else.
 */
function splitUsageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalInputTokens: 4_820_000,
      totalOutputTokens: 612_000,
      totalEstimatedCost: 18_855,
      subscriptionEstimatedCost: 2030,
      apiEstimatedCost: 16_825,
      meteredEstimatedCost: 42,
      unknownEstimatedCost: 16_783,
      mergedPrCount: 9,
      mergedLocPerDollar: 132,
      ...overrides,
    }
  );
}

const meta = {
  title: "Composites v1.0/Sessions/Sessions Summary Cards",
  component: SessionsSummaryCards,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: {
    isLoading: false,
    usage: splitUsageFixture(),
    // Both production call sites (the web Sessions page and the desktop
    // `SessionsView`) opt into the wrapping grid, so the stories lay the strip
    // out the way it actually ships rather than as the legacy scrolling row.
    wrapBelow: true,
  },
} satisfies Meta<typeof SessionsSummaryCards>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shipping strip. Since ISS-8791 retired both cost flags, this payload
 * resolves to the BREAKDOWN presentation with no gate consulted: the headline is
 * the subscription-inclusive $18,855 total and the three lanes that make it up
 * sit behind the disclosure. The two stories below reach the older collapsed
 * frame instead, each by breaking the partition a different way.
 */
export const Default: Story = {};

/**
 * Version skew: an already-installed Desktop predating ISS-4773 publishes only
 * the collapsed bucket, so there is no split to stand behind. Treating that
 * absence as "$0 billed" would be a worse lie than the bucket label, so the card
 * degrades to the shipped "cost" presentation — the same frame `Default` shows,
 * reached for a different reason. Since ISS-8791 this is the ONLY route to that
 * frame: breakdown claims every payload it can substantiate.
 */
export const CostVersionSkewFallback: Story = {
  args: {
    usage: splitUsageFixture({
      meteredEstimatedCost: undefined,
      unknownEstimatedCost: undefined,
    }),
  },
};

/**
 * The whole strip pending: five `MetricCard` shells in their `loading` state, so
 * the row reserves exactly the space it will settle into and the page beneath it
 * does not jump on arrival — at any density, with no reserved height literal to
 * keep in sync (ISS-5070 item 3, closed by ISS-5366).
 *
 * The labels are real, because they are known before the read; nothing else is
 * asserted. The value slots shimmer rather than showing a zero, and on a
 * comparing surface the delta slot reserves with a skeleton rather than printing
 * "No prior period" — a verdict the pending read has not returned.
 */
export const Loading: Story = {
  args: { isLoading: true },
};

/**
 * The same pending strip on a COMPARING surface (the web Sessions page), which
 * is the branch the loading shell exists to get right and the one the story
 * above cannot show.
 *
 * A comparing surface's settled cards carry an extra row inside `CardContent` —
 * the delta chip, or the "No prior period" placeholder in the same slot — so a
 * shell without that row would be SHORTER than the card replacing it and would
 * reintroduce the settle this component was written to remove. Render it beside
 * {@link PeriodComparison}, which is what it settles into: the two should agree
 * on height, and that is the whole assertion.
 *
 * The reserved slot is a skeleton, NOT "No prior period". While the read is
 * pending the row genuinely does not know whether a prior period exists, and
 * printing that line would state a verdict it has not got — the same reason the
 * value slots shimmer instead of showing a zero. The `deltas` payload matches
 * `PeriodComparison`'s so the pair really is the same surface before and after.
 */
export const LoadingWithComparison: Story = {
  args: {
    isLoading: true,
    deltas: {
      label: "vs. prior 30 days",
      sessions: { delta: 24, deltaPolarity: MetricPolarity.HigherIsBetter },
      tokens: { delta: 61, deltaPolarity: MetricPolarity.Neutral },
    },
  },
  name: "Loading: on a surface that compares",
};

/**
 * The usage read failed. Values collapse to the neutral em-dash and the delivery
 * cards dim to their unavailable state — the cards keep their labels and info
 * popovers rather than disappearing, so a failed read reads as a failed read and
 * never as a confirmed zero.
 */
export const ReadFailed: Story = {
  args: { isError: true, usage: undefined },
};

/**
 * The desktop cloud-failure path: the cloud read failed with nothing in hand, so
 * the three always-available cards fall back to the local SQLite totals. They now
 * describe a DIFFERENT population than the rows beneath them, so they are
 * captioned with their source instead of the filter-scope claim.
 */
export const LocalFallback: Story = {
  args: {
    isError: true,
    usage: undefined,
    localUsage: splitUsageFixture(),
  },
};

/**
 * The ISS-4773 review fix: the local fallback COMPOSES with the disclosure
 * caption rather than replacing it. Before the fix a cloud failure left the card
 * headlining a narrowed figure with no mention of the share it had just
 * excluded — the card hiding exactly the amount it dropped, at the moment the
 * reader is least able to check it. Provenance and disclosure answer different
 * questions, so both are stated, and this is the story that shows what
 * middot-joined facts do to a 124px card.
 */
export const LocalFallbackWithCostDisclosure: Story = {
  args: {
    isError: true,
    usage: undefined,
    localUsage: splitUsageFixture({ unknownEstimatedCost: undefined }),
  },
};

/**
 * ISS-5070 item 2: DENSITY coverage on the REAL strip.
 *
 * ISS-5068 shipped its density stories against `SessionsStripCards` in
 * `summary-card-row.stories.tsx` — five hand-built `MetricCard`s with no `info`,
 * no delta slot, no error dim, no sign-in CTA, and shorter captions than
 * production. Those omissions are precisely why the design review's findings
 * were invisible in the stories. The strip below is the one that ships, so the
 * dense variants of the four real states go here instead of growing the
 * synthetic ones.
 *
 * Every dense story pins `1111-900`. Under `layout: padded` the canvas sheds
 * 32px, so that renders a 1079px track — the width the defect was REPORTED at,
 * the Sessions strip's measured track at the old 1380px window. Not the launch
 * track any more: the default is 1400 and its measured track is 1099, which sits
 * in the same band, so the rendered regime is unchanged (#4445 review). A wider
 * viewport hands every card enough room that no label wraps and the story would
 * render green while showing none of the risk it claims to show.
 *
 * ISS-5366 retired `summary-strip-density`, so these no longer mount a flag
 * decorator: the row resolves compact from the width alone, and pinning that
 * width IS the setup. The stories are unchanged in what they render.
 */

/** The reported 1079px desktop track, once `layout: padded` sheds its 32px. */
const REPORTED_TRACK_VIEWPORT = { viewport: { value: "1111-900" } };

/**
 * A desktop-shaped connect target (a HANDLER, never an href — an in-app link
 * there is the FEA-3280 dead click), so the gated stories render the affordance
 * with its CONTROL rather than the handler-less degrade. Declared above the
 * stories that read it: a story object evaluates its `args` at module load, so
 * a bottom-of-file const would be in the temporal dead zone.
 */
const STORY_CONNECT_TARGET: GitHubConnectTarget = {
  action: GitHubConnectAction.Connect,
  onConnect: () => {
    // Presentational only: the story renders the affordance, it does not run
    // the connect handoff.
  },
};

/**
 * The track the desktop app ACTUALLY launches into: 1099px, once `layout:
 * padded` sheds its 32px from a 1131px canvas.
 *
 * ISS-5366 (stage review). The stories above pin 1079 (the width the density
 * defect was reported at) and `summary-card-row.stories.tsx` pins 1150 (the
 * middle of the trigger-orphan band), so neither renders the width people
 * actually open the app at. That gap is how the orphan band came to be described
 * as sitting "above the launch track" when the launch track is inside it — five
 * compact cards over 1099 are `(1099 - 4 * 16) / 5 = 207px`, and the band is
 * 205.8 to 224.8. Derived from `DEFAULT_WINDOW_WIDTH` in
 * `apps/desktop/src/shared/window-defaults.ts` (1400, less the 16rem rail, the
 * page inset and the renderer's scrollbar).
 */
const LAUNCH_TRACK_VIEWPORT = { viewport: { value: "1131-900" } };

/**
 * `Default`, dense. The baseline for every story below: five cards on one rank
 * at the reported track, with the production captions and the Cost card's info
 * trigger — the two things the synthetic stories dropped.
 */
export const DenseDefault: Story = {
  globals: REPORTED_TRACK_VIEWPORT,
  name: "Dense: default, at the reported 1079px track",
};

/**
 * THE SHIPPED DEFAULT — the first Sessions screen a fresh desktop install paints.
 *
 * Five compact cards at 207px each. Read the Cost card's label. 207px sits inside
 * the trigger-orphan band (205.8 to 224.8px card widths), where
 * "cost" fits one line but its info trigger does not fit after
 * it — so until ISS-5070 item 5 landed, the glyph dropped alone onto line two,
 * flush under the label. This story exists because the two stories that bracket
 * it — 1079 below, 1150 above — let that look like a width someone had to go
 * hunting for, when it is the width the app opens at.
 *
 * The web shell lands in the same band at a 1440px viewport (~215px cards), so
 * this is both surfaces' default, not one platform's quirk.
 *
 * It now reads "Non-subscription" / "Cost ⓘ": `MetricCard` wraps its label and
 * trigger in a nowrap island that `SummaryCardRow` flips to `inline`, so the
 * glyph travels with the last word. Same two lines, same 32px label reservation,
 * same shared value baseline across the rank — the band was never load-bearing,
 * which is why the fix could land without a containerised visual pass, and why
 * leaving it as the shipped default was not worth defending either.
 */
export const DenseLaunchTrack: Story = {
  globals: LAUNCH_TRACK_VIEWPORT,
  name: "Dense: the real 1099px desktop launch track",
};

/**
 * `Loading`, dense — and the story that shows ISS-5070 item 3 CLOSED.
 *
 * The skeleton used to be five bare slabs at a hardcoded `h-[124px]` that did
 * not move with density, so the strip settled the moment the data landed, at
 * every width the tier picks compact — which includes the launch width, and so
 * every first load. Retuning that literal would have needed a measurement of a
 * live dense card in the BUILT renderer that neither jsdom nor a story can make.
 *
 * So the literal is gone instead of retuned: the slots are real `MetricCard`
 * shells in their `loading` state, which take the card's own padding, caption
 * reservation and label line box at whatever density the row resolves. Render
 * this beside `DenseDefault` — the two should agree on height, and that is the
 * whole assertion. Nothing left to keep in sync.
 */
export const DenseLoading: Story = {
  args: { isLoading: true },
  globals: REPORTED_TRACK_VIEWPORT,
  name: "Dense: loading (the skeleton IS the card)",
};

/**
 * `ReadFailed`, dense. The error dim the synthetic stories had no way to show:
 * every value collapses to the neutral em-dash and the delivery cards drop to
 * half opacity while KEEPING their labels and info popovers, so a dimmed card at
 * the tighter interior still has to read as "couldn't load this" rather than as
 * a confirmed zero.
 */
export const DenseReadFailed: Story = {
  args: { isError: true, usage: undefined },
  globals: REPORTED_TRACK_VIEWPORT,
  name: "Dense: read failed",
};

/**
 * `LocalFallback`, dense — the longest captions the strip ships. The
 * always-available cards swap their filter-scope caption for a provenance one,
 * which is where a composed caption takes a second line at the compact floor and
 * the `min-h-10` reservation stops being decorative.
 */
export const DenseLocalFallback: Story = {
  args: {
    isError: true,
    usage: undefined,
    localUsage: splitUsageFixture(),
  },
  globals: REPORTED_TRACK_VIEWPORT,
  name: "Dense: local fallback",
};

/**
 * SIGNED OUT — the priority state, and the one ISS-5070 item 2 raised as most
 * breaking the one-band reading.
 *
 * ISS-7866 is what makes it worth re-reading. `DeliveryMetricCard` now puts the
 * shared `ConnectGitHubIndicator` — the `card` variant, a link-styled
 * "Connect GitHub" and nothing else — into the CAPTION slot, over a withdrawn
 * value. That slot used to carry an icon, a wrapped sign-in sentence and an `sm`
 * Button: roughly three lines plus a 32px control at the compact floor's ~168px
 * interior, while its neighbours carried a single 19px caption. The caption
 * reservation is a FLOOR, not a clamp, so those two cards set the rank's height
 * and the four beside them carried the difference. Whether they still do is the
 * thing to look at here.
 *
 * It is also the DESKTOP DEFAULT before sign-in, so it is the first thing a new
 * desktop user sees — not an edge case.
 */
export const SignedOut: Story = {
  args: { authenticated: false, githubConnect: STORY_CONNECT_TARGET },
  name: "Signed out",
};

/** The same signed-out strip, dense, at the reported 1079px track. */
export const DenseSignedOut: Story = {
  args: { authenticated: false, githubConnect: STORY_CONNECT_TARGET },
  globals: REPORTED_TRACK_VIEWPORT,
  name: "Dense: signed out (the state that most strains the band)",
};

/**
 * Signed out with NO connect target, dense — a host with no connect entry point.
 * The affordance degrades to the explanation sentence and no control, the one
 * card layout that still speaks a sentence. Rendered beside `DenseSignedOut`
 * because the pair is the actual trade: a card that can offer the fix stays the
 * height of a live card, and a card that cannot pays a wrapped line to say why
 * it is dark. Neither story shows that on its own.
 */
export const DenseSignedOutWithoutConnectTarget: Story = {
  args: { authenticated: false, githubConnect: undefined },
  globals: REPORTED_TRACK_VIEWPORT,
  name: "Dense: signed out, no connect target",
};

/**
 * ISS-5315 — the "vs. prior" comparison, all three states it can be in, because
 * only the geometry shows whether a signed chip, a caption, and a detail line
 * can share one ~124px card without crowding.
 *
 * A comparing surface (the web Sessions page) with a landed prior read: Sessions
 * carries a graded chip (up is better) and Total Tokens a NEUTRAL one — a rise
 * in token volume is not a win, and it must not be tinted like one beside the
 * Cost card. Both chips share the caption naming the window compared against.
 */
export const PeriodComparison: Story = {
  args: {
    deltas: {
      label: "vs. prior 30 days",
      sessions: { delta: 24, deltaPolarity: MetricPolarity.HigherIsBetter },
      tokens: { delta: 61, deltaPolarity: MetricPolarity.Neutral },
    },
  },
};

/** A decline: the same chip, graded the other way, with the caption unchanged. */
export const PeriodComparisonDown: Story = {
  args: {
    deltas: {
      label: "vs. prior 7 days",
      sessions: { delta: -18, deltaPolarity: MetricPolarity.HigherIsBetter },
      tokens: { delta: -9, deltaPolarity: MetricPolarity.Neutral },
    },
  },
};

/**
 * FEA-4202 — the strip with the `grid-table-v2` comparison slice ON, which is
 * the only way to see the flag-ON row without an authenticated app.
 *
 * Two things change together and both need the geometry to be believed. The
 * caption becomes the CADENCE (`MoM`, from the same `GROWTH_LABEL` map the
 * Insights overview captions its KPI deltas with): the previous
 * "better vs. prior 30 days" wraps to a second line at the compact card width,
 * and "better MoM" does not. And `PRs Shipped` joins the comparing cards, so
 * four of the five carry a chip.
 *
 * The fifth, `LOC / $`, carries the shared "No comparison" placeholder rather
 * than a chip or a hollow slot: the prior window's spend is read too late in the
 * request to reach the delivery pass (ISS-6398), so there is no honest movement to
 * grade — and rather than leave
 * the row ending on an empty footer, the placeholder states that and explains
 * itself in a tooltip.
 */
export const PeriodComparisonCadence: Story = {
  args: {
    deltas: {
      // The rollout gate, carried on the render contract itself: the delivery
      // pair only joins the comparison when the host says so, which is what
      // keeps the flag-OFF stories above free of the "No comparison" footer.
      deliveryCompared: true,
      label: "MoM",
      prsShipped: { delta: 33, deltaPolarity: MetricPolarity.HigherIsBetter },
      sessions: { delta: 24, deltaPolarity: MetricPolarity.HigherIsBetter },
      tokens: { delta: 61, deltaPolarity: MetricPolarity.Neutral },
    },
  },
  name: "Period comparison: cadence caption (FEA-4202)",
};

/**
 * The same flag-ON row at the DENSE track — the width a fresh desktop install
 * opens at, and the one where the caption's line count actually decides the
 * card height. This is the story that would catch a future caption change
 * regressing the strip back to a wrapped two-line delta row.
 */
export const DensePeriodComparisonCadence: Story = {
  args: PeriodComparisonCadence.args,
  globals: REPORTED_TRACK_VIEWPORT,
  name: "Dense: period comparison, cadence caption (FEA-4202)",
};

/**
 * FEA-4202 — the flag-ON row where `PRs Shipped` has a live count but its
 * comparison was declined (an empty prior window, which the producer sends as
 * `null`, or a movement past the ±999% ceiling that a small integer count
 * clears easily). Both delivery cards then show "No comparison", and neither
 * borrows the "No prior period" wording beside them: on a bounded range that
 * period exists and was read, so saying otherwise would be false.
 */
export const PeriodComparisonDeliveryDeclined: Story = {
  args: {
    deltas: {
      deliveryCompared: true,
      label: "WoW",
      sessions: { delta: 12, deltaPolarity: MetricPolarity.HigherIsBetter },
      tokens: { delta: 4, deltaPolarity: MetricPolarity.Neutral },
    },
  },
  name: "Period comparison: delivery comparison declined (FEA-4202)",
};

/**
 * A comparing surface on a range that HAS no prior period ("All time"), or whose
 * prior read has not landed. The placeholder fills the SAME slot the chip would,
 * so the row's height does not move between the two states — and it says which
 * state the reader is in rather than leaving a silent gap.
 *
 * Contrast with {@link Default}, which is a surface that does not compare at all
 * (the desktop Sessions view): it passes no `deltas` and shows neither a chip
 * nor a placeholder, because "No prior period" there would imply a comparison
 * that is never coming.
 */
export const NoPriorPeriod: Story = {
  args: { deltas: { label: null } },
};

/**
 * ISS-5401 — the reported cohort: 6,535 sessions, 1.26B tokens, and not one
 * dollar in any of the five cost figures. The strip used to read
 * `6,535 · 1.26B · $0 · …`, which made "we have no cost for these" and "these
 * cost nothing" the same pixels. The Cost tile now dashes and says why.
 *
 * This is the DESKTOP rendering — that surface passes no `deltas`, so the tile
 * is the dash plus the reason caption and nothing else. The point of the story
 * is how that reads BESIDE four rowmates carrying real numbers, which an
 * isolated `CostMetricCard` story cannot show.
 */
export const UnpricedCohort: Story = {
  args: {
    usage: splitUsageFixture({
      totalSessions: 6535,
      totalInputTokens: 620_000_000,
      totalOutputTokens: 640_000_000,
      totalEstimatedCost: 0,
      subscriptionEstimatedCost: 0,
      apiEstimatedCost: 0,
      meteredEstimatedCost: 0,
      unknownEstimatedCost: 0,
    }),
  },
};

/**
 * ISS-5401 on a comparing surface (the web Sessions page). The rowmates keep
 * their movement chips; the Cost tile drops its delta slot entirely rather than
 * grading a change in a value it just declined to state, or borrowing the
 * rowmates' "No prior period" — its prior period exists, and saying otherwise
 * would stack a second unsubstantiated claim under the dash.
 */
export const UnpricedCohortWithComparison: Story = {
  args: {
    ...UnpricedCohort.args,
    deltas: {
      label: "vs. prior 30 days",
      sessions: { delta: 12, deltaPolarity: MetricPolarity.HigherIsBetter },
      totalCost: { delta: -40, deltaPolarity: MetricPolarity.LowerIsBetter },
    },
  },
};
