import type { LostWorkCauseRow } from "@repo/api/src/types/session-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BEHAVIORAL_CAUSES_UNAVAILABLE_REASON,
  CAUSE_FALLBACK_BASIS_NOTE,
  LossCauses,
  SYSTEMIC_CAUSES_UNAVAILABLE_REASON,
} from "../components/loss-causes";

/**
 * The two cause columns (ISS-4987). Raised in review (comment 3710879604): this
 * is the one widget on the screen whose failure mode is WRONG NUMBERS rather
 * than wrong layout — `resolveDenominator` swaps the class total for the
 * on-screen row sum when the totals rollup misses, which changes what every
 * percentage in the column means.
 *
 * The per-column states also cannot be reached together from one fixture: you
 * need a throttle-source rollup that failed while the behavioral one succeeded.
 */

const EMPTY_COPY = /no loss of this kind was recorded in range/i;

function causeRow(overrides: Partial<LostWorkCauseRow> = {}): LostWorkCauseRow {
  return {
    key: "usage_limit",
    label: "Usage limit",
    minutes: 60,
    sessions: 3,
    ...overrides,
  };
}

const SYSTEMIC_ROWS: LostWorkCauseRow[] = [
  causeRow(),
  causeRow({ key: "api_error", label: "Provider API error", minutes: 40 }),
];

const BEHAVIORAL_ROWS: LostWorkCauseRow[] = [
  causeRow({ key: "abandoned", label: "Abandoned mid-run", minutes: 30 }),
];

describe("the loss-cause columns", () => {
  it("ranks against the class total without a basis note when the totals rollup loaded", () => {
    render(
      <LossCauses
        behavioralCauses={BEHAVIORAL_ROWS}
        behavioralClassMinutes={120}
        loading={false}
        systemicCauses={SYSTEMIC_ROWS}
        systemicClassMinutes={200}
      />
    );

    // Ranked against 200, not against the 100 on screen: "Usage limit" is 30%
    // of the class, and that is what reconciles with the strip above.
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.queryByText(CAUSE_FALLBACK_BASIS_NOTE)).toBeNull();
  });

  it("says so when the percentages fall back to the rows on screen", () => {
    render(
      <LossCauses
        behavioralCauses={BEHAVIORAL_ROWS}
        behavioralClassMinutes={120}
        loading={false}
        systemicCauses={SYSTEMIC_ROWS}
        systemicClassMinutes={null}
      />
    );

    // Same rows, different denominator (100, the row sum), so the same cause is
    // now 60%. That is a different question than the heading claims, so the
    // basis has to be stated rather than swapped silently.
    expect(screen.getByText("60%")).toBeInTheDocument();
    const notes = screen.getAllByText(CAUSE_FALLBACK_BASIS_NOTE);
    // Only the column that actually fell back discloses it.
    expect(notes).toHaveLength(1);
  });

  it("keeps the two columns' states independent", () => {
    // The hard case to reach for real: the throttle-source rollup failed while
    // the behavioral one succeeded.
    render(
      <LossCauses
        behavioralCauses={BEHAVIORAL_ROWS}
        behavioralClassMinutes={120}
        loading={false}
        systemicCauses={null}
        systemicClassMinutes={null}
      />
    );

    expect(
      screen.getByText(SYSTEMIC_CAUSES_UNAVAILABLE_REASON)
    ).toBeInTheDocument();
    expect(screen.queryByText(BEHAVIORAL_CAUSES_UNAVAILABLE_REASON)).toBeNull();
    // The surviving column still renders its ranking rather than being blanked
    // by its neighbour's failure.
    expect(screen.getByText("Abandoned mid-run")).toBeInTheDocument();
    // An unavailable column must not also claim a fallback basis — it has no
    // rows to rank at all.
    expect(screen.queryByText(CAUSE_FALLBACK_BASIS_NOTE)).toBeNull();
  });

  it("distinguishes a column with no loss from a column that failed to load", () => {
    render(
      <LossCauses
        behavioralCauses={BEHAVIORAL_ROWS}
        behavioralClassMinutes={120}
        loading={false}
        systemicCauses={[]}
        systemicClassMinutes={0}
      />
    );

    // "No loss of this kind" is a finding — the platform caused nothing — and
    // must not read the same as "the rollup did not load".
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText(SYSTEMIC_CAUSES_UNAVAILABLE_REASON)).toBeNull();
  });

  it("shows neither empty copy nor a basis note while still loading", () => {
    render(
      <LossCauses
        behavioralCauses={null}
        behavioralClassMinutes={null}
        loading={true}
        systemicCauses={null}
        systemicClassMinutes={null}
      />
    );

    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    expect(screen.queryByText(CAUSE_FALLBACK_BASIS_NOTE)).toBeNull();
    expect(screen.queryByText(SYSTEMIC_CAUSES_UNAVAILABLE_REASON)).toBeNull();
  });
});
