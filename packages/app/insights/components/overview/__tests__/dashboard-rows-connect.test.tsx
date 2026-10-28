import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsSection } from "@repo/api/src/types/insights";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { InsightsSectionData } from "../../tile-content";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS, resolveRowTiles } from "../dashboard-tiles";

const CONNECT_GITHUB_RE = /connect (?:to )?github/i;

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
function renderStatsRow(githubConnect: GitHubConnectTarget) {
  const memory = createMemoryNavigation({ initialPath: "/dashboard" });
  const result = render(
    <DashboardRowContent
      autonomySeries={undefined}
      gates={{ agentCollaborationNetwork: true }}
      getTileAvailability={() => ({ state: BranchKpiState.Gated })}
      githubConnect={githubConnect}
      heatmap={undefined}
      modelSeries={undefined}
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
  it("fires the connect handler — not an in-app link navigation — on a desktop-style card", () => {
    const onConnectGitHub = vi.fn();
    const { memory } = renderStatsRow({
      action: GitHubConnectAction.Connect,
      onConnect: onConnectGitHub,
    });

    // Desktop owns an IPC connect handler; a gated card must fire it and render
    // no link at all. The original defect was an href winning precedence over
    // the handler, so the card rendered an in-app <Link> and clicking navigated
    // inside the app (a dead click) instead of opening the connect flow.
    // ISS-5958 M4 made that pair unrepresentable — `GitHubConnectTarget` carries
    // an href OR a handler — so what is left to prove here is that the
    // handler-only shape still renders a live button and no link.
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

  it("names the metric each connect ask belongs to (ISS-7866)", () => {
    renderStatsRow({
      action: GitHubConnectAction.Connect,
      onConnect: () => {
        // Presence of a handler is what makes the cards render live CTAs; this
        // case asserts the LABEL beside them, not the click.
      },
    });

    // Every gated card keeps its catalog title, so a reader can tell which
    // metric connecting would unlock. The regression rendered the affordance in
    // an unnamed box and dropped all five.
    for (const tile of resolveRowTiles(
      STATS_ROW as (typeof DASHBOARD_ROWS)[number]
    )) {
      expect(screen.getByText(tile.title)).toBeInTheDocument();
    }
  });

  it("keeps the web link CTA (href-only, no handler) as a native navigation link", () => {
    renderStatsRow({
      action: GitHubConnectAction.Connect,
      href: "/api/integrations/github",
    });

    // Web callers pass only an href (no handler); that must stay a real link so
    // OAuth keeps native navigation semantics.
    const links = screen.getAllByRole("link", { name: CONNECT_GITHUB_RE });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute("href", "/api/integrations/github");
  });
});
