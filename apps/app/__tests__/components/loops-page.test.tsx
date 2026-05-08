/**
 * Unit tests for the LoopsPage component.
 * Verifies that the Usage link is gated by the "loops-usage-page" feature flag.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Control variable — updated per test to simulate the flag state.
let featureFlagEnabled = false;

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    children,
  }: {
    flag: string;
    children: React.ReactNode;
  }) => (featureFlagEnabled ? children : null),
}));

vi.mock("@/app/(authenticated)/loops/components/loops-table", () => ({
  LoopsTable: () => <div data-testid="loops-table" />,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div data-testid="header" />,
}));

import LoopsPage from "@/app/(authenticated)/loops/page";

describe("LoopsPage — Usage link feature flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Usage link when the loops-usage-page flag is enabled", () => {
    featureFlagEnabled = true;

    render(<LoopsPage />);

    expect(screen.getByRole("link", { name: "Usage" })).toBeInTheDocument();
  });

  it("does not render the Usage link when the loops-usage-page flag is disabled", () => {
    featureFlagEnabled = false;

    render(<LoopsPage />);

    expect(
      screen.queryByRole("link", { name: "Usage" })
    ).not.toBeInTheDocument();
  });
});
