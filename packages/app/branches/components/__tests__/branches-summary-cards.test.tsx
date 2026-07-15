import type { BranchAnalytics } from "@repo/api/src/types/branch";
import { BranchKpiState } from "@repo/api/src/types/branch";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kpi, makeBranchAnalytics } from "../branch-analytics-fixtures";

vi.mock("../../hooks/use-branches", () => ({
  useBranchAnalytics: vi.fn(),
}));

import { useBranchAnalytics } from "../../hooks/use-branches";
import { BranchesSummaryCards } from "../branches-summary-cards";

const CONNECT_RE = /light up this metric/i;
const CONNECT_BUTTON_RE = /connect github/i;
const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

function makeAnalytics(): BranchAnalytics {
  return makeBranchAnalytics({
    mergeRate: kpi(BranchKpiState.Available, 87),
    totalSpendUsd: kpi(BranchKpiState.Available, 1234.5),
    activeBranchCount: kpi(BranchKpiState.Available, 7),
  });
}

// A branch KPI that needs GitHub enrichment → renders the connect affordance.
function makeGatedAnalytics(): BranchAnalytics {
  return makeBranchAnalytics({
    mergeRate: kpi(BranchKpiState.Gated, null),
    totalSpendUsd: kpi(BranchKpiState.Available, 1234.5),
    activeBranchCount: kpi(BranchKpiState.Available, 7),
  });
}

function mockAnalytics(data: BranchAnalytics | undefined, isError = false) {
  vi.mocked(useBranchAnalytics).mockReturnValue({
    data,
    isPending: data === undefined && !isError,
    isLoading: data === undefined && !isError,
    isError,
  } as unknown as ReturnType<typeof useBranchAnalytics>);
}

describe("BranchesSummaryCards (B6 reconciliation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only locally-computed cards and no connect-GitHub affordance", () => {
    mockAnalytics(makeAnalytics());
    render(<BranchesSummaryCards />);

    // Merge rate is available → real value, no Sample badge, no hardcoded 86.
    expect(screen.getByText("87%")).toBeInTheDocument();
    expect(screen.queryByText("86")).not.toBeInTheDocument();
    expect(screen.queryByText("Sample")).not.toBeInTheDocument();

    // FEA-2942: the merge-rate denominator is DECIDED PRs (merged + closed), not
    // opened, so the card detail must say "of decided PRs" — the old
    // "of opened PRs" copy misdescribed the metric once open PRs are excluded.
    expect(screen.getByText("of decided PRs")).toBeInTheDocument();
    expect(screen.queryByText("of opened PRs")).not.toBeInTheDocument();

    // The GitHub-free cards (FEA-2051) render real local values.
    expect(screen.getByText("$1,234.50")).toBeInTheDocument(); // AI spend
    expect(screen.getByText("7")).toBeInTheDocument(); // Active branches

    // FEA-2051: the GitHub-gated cards (Active PRs, Merged, Median time to merge)
    // are removed entirely — the row never shows the connect-GitHub affordance.
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.queryByText("Active PRs")).not.toBeInTheDocument();
    expect(screen.queryByText("Merged")).not.toBeInTheDocument();
    expect(screen.queryByText("Median time to merge")).not.toBeInTheDocument();
  });

  it("renders a live Connect GitHub CTA on a gated card and fires onConnectGitHub on click", () => {
    mockAnalytics(makeGatedAnalytics());
    const onConnectGitHub = vi.fn();
    render(<BranchesSummaryCards onConnectGitHub={onConnectGitHub} />);

    // The gated card still explains what the connect unlocks…
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
    // …and now surfaces a working CTA that fires the surface-owned handler.
    const connectButton = screen.getByRole("button", {
      name: CONNECT_BUTTON_RE,
    });
    fireEvent.click(connectButton);
    expect(onConnectGitHub).toHaveBeenCalledTimes(1);
  });

  it("keeps the gated affordance informational (no CTA) when onConnectGitHub is omitted", () => {
    mockAnalytics(makeGatedAnalytics());
    render(<BranchesSummaryCards />);

    // Web shell / handler-less callers keep the informational-only affordance:
    // the explanation shows but no connect button is rendered.
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: CONNECT_BUTTON_RE })
    ).not.toBeInTheDocument();
  });

  it("shows neutral placeholders while analytics is in flight", () => {
    mockAnalytics(undefined);
    render(<BranchesSummaryCards />);

    expect(screen.queryByText("87%")).not.toBeInTheDocument();
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps branch summary cards critical a11y and contrast clean in %s theme", async (theme) => {
    mockAnalytics(makeAnalytics());

    const { container } = render(
      <A11yThemeRoot theme={theme}>
        <BranchesSummaryCards />
      </A11yThemeRoot>
    );

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("Active branches"), {
      background: themeBackground(theme),
      label: `branch summary label ${theme}`,
    });
  });

  it.each([
    ["loading", () => mockAnalytics(undefined), "—"],
    ["error", () => mockAnalytics(undefined, true), "Unavailable"],
    ["available", () => mockAnalytics(makeAnalytics()), "Active branches"],
    [
      "unavailable",
      () =>
        mockAnalytics({
          ...makeAnalytics(),
          activeBranchCount: kpi(BranchKpiState.Unavailable, null),
        }),
      "Active branches",
    ],
    [
      "gated",
      () =>
        mockAnalytics({
          ...makeAnalytics(),
          activeBranchCount: kpi(BranchKpiState.Gated, null),
        }),
      "Active branches",
    ],
  ])("keeps branch KPI %s state a11y and contrast clean", async (_state, setup, expectedText) => {
    for (const theme of A11Y_THEMES) {
      setup();

      const { container, unmount } = render(
        <A11yThemeRoot theme={theme}>
          <BranchesSummaryCards />
        </A11yThemeRoot>
      );

      await expectCriticalAxeClean(container);
      expectElementContrast(screen.getAllByText(expectedText)[0], {
        background: themeBackground(theme),
        label: `branch summary ${_state} ${theme}`,
      });
      unmount();
    }
  });
});
