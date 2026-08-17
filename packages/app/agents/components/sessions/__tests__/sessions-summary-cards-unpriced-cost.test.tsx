/**
 * ISS-5401 — the Sessions Cost tile must never present an uncomputable cost as a
 * measured `$0`.
 *
 * The reported signature is a metric strip reading `6,535 · 1.26B · $0 · 1,445 ·
 * 89`: 1.26 billion tokens beside a confident zero, with no "+$X if billed to
 * API" line to explain it. Nothing was metered, nothing was subscription-covered,
 * nothing was unclassified — nothing was priced. The formatter and the pricing
 * engine were both already honest (`formatCurrencyTileValue` dashes on `null`,
 * `genai-cost` refuses with `null` rather than a lying zero); every aggregation
 * step between them folded that `null` to `0`, so the honest branch was
 * unreachable for any settled read.
 *
 * A sibling file rather than more cases in `sessions-summary-cards.test.tsx` (a
 * whole-row suite at the 1,000-line ceiling) or in
 * `sessions-summary-cards-cost-honesty.test.tsx` (which owns the ISS-4773
 * metered/subscription/unknown SPLIT, a different question from whether anything
 * could be priced at all).
 *
 * The three states these cases keep apart are exactly the three the defect
 * conflated: a genuine zero, a cohort nothing could be priced for, and a
 * partially-priced cohort.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { SessionSummaryDeltas } from "@repo/app/agents/lib/session-summary-deltas";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_LABEL,
  SESSIONS_COST_NO_COST_RECORDED_DETAIL,
} from "../cost-metric-card";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import {
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
} from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/** The whole-dollar zero the tile must stop fabricating. */
const FABRICATED_ZERO = "$0";
/** FEA-4231's subscription caption, the tell that the cohort WAS priced. */
const IF_BILLED_TO_API_PATTERN = /\+\$\d[\d,]* if billed to API/;
/**
 * The card-local caption strings, inlined the way the sibling suites
 * (`sessions-summary-cards.test.tsx`, the desktop `sessions-view-cloud-mode`
 * suite) already assert them — they are module-private to the component, and
 * exporting them purely for tests would widen a file already at its size
 * ceiling.
 */
const LOCAL_FALLBACK_DETAIL = "From local history";
const NO_PRIOR_PERIOD_TEXT = "No prior period";
/**
 * Total Tokens, and only it. The delta fixture gives Sessions a movement (so it
 * renders a chip, not the placeholder) and gives Tokens none (so it renders the
 * placeholder truthfully — its prior period exists and simply carried no
 * change). The Cost tile must not become a second: its value dashed, which is a
 * different fact from having no prior period, so its slot is dropped instead.
 */
const TILES_SHOWING_NO_PRIOR_PERIOD = 1;
/** `formatDeltaPct` output for the two movements the delta fixture carries. */
const SESSIONS_DELTA_TEXT = "+12%";
const COST_DELTA_TEXT = "-40%";
/**
 * The honest-empty glyph every dashed tile renders (`KPI_NO_VALUE`). Inlined
 * rather than imported for the same reason the caption strings above are: the
 * assertion is on what a reader SEES, so re-deriving it from the module under
 * test would pass against a changed glyph.
 */
const NO_VALUE_GLYPH = "—";
/**
 * Sessions, Total Tokens and Cost — the three tiles that render for every
 * viewer regardless of the cloud read, and so the three that must agree on how
 * a failed read looks. `PRs Shipped` and `LOC / $` are the delivery pair, which
 * carry their own (dimmed + "Unavailable") error treatment, so they are
 * deliberately not in this set.
 */
const ALWAYS_AVAILABLE_TILE_LABELS = [
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_LABEL,
] as const;

/**
 * A period comparison whose presence declares "this surface compares periods".
 * Carries a movement for BOTH the Sessions tile (which must keep its chip) and
 * the Cost tile (which must lose it once its headline dashes).
 */
const UNPRICED_COHORT_DELTAS: SessionSummaryDeltas = {
  label: "vs. prior 30 days",
  sessions: { delta: 12, deltaPolarity: MetricPolarity.HigherIsBetter },
  apiCost: { delta: -40, deltaPolarity: MetricPolarity.LowerIsBetter },
};

/**
 * The reported cohort: 6,535 sessions, 1.26B tokens, and not one dollar in any
 * of the five cost figures. Token totals are real because the sessions really
 * ran; the costs are zero because nothing could be priced.
 */
function unpricedCohortFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 6535,
      totalInputTokens: 620_000_000,
      totalOutputTokens: 640_000_000,
      totalEstimatedCost: 0,
      subscriptionEstimatedCost: 0,
      apiEstimatedCost: 0,
      ...overrides,
    }
  );
}

describe("SessionsSummaryCards — uncomputable cost (ISS-5401)", () => {
  it("dashes the Cost tile, and says why, when a token-consuming cohort priced nothing", () => {
    render(
      <SessionsSummaryCards isLoading={false} usage={unpricedCohortFixture()} />
    );

    // The tile is still the Sessions Cost tile (ISS-4401's per-surface label) —
    // it dropped its VALUE, not its identity.
    expect(
      screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    // The defect: 1.26B tokens rendered beside a confident zero.
    expect(screen.queryByText(FABRICATED_ZERO)).toBeNull();
    // The caption names the reason. An uncaptioned dash is indistinguishable
    // from the failed-read dash its rowmates show.
    expect(
      screen.getByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeInTheDocument();
  });

  it("keeps a genuine $0 for a cohort that consumed nothing", () => {
    // State one of three. No tokens means no usage that SHOULD have been priced,
    // so zero is a measured fact, not a gap — and the tile must keep saying so
    // rather than dashing every empty filter result.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          totalSessions: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        })}
      />
    );

    expect(screen.getByText(FABRICATED_ZERO)).toBeInTheDocument();
    expect(
      screen.queryByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeNull();
  });

  it("keeps the real subtotal for a partially-priced cohort", () => {
    // State three. Some of the cohort priced, so the headline is a real figure —
    // proving the dash is gated on "nothing priced", not applied to any cohort
    // that merely LOOKS cheap next to its token count.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          totalEstimatedCost: 30,
          apiEstimatedCost: 30,
        })}
      />
    );

    expect(screen.getByText("$30")).toBeInTheDocument();
    expect(
      screen.queryByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeNull();
  });

  it("dashes a subscription-covered cohort that priced nothing, the branch the $70 case never reaches", () => {
    // Stage review on #4667: the near-miss case below pins
    // `subscriptionEstimatedCost: 70` — the PRICED subscription cohort — so it
    // never exercises the branch where a cohort is subscription-covered AND
    // nothing in it could be priced. That branch is the one the predicate's
    // KNOWN LIMIT 2 accepts a same-screen disagreement for: the Cost COLUMN
    // renders `$0.00` for these rows (`deriveCostAvailability` reaches its
    // Subscription branch before it asks whether anything was priced), while
    // the tile declines to state a figure. The trade is deliberate, so it is
    // pinned here rather than left to be rediscovered as a surprise — and this
    // is the case that fails if someone "fixes" the divergence by exempting
    // subscription-covered cohorts from the dash.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          // Every figure zero, including the subscription ledger: the cohort was
          // subscription-covered and its API-equivalent price never computed.
          subscriptionEstimatedCost: 0,
          meteredEstimatedCost: 0,
          unknownEstimatedCost: 0,
        })}
      />
    );

    expect(screen.queryByText(FABRICATED_ZERO)).toBeNull();
    expect(
      screen.getByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeInTheDocument();
    // ...and no "+$X if billed to API" line, because there is no subscription
    // figure to caption — the disclosure clause has nothing to disclose.
    expect(screen.queryByText(IF_BILLED_TO_API_PATTERN)).toBeNull();
  });

  it("keeps the honest $0 headline for a fully subscription-covered cohort", () => {
    // The near-miss this must not swallow: `apiEstimatedCost` is legitimately
    // zero because every session was subscription-covered. The spend is real, it
    // just is not out-of-pocket — and the existing caption already explains it.
    // Dashing here would delete a true zero and a true caption.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          totalEstimatedCost: 70,
          subscriptionEstimatedCost: 70,
        })}
      />
    );

    expect(screen.getByText(FABRICATED_ZERO)).toBeInTheDocument();
    expect(screen.getByText(IF_BILLED_TO_API_PATTERN)).toBeInTheDocument();
    expect(
      screen.queryByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeNull();
  });

  it("counts cached tokens as usage that should have been priced", () => {
    // The four token counters are checked, not just input+output: a cohort whose
    // work was served from cache still consumed usage a pricing engine owes a
    // figure for. The Total Tokens tile beside it sums only input+output, so this
    // is the case where the two tiles legitimately disagree about "empty".
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 4_000_000,
        })}
      />
    );

    expect(screen.queryByText(FABRICATED_ZERO)).toBeNull();
    expect(
      screen.getByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeInTheDocument();
  });

  it("degrades to the shipped presentation when a version-skewed producer sends money in one figure only", () => {
    // Cross-repo compatibility: an older producer can populate a figure whose
    // siblings this build expects. One non-zero figure anywhere proves pricing
    // worked for part of the cohort, so the tile must not dash on the zeros
    // around it.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          totalEstimatedCost: undefined as unknown as number,
          unknownEstimatedCost: 12,
        })}
      />
    );

    expect(
      screen.queryByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeNull();
    expect(screen.getByText(FABRICATED_ZERO)).toBeInTheDocument();
  });

  it("will not call a cohort unpriced while its grand total is unreadable", () => {
    // wongk review on #4667: `null` and `0` are not the same fact. With tokens
    // consumed, the remaining figures at zero, and `totalEstimatedCost` absent
    // on the wire (typed `number`, but nothing parses either producer's
    // payload), the cohort's REQUIRED total is unknown — so "No cost recorded"
    // would be the same fabrication as `$0`, pointed the other way. An
    // uninterpretable payload degrades to the shipped presentation, which is
    // this module's standing rule for a producer it cannot read.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          totalEstimatedCost: null as unknown as number,
        })}
      />
    );

    expect(
      screen.queryByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeNull();
  });

  // NOTE, deliberately not a case: the negative-sibling half of the same review
  // (`subscriptionEstimatedCost: -5`) is behaviour-NEUTRAL. Both the old code
  // and the new refuse the dash for it — the old via `isNonZeroCostFigure`
  // counting `-5` as money, the new via the interpretability guard rejecting it
  // as corruption — so a test over it passes identically with the guard
  // disabled. Verified by running exactly that counterfactual. The guard still
  // changed for the reason wongk gave (one module must not give two answers
  // about one figure, cf. `isReportableCostValue`), but a case that cannot fail
  // is worse than no case, so this stays a comment.
  it("will not spend a corrupt token counter on a confident $0", () => {
    // wongk review: `hasMeasuredTokenUsage` used to ask only "is any counter
    // positive", so a payload carrying `-1` input tokens and zeros elsewhere
    // read as "this cohort consumed nothing" — the genuine-empty branch — and
    // was handed back the exact `$0` this ticket removes. A corrupt counter is
    // not a measured empty cohort; it is no measurement at all. Only real,
    // finite, non-negative zeros may claim the empty branch, so this payload
    // falls through to the cost check and dashes.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          totalInputTokens: -1,
          totalOutputTokens: 0,
        })}
      />
    );

    expect(screen.queryByText(FABRICATED_ZERO)).toBeNull();
    expect(
      screen.getByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeInTheDocument();
  });

  it("leaves the loading tile skeletoned rather than captioning a dash it has no payload for", () => {
    // An unsettled read is "not known yet", never "unpriceable". The reason
    // caption would be a claim about a cohort that has not arrived.
    render(<SessionsSummaryCards isLoading usage={undefined} />);

    expect(
      screen.queryByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeNull();
  });

  it("ignores a null cost figure on the wire when a sibling figure carries real money", () => {
    // `apiEstimatedCost` is typed non-nullable, but nothing between either
    // producer and this render parses the payload. A `null` must read as "no
    // figure here" — the same as absent — and must not stop a real
    // `subscriptionEstimatedCost` from proving the cohort WAS priced.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={unpricedCohortFixture({
          apiEstimatedCost: null as unknown as number,
          totalEstimatedCost: 70,
          subscriptionEstimatedCost: 70,
        })}
      />
    );

    expect(
      screen.queryByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeNull();
    expect(screen.getByText(IF_BILLED_TO_API_PATTERN)).toBeInTheDocument();
  });

  it("composes the reason onto the local-history provenance instead of replacing it", () => {
    // The desktop path: the cloud read failed and the cards are painting LOCAL
    // totals, which describe a different population. Provenance and reason
    // answer different questions ("where is this number from" vs "why is there
    // no number"), so a dashed local-fallback tile must state both.
    render(
      <SessionsSummaryCards
        isError
        isLoading={false}
        localUsage={unpricedCohortFixture()}
        usage={undefined}
      />
    );

    expect(
      screen.getByText(
        `${LOCAL_FALLBACK_DETAIL} · ${SESSIONS_COST_NO_COST_RECORDED_DETAIL}`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(FABRICATED_ZERO)).toBeNull();
  });

  it("drops the period-delta chip rather than grading a movement in a value it withheld", () => {
    // A signed "-40% better" under a `—` grades a change in a number the card
    // just refused to state. The slot falls back to the same "No prior period"
    // placeholder the rowmates use, so the row's height does not move.
    render(
      <SessionsSummaryCards
        deltas={UNPRICED_COHORT_DELTAS}
        isLoading={false}
        usage={unpricedCohortFixture()}
      />
    );

    // The Sessions tile beside it still grades its own movement, proving the
    // suppression is scoped to the tile that dashed and is not a blanket
    // "deltas off" switch.
    expect(screen.getByText(SESSIONS_DELTA_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(COST_DELTA_TEXT)).toBeNull();
    // ...and it does NOT borrow the rowmates' "No prior period" wording. The
    // prior period exists and its delta was computed; the card declined to grade
    // it for want of a current value. The slot is dropped rather than refilled
    // with a second negation stacked under the dash and the reason caption.
    expect(screen.getAllByText(NO_PRIOR_PERIOD_TEXT).length).toBe(
      TILES_SHOWING_NO_PRIOR_PERIOD
    );
  });

  it("drops the chip when the headline dashes for a reason no withhold flag names", () => {
    // wongk review on #4667: the delta suppression keyed on the three WITHHOLD
    // REASONS (failed read / Unknown facet / unpriceable), but the headline also
    // dashes when the resolved presentation's own figure is unrenderable —
    // `formatCurrencyTileValue` emits "—" for anything nullish or non-finite. A
    // payload with real money in a SIBLING field and a `null` in the field the
    // card actually headlines takes none of the three flags, so a signed "-40%"
    // sat under an unavailable value: a movement graded in a number the card
    // never stated, which is the one thing this suppression exists to prevent.
    //
    // The near-miss sibling case above renders this same payload WITHOUT
    // `deltas`, which is why it could not see the chip. This one supplies them.
    render(
      <SessionsSummaryCards
        deltas={UNPRICED_COHORT_DELTAS}
        isLoading={false}
        usage={unpricedCohortFixture({
          apiEstimatedCost: null as unknown as number,
          totalEstimatedCost: 70,
          subscriptionEstimatedCost: 70,
        })}
      />
    );

    // The tile IS dashing — this payload is not on the unpriceable path (a
    // sibling carries real money), so the case would be vacuous if the headline
    // rendered a figure.
    expect(screen.queryByText(COST_DELTA_TEXT)).toBeNull();
    expect(screen.getAllByText(NO_PRIOR_PERIOD_TEXT).length).toBe(
      TILES_SHOWING_NO_PRIOR_PERIOD
    );
    // The Sessions tile beside it still grades its own movement, so the
    // suppression is scoped to the tile that dashed.
    expect(screen.getByText(SESSIONS_DELTA_TEXT)).toBeInTheDocument();
  });

  it("drops the chip on the pre-existing Unknown-facet dash too, not only the new one", () => {
    // ISS-5401 routes the facet dash (ISS-4481) through the same suppression, so
    // the two paths that render the identical `—` cannot disagree about whether
    // a movement may sit under it. This is a change to already-shipped
    // behaviour, so it gets its own case rather than riding on the new path's.
    render(
      <SessionsSummaryCards
        costUnknownActive
        deltas={UNPRICED_COHORT_DELTAS}
        isLoading={false}
        usage={unpricedCohortFixture({
          totalEstimatedCost: 30,
          apiEstimatedCost: 30,
        })}
      />
    );

    expect(screen.queryByText(COST_DELTA_TEXT)).toBeNull();
    expect(screen.getAllByText(NO_PRIOR_PERIOD_TEXT).length).toBe(
      TILES_SHOWING_NO_PRIOR_PERIOD
    );
  });
});

describe("SessionsSummaryCards — one failed read, one dash treatment (ISS-5401)", () => {
  it("renders the Sessions, Total Tokens and Cost dashes in the same weight and colour", () => {
    // Stage review on #4667: moving the Cost tile onto `MetricCard`'s muted
    // no-data treatment SPLIT the strip. Sessions and Total Tokens handed the
    // primitive a pre-formatted "—" string, which leaves `value` non-null, so
    // `noData` stayed false and their dash painted `font-semibold` at full
    // foreground beside a Cost dash that had gone muted and normal-weight. One
    // failed read, one row, three tiles, two renderings of the identical state.
    //
    // This asserts the TREATMENT, not the glyph — all three already rendered
    // the same em-dash, which is exactly why the defect was invisible to a
    // text-only assertion. Reverting either tile to `value="—"` puts
    // `font-semibold` back on its title and fails here.
    render(
      <SessionsSummaryCards isError isLoading={false} usage={undefined} />
    );

    // Addressed by LABEL, not by scanning for the glyph: the delivery pair
    // (`PRs Shipped`, `LOC / $`) dashes on this same failed read under its own
    // deliberately different dimmed treatment, so a glyph scan would sweep it in
    // and assert the wrong contract over five tiles.
    for (const label of ALWAYS_AVAILABLE_TILE_LABELS) {
      const title = screen
        .getByText(label, { exact: true })
        .closest('[data-slot="card-header"]')
        ?.querySelector('[data-slot="card-title"]');

      expect(title?.textContent).toBe(NO_VALUE_GLYPH);
      expect(title?.className).toContain("text-muted-foreground");
      expect(title?.className).toContain("font-normal");
      expect(title?.className).not.toContain("font-semibold");
    }
  });
});

describe("SessionsSummaryCards — uncomputable cost in honest mode (ISS-5401)", () => {
  it("dashes with the pricing reason rather than the billing-split disclosure", () => {
    // The ISS-4773 honest presentation narrows the headline to
    // `meteredEstimatedCost` and captions the shares it excluded. When NOTHING
    // priced, every one of those shares is zero, so the disclosure has nothing
    // to say and the only fact left is why the headline is a dash. The card
    // keeps its honest LABEL — the basis it reports on has not changed, only
    // its ability to report a figure.
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY],
        })}
      >
        <SessionsSummaryCards
          isLoading={false}
          usage={unpricedCohortFixture({
            meteredEstimatedCost: 0,
            unknownEstimatedCost: 0,
          })}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(
      screen.getByText(SESSIONS_COST_HONEST_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText(FABRICATED_ZERO)).toBeNull();
    expect(
      screen.getByText(SESSIONS_COST_NO_COST_RECORDED_DETAIL)
    ).toBeInTheDocument();
  });
});
