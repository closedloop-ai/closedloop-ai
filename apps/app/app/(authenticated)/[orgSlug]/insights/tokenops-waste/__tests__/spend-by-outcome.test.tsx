import {
  SPEND_OUTCOME_LABELS,
  SPEND_OUTCOME_ORDER,
  SpendOutcome,
} from "@closedloop-ai/loops-api/insights";
import type { SpendOutcomeRow } from "@repo/api/src/types/session-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpendByOutcome } from "../components/spend-by-outcome";
import { WidgetState } from "../components/widget-state";

/**
 * The outcome split (ISS-4988). Raised in review (comment 3709210645): this is
 * the first consumer of the `formattedValue` prop added to `SegmentedBar`, and
 * it deliberately keeps `value` UNROUNDED so a sub-dollar bucket still gets real
 * bar geometry while the legend reads in dollars. That pairing can break from
 * either side and nothing rendered it in isolation.
 *
 * `segmented-bar.stories.tsx` covers the primitive; the page-client suite
 * asserts labels. Neither would catch a legend/geometry mismatch.
 */

/** The caption once the total has actually arrived. */
const CAPTION_WITH_TOTAL = /of session spend in range/i;
/** The caption before/without a total — deliberately names no figure. */
const CAPTION_NO_TOTAL =
  /^Session spend in range, keyed on how each session ended/i;
const UNAVAILABLE_COPY = /the outcome split cannot be shown/i;
const BARE_84 = /^84$/;

/**
 * The WIRE row carries no label — `orderRows` derives it from the canonical
 * `SPEND_OUTCOME_LABELS`, which is the point: the label cannot drift per caller.
 */
function outcomeRow(
  outcome: SpendOutcome,
  usd: number,
  sessions = 2
): SpendOutcomeRow {
  return { outcome, sessions, usd };
}

describe("the spend-by-outcome split", () => {
  it("labels every legend entry in dollars rather than as a bare number", () => {
    render(
      <SpendByOutcome
        outcomes={[
          outcomeRow(SpendOutcome.Clean, 250),
          outcomeRow(SpendOutcome.Errored, 84),
          outcomeRow(SpendOutcome.Unknown, 60),
        ]}
        state={WidgetState.Ready}
        totalSpendUsd={394}
      />
    );

    // The whole point of `formattedValue`: "84" under a section about money
    // reads as a count of something.
    expect(screen.getAllByText("$84").length).toBeGreaterThan(0);
    expect(screen.queryByText(BARE_84)).toBeNull();
  });

  it("keeps a sub-dollar bucket visible instead of rounding it out of the bar", () => {
    render(
      <SpendByOutcome
        outcomes={[
          outcomeRow(SpendOutcome.Clean, 500),
          // Under half a dollar: a pre-rounded `value` would floor this to 0,
          // dropping the segment entirely while the row below still showed it.
          outcomeRow(SpendOutcome.Errored, 0.4),
          outcomeRow(SpendOutcome.Unknown, 0),
        ]}
        state={WidgetState.Ready}
        totalSpendUsd={500.4}
      />
    );

    // A nonzero failed spend must never render as a flat "$0" on a waste
    // screen; the shared formatter widens precision instead.
    expect(screen.getAllByText("$0.40").length).toBeGreaterThan(0);
    // Present in BOTH the legend and the row list below it.
    expect(
      screen.getAllByText(SPEND_OUTCOME_LABELS[SpendOutcome.Errored]).length
    ).toBeGreaterThan(0);
    // The EXACT zero beside it still reads "$0" — that one is true, and the two
    // must stay distinguishable.
    expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
  });

  it("renders every outcome bucket even when the response omits one", () => {
    render(
      <SpendByOutcome
        // The server sent only one bucket; the fixed order must still show all
        // three so a missing bucket reads as zero rather than as absent.
        outcomes={[outcomeRow(SpendOutcome.Errored, 120)]}
        state={WidgetState.Ready}
        totalSpendUsd={120}
      />
    );

    // Iterates the screen's own fixed ORDER rather than every member of the
    // SpendOutcome union: this test asserts "all three buckets still render",
    // and the union also carries `Running`, which this screen's classifier
    // (`outcomeOf`, which folds non-terminal into Unknown) can never produce.
    for (const outcome of SPEND_OUTCOME_ORDER) {
      expect(
        screen.getAllByText(SPEND_OUTCOME_LABELS[outcome]).length
      ).toBeGreaterThan(0);
    }
  });

  it("drops the total from the caption rather than claiming $0 when unavailable", () => {
    const { rerender } = render(
      <SpendByOutcome
        outcomes={undefined}
        state={WidgetState.Unavailable}
        totalSpendUsd={undefined}
      />
    );

    expect(screen.getByText(UNAVAILABLE_COPY)).toBeInTheDocument();
    // The caption must not name a figure it does not have — it drops the total
    // entirely rather than claiming "$0 of session spend".
    expect(screen.queryByText(CAPTION_WITH_TOTAL)).toBeNull();
    expect(screen.getByText(CAPTION_NO_TOTAL)).toBeInTheDocument();

    rerender(
      <SpendByOutcome
        outcomes={undefined}
        state={WidgetState.Loading}
        totalSpendUsd={undefined}
      />
    );
    // Loading is a third state: neither the reason nor a claimed total.
    expect(screen.queryByText(UNAVAILABLE_COPY)).toBeNull();
  });

  it("reports a genuine zero as a measurement", () => {
    render(
      <SpendByOutcome
        outcomes={[
          outcomeRow(SpendOutcome.Clean, 0, 0),
          outcomeRow(SpendOutcome.Errored, 0, 0),
          outcomeRow(SpendOutcome.Unknown, 0, 0),
        ]}
        state={WidgetState.Ready}
        totalSpendUsd={0}
      />
    );

    // Nothing was spent IS the answer here, and it is not the unavailable case:
    // the caption still names the (zero) total it actually measured.
    expect(screen.queryByText(UNAVAILABLE_COPY)).toBeNull();
    expect(screen.getByText(CAPTION_WITH_TOTAL)).toBeInTheDocument();
  });
});
