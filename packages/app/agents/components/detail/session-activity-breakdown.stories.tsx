import type {
  ActivitySegment,
  AgentSessionDetail,
} from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { activitySegmentFixture } from "./__tests__/activity-segment-fixtures";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { SessionActivityBreakdown } from "./session-activity-breakdown";

/**
 * The SES-78747 values behind the ISS-5000 finding. Independently rounded these
 * render $24.79 + $3.40 + $3.25 + $0.00 + $1.40 = $32.84 under a $32.86 header —
 * sub-cent tails are the shape of real token-priced spend, which is why clean
 * fixtures never surfaced the drift.
 */
const SUB_CENT_SEGMENTS: ActivitySegment[] = [
  activitySegmentFixture({
    key: "review",
    costUsd: 24.7949,
    durationMs: 1_320_000,
  }),
  activitySegmentFixture({
    key: "implement",
    costUsd: 3.4049,
    durationMs: 1_140_000,
  }),
  activitySegmentFixture({
    key: "validate",
    costUsd: 3.2549,
    durationMs: 720_000,
  }),
  activitySegmentFixture({ key: "idle", costUsd: 0, durationMs: 1_200_000 }),
  activitySegmentFixture({
    key: "explore",
    costUsd: 1.4049,
    durationMs: 600_000,
  }),
];

/**
 * The same phases with pricing dropped: real durations, every per-phase cost 0.
 * This is NOT a free session — it is one the pricing pipeline could not cost —
 * so the panel must say so rather than render a column of $0.00.
 */
const UNPRICED_SEGMENTS: ActivitySegment[] = SUB_CENT_SEGMENTS.map((segment) =>
  activitySegmentFixture({
    key: segment.key,
    costUsd: 0,
    durationMs: segment.durationMs,
  })
);

/** A deliberately long phase label, to pressure the flexible Phase track. */
const LONG_LABEL_SEGMENTS: ActivitySegment[] = [
  activitySegmentFixture({
    key: "review",
    label: "Reviewing the generated implementation plan against the PRD",
    costUsd: 12.5049,
    durationMs: 2_400_000,
  }),
  activitySegmentFixture({
    key: "implement",
    costUsd: 6.2549,
    durationMs: 1_800_000,
  }),
  activitySegmentFixture({ key: "idle", costUsd: 0, durationMs: 900_000 }),
];

function sessionWith(
  activitySegments: ActivitySegment[],
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  return createAgentSessionDetailFixture({ activitySegments, ...overrides });
}

/**
 * ISS-5128: the production shape — segments priced over fewer token events than
 * the session's own cost rollup covered. The segments are real; they are simply
 * not the whole session's spend.
 */
const PARTIALLY_ATTRIBUTED_SEGMENTS: ActivitySegment[] = [
  activitySegmentFixture({
    key: "implement",
    costUsd: 3.2,
    durationMs: 900_000,
  }),
  activitySegmentFixture({ key: "review", costUsd: 1.26, durationMs: 300_000 }),
];

/**
 * ISS-5564: the reported shape — the phase holding most of the money reads
 * `Conf. 0%`, so the panel asserts a precise dollar attribution and, one column
 * over, admits no confidence in the classification those dollars are grouped
 * under. The footer sentence exists to resolve that pair.
 */
const ZERO_CONFIDENCE_SEGMENTS: ActivitySegment[] = [
  activitySegmentFixture({
    key: "other",
    costUsd: 24.79,
    durationMs: 1_320_000,
    confidence: 0,
    inputTokens: 331_900,
  }),
  activitySegmentFixture({
    key: "implement",
    costUsd: 3.4,
    durationMs: 1_140_000,
    confidence: 0.94,
    inputTokens: 80_400,
  }),
  activitySegmentFixture({
    key: "explore",
    costUsd: 1.4,
    durationMs: 600_000,
    confidence: 0.7,
    inputTokens: 41_200,
  }),
];

/** The same money with every phase confidently classified — the contrast case. */
const CONFIDENT_SEGMENTS: ActivitySegment[] = ZERO_CONFIDENCE_SEGMENTS.map(
  (segment, index) =>
    activitySegmentFixture({
      key: index === 0 ? "review" : segment.key,
      costUsd: segment.costUsd,
      durationMs: segment.durationMs,
      confidence: index === 0 ? 0.91 : segment.confidence,
      inputTokens: segment.inputTokens,
    })
);

/**
 * A long phase list that also carries a zero-confidence priced row, for the
 * stacked-footer case: this is the only fixture where the confidence sentence
 * has to sit beside the share-basis and unattributed-residual sentences at
 * once.
 */
const LONG_ZERO_CONFIDENCE_SEGMENTS: ActivitySegment[] = [
  ...ZERO_CONFIDENCE_SEGMENTS,
  activitySegmentFixture({
    key: "validate",
    costUsd: 3.25,
    durationMs: 720_000,
    confidence: 0.62,
    inputTokens: 22_800,
  }),
  activitySegmentFixture({
    key: "review",
    costUsd: 2.11,
    durationMs: 480_000,
    confidence: 0,
    inputTokens: 18_300,
  }),
  activitySegmentFixture({ key: "idle", costUsd: 0, durationMs: 1_200_000 }),
];

/**
 * ISS-5564's gate. The panel's other stories all render an ungated surface, so
 * this decorator is the only thing that makes the sentence reachable in
 * Storybook. It nests inside the app-core harness the preview mounts globally
 * (ISS-5665), and the inner provider is the one the hook reads.
 */
const withPhaseConfidenceDisclosure: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

/**
 * Breaks one agent session down by phase, showing tokens, cost and duration
 * for each, for when you want totals by phase rather than the timeline's
 * events in order.
 */
const meta = {
  title: "Surfaces/Session Activity Breakdown",
  component: SessionActivityBreakdown,
  tags: ["autodocs"],
  argTypes: {
    session: {
      control: "object",
      description:
        "Detail projection. Only activitySegments and the session cost rollup reach this panel.",
    },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionActivityBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default priced breakdown, flag OFF — each Cost cell rounds to cents on its
 * own, so the column sums to $32.84 under a $32.86 header. This is the filed
 * ISS-5000 defect, kept as a story because a one-cent gap is the kind of thing
 * that only looks wrong beside its corrected twin below.
 */
export const PricedIndependentRounding: Story = {
  args: { session: sessionWith(SUB_CENT_SEGMENTS) },
};

/**
 * The same data with the gate ON: the cents are allocated across the rows
 * (largest-remainder), so the column adds up to the header exactly. Compare the
 * Cost column against the figure at the panel's top-right in both stories.
 */
export const PricedReconciled: Story = {
  args: { session: sessionWith(SUB_CENT_SEGMENTS) },
};

/**
 * Cost unavailable: every Cost cell is an em dash and the header is labelled
 * "session total" — because in this mode it is the session's own rollup, NOT the
 * sum of the column beneath it. Awkward to reach in the running app (you need a
 * session whose pricing was dropped), which is most of the argument for pinning
 * it here.
 */
export const CostUnavailable: Story = {
  args: {
    session: sessionWith(UNPRICED_SEGMENTS, { estimatedCost: 32.86 }),
  },
};

/**
 * A truncated session: `activitySegments` is a start-ordered PREFIX, so the
 * header covers only the retained phases. The footer says so, and the cost
 * reconciliation is deliberately SKIPPED here — making a partial decomposition
 * add up exactly would present it as a complete one, next to a higher session
 * cost in the Properties strip.
 */
export const PricedTruncated: Story = {
  args: {
    session: sessionWith(SUB_CENT_SEGMENTS, {
      activitySegmentRowsTruncated: true,
    }),
  },
};

/**
 * A long phase label against the flexible Phase track, with the fixed numeric
 * columns beside it — the layout case the five-column grid is most likely to
 * break on, and one that needs specific attribution data to reproduce live.
 */
export const LongPhaseLabel: Story = {
  args: { session: sessionWith(LONG_LABEL_SEGMENTS) },
};

/**
 * ISS-5128, the defect: a PARTIALLY attributed session with the gate OFF. Only
 * $4.46 of a $508.75 session is covered by the priced segments, and the panel heads
 * itself with that attributed slice — a 114x understatement of a figure the
 * Properties strip on the same screen reports correctly. Nothing on screen says
 * anything is missing, which is the whole complaint.
 */
export const PartiallyAttributedUnreconciled: Story = {
  args: {
    session: sessionWith(PARTIALLY_ATTRIBUTED_SEGMENTS, {
      estimatedCost: 508.75,
    }),
  },
};

/**
 * The same session with the gate ON: the unattributed remainder becomes its own
 * named row, so the header reconciles with the session cost AND stays the exact
 * sum of the column. Its Time and Tokens cells read as a dash rather than "0s"
 * and "0" (#4395 review): the residual has no attributable span, and a zero
 * there would be a measurement the panel never took. The footer now carries the
 * sentence that explains the row. Compare the header against its twin above.
 *
 * This is ALSO the dominant-residual case: $504.29 of $508.75 sits in that one
 * row, 99% of the column. Its twin below is the same panel with a scrap
 * remainder, and the pair is the comparison behind the call recorded on
 * {@link PartiallyAttributedScrapResidual}.
 */
export const PartiallyAttributedReconciled: Story = {
  args: {
    session: sessionWith(PARTIALLY_ATTRIBUTED_SEGMENTS, {
      estimatedCost: 508.75,
    }),
  },
};

/**
 * The other end of the range: a scrap residual, $0.32 against $32.86 of real
 * phases. Same row, same muted phase name, 1% of the column instead of 99%.
 *
 * THE CALL (#4395 review asked whether the muted name still holds at 99%): it
 * stays muted, at both ends. The mute marks what the row IS, an
 * `isUnclassified` bucket rather than a phase the classifier named, and that is
 * equally true of $0.32 and $504.29. Scaling it with the amount would put the
 * row's appearance on a threshold no one can defend and make the same session
 * restyle itself as its data drifts across it.
 *
 * The 99% case does need the eye pulled to it, and it gets that from the two
 * things that carry weight in this panel already. The Cost and share cells are
 * `font-medium` and never muted, so at 99% they read $504.29 and 99% at full
 * strength, and the footer sentence names the row in prose. Muting a NAME while
 * its money shouts is the hierarchy this panel wants.
 */
export const PartiallyAttributedScrapResidual: Story = {
  args: {
    session: sessionWith(SUB_CENT_SEGMENTS, { estimatedCost: 33.18 }),
  },
};

/**
 * ISS-5564 with the gate ON: the top phase reads `Conf. 0%` while holding $24.79
 * of the column, and the footer carries the sentence that resolves the pair —
 * confidence is about the phase NAME, the money is measured either way.
 *
 * Added on review: the unit spec asserts the sentence's text, which cannot see
 * whether it reads cleanly as a footer. This is the story that shows it as
 * prose next to the numbers it is talking about, and it is the panel's local
 * convention (one story per footer state) that the sentence had skipped.
 */
export const PhaseConfidenceDisclosure: Story = {
  args: { session: sessionWith(ZERO_CONFIDENCE_SEGMENTS) },
  decorators: [withPhaseConfidenceDisclosure],
};

/**
 * The contrast: the gate is still ON, but every phase is confidently classified,
 * so there is no contradiction to explain and the sentence must NOT appear. Read
 * beside its twin above, this is what stops the caveat becoming permanent
 * furniture on sessions that never earned it.
 */
export const PhaseConfidenceAllConfident: Story = {
  args: { session: sessionWith(CONFIDENT_SEGMENTS) },
  decorators: [withPhaseConfidenceDisclosure],
};

/**
 * The stacked-footer case, which is the layout risk an assertion-only test
 * cannot reach: a longer phase list, TWO zero-confidence priced rows, and a
 * session cost above the attributed total so the unattributed residual row
 * appears. All three footer sentences — share basis, residual, and the new
 * confidence basis — render together here, which is the only place their
 * stacking and reading order can be judged.
 */
export const PhaseConfidenceStackedFooters: Story = {
  args: {
    session: sessionWith(LONG_ZERO_CONFIDENCE_SEGMENTS, {
      estimatedCost: 42.5,
    }),
  },
  decorators: [withPhaseConfidenceDisclosure],
};
