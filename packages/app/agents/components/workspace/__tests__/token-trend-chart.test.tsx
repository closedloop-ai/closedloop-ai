import type { ComponentVersion } from "@repo/api/src/types/agent-component";
import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  UsageMetric,
  usageMetricPresentation,
} from "../../../../insights/components/overview/usage-graph-toggles";
import { TokenTrendChart } from "../token-trend-chart";

// Mock the data hook so the chart can be exercised in isolation.
const mockUseTokenTrend = vi.fn();
vi.mock("../../../hooks/use-agent-component-token-trend", () => ({
  useAgentComponentTokenTrend: (slug: string) => mockUseTokenTrend(slug),
}));

const RE_EMPTY = /no usage recorded/i;
const RE_ERROR = /failed to load token trend/i;
const RE_METRIC = /metric/i;
const RE_GROUPING = /grouping/i;
const RE_BY_PROVIDER = /by provider/i;
const RE_CREATED = /created/i;
const RE_NO_TOKEN_DATA = /no model token usage attributed/i;
const RE_NO_COST = /no model cost attributed/i;
// ISS-5363: the third state — the producer could not compute the count at all.
const RE_UNKNOWN_USAGE = /usage for this component isn't available here/i;
/**
 * The cost toggle's accessible name, read from the SHARED presentation map
 * rather than spelled out here. ISS-4994 renamed this control "Spend" → "Cost"
 * (the toggle switches the axis to a measured API figure, not a
 * subscription-inclusive spend), and a hardcoded `/spend/i` in this test kept
 * passing right up until that rename landed on `main` and then failed on a
 * branch that had changed nothing about the toggle. Reading the label keeps the
 * two in lockstep through the next rename.
 */
const RE_COST_TOGGLE = new RegExp(
  usageMetricPresentation(UsageMetric.Cost).label,
  "i"
);

const twoModelResponse: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-opus-4-5", "gpt-5"],
  points: [
    {
      sessionId: "s1",
      sessionStartedAt: "2026-06-01T10:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.1,
      runtimeMs: 1000,
      componentInvocations: 1,
      componentErrorCount: 0,
    },
    {
      sessionId: "s3",
      sessionStartedAt: "2026-06-02T09:00:00.000Z",
      model: "gpt-5",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.05,
      runtimeMs: 2000,
      componentInvocations: 2,
      componentErrorCount: 0,
    },
  ],
};

const versions: ComponentVersion[] = [
  {
    hash: "hashB",
    source: "repo",
    format: "md",
    createdAt: "2026-06-02T00:00:00.000Z",
    isCurrent: true,
    content: "v2",
  },
  {
    hash: "hashA",
    source: "repo",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent: false,
    content: "v1",
  },
];

function mockData(data: TokenTrendResponse | undefined) {
  mockUseTokenTrend.mockReturnValue({ isLoading: false, isError: false, data });
}

describe("TokenTrendChart", () => {
  it("renders a skeleton while loading", () => {
    mockUseTokenTrend.mockReturnValue({ isLoading: true, isError: false });
    const { container } = render(
      <TokenTrendChart slug="skill::rtk" usageSessions={[]} versions={[]} />
    );
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("renders an error message on failure", () => {
    mockUseTokenTrend.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    });
    render(
      <TokenTrendChart slug="skill::rtk" usageSessions={[]} versions={[]} />
    );
    expect(screen.getByText(RE_ERROR)).toBeInTheDocument();
  });

  it("renders the empty state when there are no points", () => {
    mockData({ slug: "skill::rtk", models: [], points: [] });
    render(
      // ISS-5363: `sessions={0}` is the MEASURED zero this assertion is about.
      // Omitting it used to reach the same copy only because the component
      // coerced an unknown count to `0`; it now resolves to the honest unknown
      // state instead, which the ISS-5363 cases below cover.
      <TokenTrendChart
        sessions={0}
        slug="skill::rtk"
        usageSessions={[]}
        versions={[]}
      />
    );
    expect(screen.getByText(RE_EMPTY)).toBeInTheDocument();
  });

  it("renders the chart container plus both toggle groups when data is present", () => {
    mockData(twoModelResponse);
    const { container } = render(
      <TokenTrendChart slug="skill::rtk" usageSessions={[]} versions={[]} />
    );
    expect(screen.queryByText(RE_EMPTY)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_ERROR)).not.toBeInTheDocument();
    expect(
      container.querySelector(".recharts-responsive-container")
    ).not.toBeNull();
    // The reused dashboard toggle set: a Metric group and a Grouping group.
    expect(
      screen.getByRole("radiogroup", { name: RE_METRIC })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: RE_GROUPING })
    ).toBeInTheDocument();
  });

  it("switches the grouping from the keyboard alone", async () => {
    // ISS-5540 item 7: the switchers announce `radiogroup` now, and that role is
    // a promise about the keyboard — one tab stop, arrows to traverse, activate
    // in place. A role attribute over a control a keyboard user cannot operate
    // is the same defect wearing the right name, so this drives real key events
    // rather than clicking.
    //
    // Selection deliberately does NOT follow focus: activating a grouping
    // recomputes the series, so arrow-to-check would do that work on every
    // keypress. ARIA's radio-group pattern allows that variant, which is why
    // the sequence asserted is arrow-then-activate.
    mockData(twoModelResponse);
    const user = userEvent.setup();
    render(
      <TokenTrendChart slug="skill::rtk" usageSessions={[]} versions={[]} />
    );

    const grouping = screen.getByRole("radiogroup", { name: RE_GROUPING });
    const byProvider = within(grouping).getByRole("radio", {
      name: RE_BY_PROVIDER,
    });
    expect(byProvider).toHaveAttribute("aria-checked", "false");

    within(grouping).getAllByRole("radio")[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(byProvider).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(byProvider).toHaveAttribute("aria-checked", "true");
    // The state the keyboard changed has to reach the chart, not just the pill:
    // an `aria-checked` that flips over an unchanged series is a lying control.
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.queryByText("claude-opus-4-5")).not.toBeInTheDocument();
  });

  it("switches the series to providers when the grouping toggle is pressed", async () => {
    mockData(twoModelResponse);
    const user = userEvent.setup();
    render(
      <TokenTrendChart slug="skill::rtk" usageSessions={[]} versions={[]} />
    );

    // By model: the legend carries the raw model names.
    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: RE_BY_PROVIDER }));

    // By provider: models fold into inferred providers.
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("claude-opus-4-5")).not.toBeInTheDocument();
  });

  it("draws version-created markers on the days versions were created", () => {
    mockData(twoModelResponse);
    const { container } = render(
      <TokenTrendChart
        slug="skill::rtk"
        usageSessions={[]}
        versions={versions}
      />
    );
    // Both created days (2026-06-01, 2026-06-02) fall on rendered buckets, so
    // their reference lines render. Recharts marks reference lines with the
    // `recharts-reference-line` class.
    expect(
      container.querySelectorAll(".recharts-reference-line").length
    ).toBeGreaterThanOrEqual(2);
    // The accessible descriptions name the events for screen readers — at least
    // one reference-line <title> carries the "created" event copy.
    const titleTexts = [...container.querySelectorAll("title")].map(
      (node) => node.textContent ?? ""
    );
    expect(titleTexts.some((text) => RE_CREATED.test(text))).toBe(true);
  });
});

/**
 * ISS-4802 — the empty state must not deny usage the page has already shown.
 *
 * This chart plots PER-MODEL TOKEN usage, which is attributed at the session
 * level. A component can therefore have real invocations across real sessions
 * while none of those sessions carry a per-model token rollup. The flat "No
 * usage recorded for this component yet." then sat directly beneath a rendered
 * invocation and session count — one of the two contradicting the other.
 */
describe("TokenTrendChart empty state honesty (ISS-4802)", () => {
  it("says what is missing when the component has sessions but no token rollup", () => {
    mockData({ slug: "tool::_create_pull_request", models: [], points: [] });
    render(
      <TokenTrendChart
        sessions={7}
        slug="tool::_create_pull_request"
        usageSessions={[{ sessionId: "s1" }, { sessionId: "s2" }]}
        versions={[]}
      />
    );

    expect(screen.getByText(RE_NO_TOKEN_DATA)).toBeInTheDocument();
    // The claim it must no longer make: this component demonstrably has usage.
    expect(screen.queryByText(RE_EMPTY)).toBeNull();
  });

  /**
   * ISS-5363 (whitlockk review): `sessions ?? usageSessions.length` collapsed an
   * UNMEASURED count into the roster length, so a detail whose Sessions card
   * renders `—` printed a flat denial of usage underneath it. A count the
   * producer could not compute is neither "has sessions" nor "has none".
   */
  it("does not deny usage when the session count was never measured", () => {
    mockData({ slug: "tool::unknown-count", models: [], points: [] });
    render(
      <TokenTrendChart
        sessions={null}
        slug="tool::unknown-count"
        usageSessions={[]}
        versions={[]}
      />
    );

    expect(screen.queryByText(RE_EMPTY)).toBeNull();
    expect(screen.getByText(RE_UNKNOWN_USAGE)).toBeInTheDocument();
  });

  it("does not deny usage when a skewed payload omits the session count", () => {
    mockData({ slug: "tool::omitted-count", models: [], points: [] });
    render(
      <TokenTrendChart
        slug="tool::omitted-count"
        usageSessions={[]}
        versions={[]}
      />
    );

    expect(screen.queryByText(RE_EMPTY)).toBeNull();
    expect(screen.getByText(RE_UNKNOWN_USAGE)).toBeInTheDocument();
  });

  it("keeps the plain no-usage message when the component truly has none", () => {
    mockData({ slug: "tool::unused", models: [], points: [] });
    render(
      <TokenTrendChart
        sessions={0}
        slug="tool::unused"
        usageSessions={[]}
        versions={[]}
      />
    );

    expect(screen.getByText(RE_EMPTY)).toBeInTheDocument();
  });

  /**
   * whitlockk / bot (PR #4322): the copy was metric-blind while the chart carries a
   * $/# toggle, so a reader on $ was told no TOKEN usage was recorded — naming
   * the wrong missing thing for a component whose tokens are exactly what it
   * does have.
   */
  it("names cost, not tokens, on the $ toggle", async () => {
    const user = userEvent.setup();
    mockData({ slug: "tool::t", models: [], points: [] });
    render(
      <TokenTrendChart
        sessions={7}
        slug="tool::t"
        usageSessions={[{ sessionId: "s1" }]}
        versions={[]}
      />
    );

    await user.click(screen.getByRole("radio", { name: RE_COST_TOGGLE }));

    expect(screen.getByText(RE_NO_COST)).toBeInTheDocument();
    expect(screen.queryByText(RE_NO_TOKEN_DATA)).toBeNull();
  });

  /**
   * The predicate must key off the count the reader can SEE (the Sessions card),
   * not the `usageSessions` roster, or the contradiction ISS-4802 removed
   * reappears wherever the card is non-zero while the roster comes back empty.
   */
  it("trusts the rendered session count over an empty usage roster", () => {
    mockData({ slug: "tool::t", models: [], points: [] });
    render(
      <TokenTrendChart
        sessions={7}
        slug="tool::t"
        usageSessions={[]}
        versions={[]}
      />
    );

    expect(screen.getByText(RE_NO_TOKEN_DATA)).toBeInTheDocument();
    expect(screen.queryByText(RE_EMPTY)).toBeNull();
  });
});
