import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import LostWorkRoutePage from "../page";

/**
 * ISS-5280: this screen's per-surface UI gate is retired, so the ONLY
 * route gate left is ISS-5037's Labs container. Mirrors
 * `insights/__tests__/page.test.tsx`: the flag-off/notFound and still-resolving
 * branches are covered directly in
 * `components/__tests__/feature-flag-route-gate.test.tsx`, so the gate is
 * stubbed here to render its children while keeping the `data-feature-flag`
 * anchor the assertions read.
 */
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
  LostWorkPageClient: () => <div>Lost work QA target</div>,
}));

describe("lost-work page route", () => {
  // ISS-5037: Lost work is a Labs destination. Leaving this URL reachable while
  // the Labs nav is hidden would defeat the container gate — the addressable-
  // but-ungated hole that gate exists to close.
  it("renders the screen behind the Labs container route gate", () => {
    render(<LostWorkRoutePage />);

    expect(screen.getByText("Lost work QA target")).toBeInTheDocument();
    expect(
      screen.getByText("Lost work QA target").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", LABS_NAV_SECTION_FEATURE_FLAG_KEY);
  });

  // ISS-5280: the per-surface flag is gone, so Labs is the ONLY gate. A second
  // nested gate reappearing here would mean the retirement was reverted.
  it("wraps the screen in exactly one route gate", () => {
    const { container } = render(<LostWorkRoutePage />);

    expect(container.querySelectorAll("[data-feature-flag]")).toHaveLength(1);
  });
});
