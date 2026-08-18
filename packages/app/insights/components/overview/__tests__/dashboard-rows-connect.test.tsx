import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsSection } from "@repo/api/src/types/insights";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { InsightsSectionData } from "../../tile-content";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS } from "../dashboard-tiles";

const CONNECT_GITHUB_RE = /connect github/i;

// The headline-KPI ("stats") row is the one that renders the gated
// ConnectGitHubIndicator cards on the overview Dashboard.
const STATS_ROW = DASHBOARD_ROWS.find((row) => row.tour === "stats");
if (!STATS_ROW) {
  throw new Error("Expected a stats row in the dashboard catalog");
}

const EMPTY_SECTIONS: InsightsSectionData = {
  [InsightsSection.Delivery]: undefined,
  [InsightsSection.Utilization]: undefined,
  [InsightsSection.Agents]: undefined,
};

// Renders under a memory (href-store) navigation adapter — the same store the
// desktop renderer builds its production adapter on. Its <Link> intercepts
// plain left-clicks and routes them through in-app navigation rather than a
// real browser navigation: exactly the Electron behavior where a connect *link*
// is an in-app dead click that never reaches the GitHub-App connect IPC.
function renderStatsRow(props: {
  githubConnectHref?: string;
  onConnectGitHub?: () => void | Promise<void>;
}) {
  const memory = createMemoryNavigation({ initialPath: "/dashboard" });
  const result = render(
    <DashboardRowContent
      autonomySeries={undefined}
      gates={{ agentCollaborationNetwork: true }}
      getTileAvailability={() => ({ state: BranchKpiState.Gated })}
      githubConnectHref={props.githubConnectHref}
      heatmap={undefined}
      modelSeries={undefined}
      onConnectGitHub={props.onConnectGitHub}
      row={STATS_ROW as (typeof DASHBOARD_ROWS)[number]}
      sections={EMPTY_SECTIONS}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NavigationProvider adapter={memory.adapter}>
          {children}
        </NavigationProvider>
      ),
    }
  );
  return { ...result, memory };
}

describe("DashboardRowContent gated Connect GitHub CTA (FEA-3280)", () => {
  it("fires onConnectGitHub — not an in-app link navigation — when a desktop-style card supplies both href and handler", () => {
    const onConnectGitHub = vi.fn();
    const { memory } = renderStatsRow({
      githubConnectHref: "/insights",
      onConnectGitHub,
    });

    // Desktop owns an IPC connect handler; a gated card must fire it. Before the
    // fix, connectHref won precedence and the card rendered an in-app <Link>, so
    // clicking navigated inside the app (a dead click) and the handler that opens
    // the GitHub-App connect flow never ran.
    const controls = screen.getAllByRole("button", { name: CONNECT_GITHUB_RE });
    expect(controls.length).toBeGreaterThan(0);
    // No inert connect *link* should be rendered when a handler is available.
    expect(
      screen.queryByRole("link", { name: CONNECT_GITHUB_RE })
    ).not.toBeInTheDocument();

    fireEvent.click(controls[0]);

    expect(onConnectGitHub).toHaveBeenCalledTimes(1);
    // The click must NOT have triggered an in-app route change.
    expect(memory.getHistory()).toEqual(["/dashboard"]);
  });

  it("keeps the web link CTA (href-only, no handler) as a native navigation link", () => {
    renderStatsRow({ githubConnectHref: "/api/integrations/github" });

    // Web callers pass only an href (no handler); that must stay a real link so
    // OAuth keeps native navigation semantics.
    const links = screen.getAllByRole("link", { name: CONNECT_GITHUB_RE });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute("href", "/api/integrations/github");
  });
});
