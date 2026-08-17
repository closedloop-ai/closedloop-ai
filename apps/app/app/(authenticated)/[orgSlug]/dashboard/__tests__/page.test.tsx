import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import DashboardPage from "../page";

vi.mock("@repo/app/insights/components/insights-data-source-provider", () => ({
  WebInsightsDataSourceProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="web-insights-provider">{children}</div>
  ),
}));

vi.mock(
  "@repo/app/insights/components/overview/insights-overview-dashboard",
  () => ({
    InsightsOverviewDashboard: ({
      getSessionHref,
    }: {
      getSessionHref: (session: { id: string }) => string;
    }) => (
      <section aria-label="Insights overview">
        <h2>Recent Sessions</h2>
        <a href={getSessionHref({ id: "session-1" })}>Session one</a>
      </section>
    ),
  })
);

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <header>
      {breadcrumbs.map((breadcrumb) => breadcrumb.label).join(" / ")}
    </header>
  ),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

describe("DashboardPage a11y", () => {
  // FEA-4155: the dashboard is no longer wrapped in `<FeatureFlagged>` on the
  // winding-down `DESKTOP_AGENT_SESSION_SYNC` flag (bot review #3789) — it is the
  // first always-on nav destination and renders directly, its own empty/loading
  // states owned by InsightsOverviewDashboard. This proves no flag gate wraps the
  // body.
  it("renders the dashboard shell directly with no feature-flag gate (FEA-4155)", () => {
    render(<DashboardPage />);

    const sessionLink = screen.getByRole("link", { name: "Session one" });

    expect(screen.getByTestId("web-insights-provider")).toBeInTheDocument();
    expect(sessionLink).toHaveAttribute("href", "/acme/sessions/session-1");
    expect(
      screen.getByRole("heading", { name: "Dashboard" })
    ).toBeInTheDocument();
    expect(sessionLink.closest("[data-feature-flag]")).toBeNull();
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps the dashboard route critical a11y and contrast clean in %s theme", async (theme) => {
    const { container } = render(
      <A11yThemeRoot theme={theme}>
        <DashboardPage />
      </A11yThemeRoot>
    );

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("Recent Sessions"), {
      background: themeBackground(theme),
      label: `dashboard route ${theme}`,
    });
  });
});
