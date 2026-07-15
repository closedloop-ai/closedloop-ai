import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "../page";

const { featureFlagEnabled } = vi.hoisted(() => ({
  featureFlagEnabled: { value: true },
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    children,
    fallback,
    flag,
  }: {
    children: ReactNode;
    fallback: ReactNode;
    flag: string;
  }) => (
    <div data-feature-flag={flag}>
      {featureFlagEnabled.value ? children : fallback}
    </div>
  ),
}));

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
  beforeEach(() => {
    featureFlagEnabled.value = true;
  });

  it("renders the enabled dashboard shell through the feature gate", () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("web-insights-provider")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Session one" })).toHaveAttribute(
      "href",
      "/acme/sessions/session-1"
    );
    expect(
      screen.getByRole("heading", { name: "Dashboard" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("Session one").closest("[data-feature-flag]")
    ).toHaveAttribute(
      "data-feature-flag",
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY
    );
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps enabled dashboard route critical a11y and contrast clean in %s theme", async (theme) => {
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

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps dashboard fallback critical a11y and contrast clean in %s theme", async (theme) => {
    featureFlagEnabled.value = false;

    const { container } = render(
      <A11yThemeRoot theme={theme}>
        <DashboardPage />
      </A11yThemeRoot>
    );

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("No agent activity yet"), {
      background: themeBackground(theme),
      label: `dashboard fallback ${theme}`,
    });
  });
});
