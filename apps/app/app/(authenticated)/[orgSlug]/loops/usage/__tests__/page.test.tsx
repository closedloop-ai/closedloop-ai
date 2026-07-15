/**
 * Route-gate tests for the Loops Usage page.
 *
 * Verifies that the `/[orgSlug]/loops/usage` route itself is gated by the
 * `loops-usage-page` feature flag (FEA-2713) — not just the Usage link on the
 * parent Loops page — so a user with the flag off cannot deep-link directly
 * into the Usage Dashboard.
 */

import { LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoopUsagePage from "../page";

// Control variable — updated per test to simulate the flag state.
let featureFlagEnabled = false;

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    flag,
    children,
  }: {
    flag: string;
    children: ReactNode;
  }) => (
    <div data-feature-flag={flag}>{featureFlagEnabled ? children : null}</div>
  ),
}));

vi.mock("../page-client", () => ({
  default: () => <div data-testid="loop-usage-dashboard" />,
}));

describe("LoopUsagePage route gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the dashboard behind the loops-usage-page feature flag when enabled", () => {
    featureFlagEnabled = true;

    render(<LoopUsagePage />);

    expect(
      screen.getByTestId("loop-usage-dashboard").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY);
  });

  it("does not render the dashboard when the flag is disabled (direct-route denial)", () => {
    featureFlagEnabled = false;

    render(<LoopUsagePage />);

    expect(
      screen.queryByTestId("loop-usage-dashboard")
    ).not.toBeInTheDocument();
  });
});
