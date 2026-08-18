/**
 * Route-gate tests for the Loops Usage page.
 *
 * Verifies that the `/[orgSlug]/loops/usage` route itself is gated by the
 * `loops-usage-page` feature flag (FEA-2713) — not just the Usage link on the
 * parent Loops page — so a user with the flag off cannot deep-link directly
 * into the Usage Dashboard.
 *
 * FEA-4228: the route now gates on `FeatureFlagRouteGate` (flag OFF ⇒
 * notFound() ⇒ the in-shell "Page not found" recovery state) rather than
 * `FeatureFlagged` with a blank `fallback={null}`. The flag-off/notFound and
 * still-resolving branches are covered directly in
 * `components/__tests__/feature-flag-route-gate.test.tsx`; this route test
 * exercises the flag-ON pass-through, asserting the page wires the correct flag
 * into the gate and renders the dashboard body.
 */

import { LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoopUsagePage from "../page";

// Stub the gate to the flag-on pass-through and keep the `data-feature-flag`
// anchor the wrapper-placement assertion reads.
vi.mock("@/components/feature-flag-route-gate", () => ({
  FeatureFlagRouteGate: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("../page-client", () => ({
  default: () => <div data-testid="loop-usage-dashboard" />,
}));

describe("LoopUsagePage route gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the dashboard behind the loops-usage-page feature flag when enabled", () => {
    render(<LoopUsagePage />);

    expect(
      screen.getByTestId("loop-usage-dashboard").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY);
  });
});
