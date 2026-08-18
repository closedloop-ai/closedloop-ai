import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import InsightsRoutePage from "../page";

// FEA-4228: the Insights ROUTE now gates on `FeatureFlagRouteGate` (flag OFF ⇒
// notFound() ⇒ the in-shell "Page not found" recovery state) rather than
// `FeatureFlagged` with a blank `fallback={null}`. The flag-off/notFound and
// still-resolving branches are covered directly in
// `components/__tests__/feature-flag-route-gate.test.tsx`; this route test
// exercises the flag-ON pass-through, so stub the gate to render its children
// and keep the `data-feature-flag` anchor the wrapper-placement assertion reads.
vi.mock("@/components/feature-flag-route-gate", () => ({
  FeatureFlagRouteGate: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("@repo/app/insights/components/insights-data-source-provider", () => ({
  WebInsightsDataSourceProvider: ({
    children,
    githubAuthorizeHref,
    githubInstallHref,
  }: {
    children: ReactNode;
    githubAuthorizeHref?: string;
    githubInstallHref?: string;
  }) => (
    <div
      data-github-authorize-href={githubAuthorizeHref}
      data-github-install-href={githubInstallHref}
      data-testid="web-insights-data-source"
    >
      {children}
    </div>
  ),
}));

vi.mock("@repo/app/insights/components/insights-page", () => ({
  InsightsPage: ({ storageNamespace }: { storageNamespace?: string }) => (
    <main>
      <h1>Insights QA target</h1>
      <p>Storage namespace: {storageNamespace}</p>
    </main>
  ),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

describe("org insights page route", () => {
  it("renders the shared Insights surface when the feature gate permits it", () => {
    render(<InsightsRoutePage />);

    expect(screen.getByText("Insights QA target")).toBeInTheDocument();
    expect(screen.getByTestId("web-insights-data-source")).toHaveAttribute(
      "data-github-authorize-href",
      "/api/integrations/github?returnTo=%2Facme%2Finsights"
    );
    expect(screen.getByTestId("web-insights-data-source")).toHaveAttribute(
      "data-github-install-href",
      "/api/integrations/github?install=true&returnTo=%2Facme%2Finsights"
    );
    expect(screen.getByText("Storage namespace: acme")).toBeInTheDocument();
    expect(
      screen.getByText("Insights QA target").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", INSIGHTS_FEATURE_FLAG_KEY);
  });

  // ISS-5037: Insights is a Labs destination, so the Labs CONTAINER gate wraps
  // the existing per-surface gate rather than replacing it — BOTH must be on.
  it("nests the Insights gate inside the Labs container route gate", () => {
    render(<InsightsRoutePage />);

    const insightsGate = screen
      .getByText("Insights QA target")
      .closest("[data-feature-flag]");
    expect(insightsGate?.parentElement).toHaveAttribute(
      "data-feature-flag",
      LABS_NAV_SECTION_FEATURE_FLAG_KEY
    );
  });
});
