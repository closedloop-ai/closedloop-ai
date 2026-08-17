import {
  LossClass,
  type LostWorkInsightsResponse,
  LostWorkWidget,
} from "@repo/api/src/types/session-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useLostWorkInsights: vi.fn() }));

vi.mock("@/hooks/queries/use-session-analytics", () => ({
  useLostWorkInsights: mocks.useLostWorkInsights,
}));

const { LostWorkPageClient } = await import("../page-client");
const { TOTALS_UNAVAILABLE_REASON } = await import(
  "../components/loss-attribution"
);
const { BASELINE_UNSET_REASON, PEOPLE_UNAVAILABLE_REASON } = await import(
  "../components/loss-by-person"
);

const SIX_POINTS_WORSE = /\+6 pts worse/;
const HELD_STEADY = /0 pts, held steady/;
const RATE_DENOMINATOR = /9 of 27 sessions/;
const BASELINE_VERDICT = /pts worse|pts better/;
const TOTAL_LOST = /total lost/i;
const ANY_TOTAL_COLUMN = /total/i;

/**
 * ISS-4987. The three states this screen must never conflate:
 *   loading             -> a skeleton reserving the real geometry
 *   settled-unavailable -> a quiet dash plus the reason it settled that way
 *   true zero           -> a real 0, which is a measurement
 *
 * On a screen whose entire subject is failure, a fabricated `0` reads as "no
 * problem here". Every assertion below exists to keep those three apart.
 */

function personRow(
  overrides: Partial<LostWorkInsightsResponse["people"][number]> = {}
): LostWorkInsightsResponse["people"][number] {
  return {
    actionableMinutes: 120,
    actionableRatePct: 33,
    actionableSessions: 9,
    baselineDeltaPts: 4,
    dominantCause: "Ended with error, no artifact",
    dominantCauseClass: LossClass.Actionable,
    engineer: "Dana Whitaker",
    sessionCount: 27,
    systemicMinutes: 45,
    systemicSessions: 2,
    totalMinutes: 600,
    unattributedMinutes: 0,
    unattributedSessions: 0,
    userId: "user-1",
    ...overrides,
  };
}

function response(
  overrides: Partial<LostWorkInsightsResponse> = {}
): LostWorkInsightsResponse {
  return {
    behavioralCauses: [
      {
        key: "dead_ended",
        label: "Ended with error, no artifact",
        minutes: 120,
        sessions: 3,
      },
    ],
    lostSessions: [
      {
        cause: "Usage limit",
        date: "2026-07-22",
        engineer: "Dana Whitaker",
        id: "session-1",
        lossClass: LossClass.Systemic,
        minutes: 45,
        repo: "closedloop-ai/symphony-alpha",
        title: "Org usage limit reached mid-run",
      },
    ],
    people: [personRow()],
    systemicCauses: [
      { key: "usage_limit", label: "Usage limit", minutes: 45, sessions: 2 },
    ],
    totals: {
      minutesByClass: {
        [LossClass.Actionable]: 120,
        [LossClass.Systemic]: 45,
        [LossClass.Unattributed]: 0,
      },
      productiveMinutes: 435,
      sessionCount: 27,
      sessionsByClass: {
        [LossClass.Actionable]: 9,
        [LossClass.Systemic]: 2,
        [LossClass.Unattributed]: 0,
      },
      totalMinutes: 600,
    },
    trend: [
      {
        date: "2026-07-22",
        values: {
          [LossClass.Actionable]: 2,
          [LossClass.Systemic]: 0.75,
          [LossClass.Unattributed]: 0,
        },
      },
    ],
    unavailableWidgets: [],
    ...overrides,
  };
}

function mockQuery(state: {
  data?: LostWorkInsightsResponse;
  isPending?: boolean;
  isError?: boolean;
}) {
  mocks.useLostWorkInsights.mockReturnValue({
    data: state.data,
    isError: state.isError ?? false,
    isPending: state.isPending ?? false,
  });
}

describe("lost-work screen keeps loading, unavailable and zero apart", () => {
  it("renders skeletons while the reads are in flight, and no zero", () => {
    mockQuery({ isPending: true });
    const { container } = render(<LostWorkPageClient />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length
    ).toBeGreaterThan(0);
    // A skeleton must never be accompanied by a settled figure.
    expect(
      screen.queryByText(TOTALS_UNAVAILABLE_REASON)
    ).not.toBeInTheDocument();
    expect(screen.queryByText("0.0 h")).not.toBeInTheDocument();
  });

  it("renders a dash with a reason, not a zero, for a widget that settled unavailable", () => {
    // Every other widget is emptied so the only hours that could appear on
    // screen would be ones the failed totals rollup fabricated. The other
    // rollups carry their own real measurements, which are not this test's
    // subject.
    mockQuery({
      data: response({
        behavioralCauses: [],
        lostSessions: [],
        people: [],
        systemicCauses: [],
        trend: [],
        unavailableWidgets: [LostWorkWidget.Totals],
      }),
    });
    render(<LostWorkPageClient />);

    // The reason appears on every figure the failed rollup fed.
    expect(
      screen.getAllByText(TOTALS_UNAVAILABLE_REASON).length
    ).toBeGreaterThan(0);
    // The headline must not have fallen back to a fabricated zero.
    expect(screen.queryByText("0.0 h")).not.toBeInTheDocument();
    expect(screen.queryByText("2.0 h")).not.toBeInTheDocument();
  });

  it("marks the per-engineer rollup unavailable rather than showing everyone at zero", () => {
    mockQuery({
      data: response({ unavailableWidgets: [LostWorkWidget.People] }),
    });
    render(<LostWorkPageClient />);

    expect(screen.getByText(PEOPLE_UNAVAILABLE_REASON)).toBeInTheDocument();
    // No person row rendered: the baseline verdict is unique to that table, so
    // its absence proves the rows are gone rather than showing everyone at 0.
    // (The denominator copy is NOT a usable signal here — the totals card,
    // which did load, legitimately carries the same "9 of 27 sessions".)
    expect(screen.queryByText(BASELINE_VERDICT)).not.toBeInTheDocument();
  });

  it("renders a real zero as a measurement when the read succeeded", () => {
    mockQuery({
      data: response({
        people: [
          personRow({
            actionableMinutes: 0,
            actionableRatePct: 0,
            actionableSessions: 0,
            dominantCause: "Usage limit",
            dominantCauseClass: LossClass.Systemic,
            systemicMinutes: 60,
            systemicSessions: 1,
          }),
        ],
      }),
    });
    render(<LostWorkPageClient />);

    // A genuine 0 h of coachable loss sits beside real systemic hours. Both are
    // measurements, and neither is the unavailable dash.
    expect(screen.getAllByText("0.0 h").length).toBeGreaterThan(0);
    expect(screen.getByText("1.0 h")).toBeInTheDocument();
    expect(
      screen.queryByText(PEOPLE_UNAVAILABLE_REASON)
    ).not.toBeInTheDocument();
  });
});

describe("the person table cannot be misread as a total", () => {
  it("splits the columns into two labelled groups", () => {
    mockQuery({ data: response() });
    render(<LostWorkPageClient />);

    // Structural, not a color: two spanning group headers with a rule between.
    expect(
      screen.getByRole("columnheader", { name: "Actionable, coachable" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", {
        name: "Not attributable to the engineer",
      })
    ).toBeInTheDocument();
  });

  it("offers no row total that would let the two groups be added together", () => {
    mockQuery({ data: response() });
    render(<LostWorkPageClient />);

    expect(
      screen.queryByRole("columnheader", { name: ANY_TOTAL_COLUMN })
    ).not.toBeInTheDocument();
  });

  it("carries the denominator in the same cell as the rate", () => {
    mockQuery({ data: response() });
    render(<LostWorkPageClient />);

    expect(screen.getAllByText("33%").length).toBeGreaterThan(0);
    // "33%" alone cannot start a coaching conversation.
    expect(screen.getAllByText(RATE_DENOMINATOR).length).toBeGreaterThan(0);
  });

  it("names the class of a dominant cause so it cannot read as coachable", () => {
    mockQuery({
      data: response({
        people: [
          personRow({
            dominantCause: "Usage limit",
            dominantCauseClass: LossClass.Systemic,
          }),
        ],
      }),
    });
    render(<LostWorkPageClient />);

    expect(screen.getByText("Usage limit, systemic")).toBeInTheDocument();
  });
});

describe("the anomaly column never fabricates a verdict", () => {
  it("renders a dash with a reason when the baseline half was too thin", () => {
    mockQuery({
      data: response({ people: [personRow({ baselineDeltaPts: null })] }),
    });
    render(<LostWorkPageClient />);

    expect(screen.getByText(BASELINE_UNSET_REASON)).toBeInTheDocument();
    expect(screen.queryByText(HELD_STEADY)).not.toBeInTheDocument();
  });

  it("renders a real zero delta as a finding in its own right", () => {
    mockQuery({
      data: response({ people: [personRow({ baselineDeltaPts: 0 })] }),
    });
    render(<LostWorkPageClient />);

    // Holding steady IS a finding, and is a different fact from "unknown".
    expect(screen.getByText("0 pts, held steady")).toBeInTheDocument();
    expect(screen.queryByText(BASELINE_UNSET_REASON)).not.toBeInTheDocument();
  });

  it("pairs a direction word with the color so meaning never rests on hue", () => {
    mockQuery({
      data: response({ people: [personRow({ baselineDeltaPts: 6 })] }),
    });
    render(<LostWorkPageClient />);

    expect(screen.getByText(SIX_POINTS_WORSE)).toBeInTheDocument();
  });
});

describe("there is no combined loss figure anywhere on the screen", () => {
  it("keeps systemic and unattributed under their own heading", () => {
    mockQuery({ data: response() });
    render(<LostWorkPageClient />);

    // Once as the panel heading beside the headline card, once as the person
    // table's right-hand column-group header.
    expect(
      screen.getAllByText("Not attributable to the engineer").length
    ).toBeGreaterThan(0);
  });

  it("never labels a tile as a total loss", () => {
    mockQuery({ data: response() });
    render(<LostWorkPageClient />);

    // An org-wide usage-limit day would inflate such a tile and rank whoever
    // simply worked the most that day at the top.
    expect(screen.queryByText(TOTAL_LOST)).not.toBeInTheDocument();
  });
});
