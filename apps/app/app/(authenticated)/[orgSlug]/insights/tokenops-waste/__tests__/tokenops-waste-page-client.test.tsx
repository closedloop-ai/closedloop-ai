import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import {
  ModelVerdict,
  type TokenOpsWasteInsightsResponse,
  TokenOpsWidget,
} from "@repo/api/src/types/session-analytics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useTokenOpsWasteInsights: vi.fn() }));

vi.mock("@/hooks/queries/use-session-analytics", () => ({
  useTokenOpsWasteInsights: mocks.useTokenOpsWasteInsights,
}));

const { TokenOpsWastePageClient } = await import("../page-client");

const EXCLUDED_AMOUNT = /\$60/;
const ZERO_CONFIDENCE = /0% of spend ended in error/;
const RECOVERY_ASSUMPTION = /between 35% and 70%/i;
const ANY_UNAVAILABLE_REASON = /did not return for this range/;
const MODELS_UNAVAILABLE = /no model can be graded/i;
const OUTCOMES_UNAVAILABLE = /the outcome split cannot be shown/i;
const WASTE_UNAVAILABLE = /the recoverable share cannot be estimated/i;
/**
 * The ungraded cell NAMES the threshold it is waiting on, read off the wire.
 * "Too few sessions" leaves the reader guessing when the row starts getting a
 * verdict, so the number is what this pins.
 */
const UNGRADED_CONFIDENCE = /needs 12 sessions to grade/i;

/**
 * ISS-4988. Measured fact first, judgment second — and the three states kept
 * apart everywhere:
 *   loading             -> a skeleton reserving the real geometry
 *   settled-unavailable -> a quiet dash plus the reason it settled that way
 *   true zero           -> a real $0.00, which is a measurement
 *
 * On a screen whose subject is waste, a fabricated `$0` reads as "nothing was
 * wasted here", which is the worst thing this surface could say.
 */

function modelRow(
  overrides: Partial<TokenOpsWasteInsightsResponse["models"][number]> = {}
): TokenOpsWasteInsightsResponse["models"][number] {
  return {
    confidencePct: 18,
    errorOutcomeUsd: 36,
    medianTokens: 1_500_000,
    model: "claude-sonnet-4.6",
    sessions: 40,
    usd: 200,
    usdPerSession: 5,
    verdict: ModelVerdict.RightSized,
    ...overrides,
  };
}

/** An ungraded model OMITS confidencePct entirely — it is never `null` or `0`. */
function ungradedModelRow(): TokenOpsWasteInsightsResponse["models"][number] {
  return {
    errorOutcomeUsd: 0,
    medianTokens: 100_000,
    model: "gpt-5.4-mini",
    sessions: 4,
    usd: 12,
    usdPerSession: 3,
    verdict: ModelVerdict.Ungraded,
  };
}

function response(
  overrides: Partial<TokenOpsWasteInsightsResponse> = {}
): TokenOpsWasteInsightsResponse {
  return {
    minGradedSessions: 12,
    models: [
      modelRow(),
      modelRow({
        confidencePct: 61,
        errorOutcomeUsd: 40,
        model: "claude-haiku-4.2",
        sessions: 30,
        usd: 65,
        verdict: ModelVerdict.Underpowered,
      }),
      ungradedModelRow(),
    ],
    outcomes: [
      { outcome: SpendOutcome.Clean, sessions: 40, usd: 250 },
      { outcome: SpendOutcome.Errored, sessions: 12, usd: 180 },
      { outcome: SpendOutcome.Unknown, sessions: 5, usd: 60 },
    ],
    totalSpendUsd: 490,
    unavailableWidgets: [],
    waste: {
      errorOutcomeUsd: 180,
      excludedUnknownUsd: 60,
      highRate: 0.7,
      highUsd: 126,
      lowRate: 0.35,
      lowUsd: 63,
      sessions: 12,
    },
    ...overrides,
  };
}

function mockQuery(state: {
  data?: TokenOpsWasteInsightsResponse;
  isPending?: boolean;
  isError?: boolean;
}) {
  mocks.useTokenOpsWasteInsights.mockReturnValue({
    data: state.data,
    isError: state.isError ?? false,
    isPending: state.isPending ?? false,
  });
}

describe("tokenops screen keeps loading, unavailable and zero apart", () => {
  it("renders skeletons while the reads are in flight, and no dollar figure", () => {
    mockQuery({ isPending: true });
    const { container } = render(<TokenOpsWastePageClient />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(screen.queryByText(ANY_UNAVAILABLE_REASON)).toBeNull();
  });

  it("renders a dash with a reason, never a $0, for a widget that settled unavailable", () => {
    mockQuery({
      data: response({ unavailableWidgets: [TokenOpsWidget.Waste] }),
    });
    render(<TokenOpsWastePageClient />);

    expect(screen.getByText(WASTE_UNAVAILABLE)).toBeInTheDocument();
    // The estimate must not have collapsed to a fabricated zero.
    expect(screen.queryByText("$0 to $0")).not.toBeInTheDocument();
  });

  it("settles every widget as unavailable when the read itself failed", () => {
    mockQuery({ isError: true });
    render(<TokenOpsWastePageClient />);

    expect(screen.getByText(OUTCOMES_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByText(WASTE_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByText(MODELS_UNAVAILABLE)).toBeInTheDocument();
  });
});

describe("the recoverable-waste headline is an estimate, and says so", () => {
  it("renders a range rather than a point value", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    // A single number would read as a measurement.
    expect(screen.getByText("$63 to $126")).toBeInTheDocument();
  });

  it("states the assumption from the response rather than restating it locally", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    expect(screen.getByText(RECOVERY_ASSUMPTION)).toBeInTheDocument();
  });

  it("reports the outcome-unknown spend it deliberately excluded", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    // The excluded row is load-bearing: we cannot claim a session wasted money
    // when we never observed that it failed.
    expect(screen.getByText("Excluded")).toBeInTheDocument();
    // $60 also appears as the outcome-unknown bucket above; the point is that
    // the SAME amount is named as excluded rather than quietly folded in.
    expect(screen.getAllByText(EXCLUDED_AMOUNT).length).toBeGreaterThan(0);
  });

  it("shows the basis the estimate was built from", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    expect(screen.getByText("Basis")).toBeInTheDocument();
    expect(screen.getByText("Assumption")).toBeInTheDocument();
  });
});

describe("model right-sizing withholds a verdict it cannot support", () => {
  it("renders a dash, never 0%, for a model with too few sessions to grade", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    expect(screen.getByText(UNGRADED_CONFIDENCE)).toBeInTheDocument();
    // A `0%` here would read as "we are certain it is wrong".
    expect(screen.queryByText(ZERO_CONFIDENCE)).toBeNull();
  });

  it("renders a real $0.00 of failed spend beside a real total for that model", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    // A measured zero, so the spend the model DID incur is still a real number.
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("$12.00")).toBeInTheDocument();
  });

  it("exercises more than one verdict rather than grading every row the same", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    // A verdict column that says the same thing on every row proves nothing.
    expect(screen.getByText("Right-sized")).toBeInTheDocument();
    expect(screen.getByText("Under-powered, retry-heavy")).toBeInTheDocument();
    expect(screen.getByText("Not enough data")).toBeInTheDocument();
  });
});

describe("the outcome split keeps outcome-unknown as its own bucket", () => {
  it("renders all three outcome labels", () => {
    mockQuery({ data: response() });
    render(<TokenOpsWastePageClient />);

    // Each label renders on the bar and again in the legend beneath it.
    expect(screen.getAllByText("Ended clean").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ended with error").length).toBeGreaterThan(0);
    // Never folded into clean or errored.
    expect(screen.getAllByText("Outcome unknown").length).toBeGreaterThan(0);
  });
});
