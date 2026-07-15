import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import InsightsRoutePage from "../page";

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
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
});
