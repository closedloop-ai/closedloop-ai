import { OnboardingAnalyticsPageName as Page } from "@repo/api/src/types/onboarding-analytics";
import { NavId, type RouteMatch } from "../navigation/route-table";

const NAV_PAGES = {
  [NavId.Dashboard]: Page.Dashboard,
  [NavId.Sessions]: Page.Sessions,
  [NavId.Branches]: Page.Branches,
  [NavId.Issues]: Page.Issues,
  [NavId.Documents]: Page.Documents,
  [NavId.Agents]: Page.Agents,
  [NavId.Packs]: Page.Packs,
  [NavId.Insights]: Page.Insights,
  [NavId.Plans]: Page.Plans,
  [NavId.Approvals]: Page.Approvals,
  [NavId.Requests]: Page.Requests,
  [NavId.Diagnostics]: Page.Diagnostics,
  [NavId.Settings]: Page.Settings,
  [NavId.Help]: Page.Help,
} satisfies Record<NavId, Page>;

const DETAIL_PAGES = {
  "session-detail": Page.SessionDetail,
  "branch-detail": Page.BranchDetail,
  "agent-detail": Page.AgentDetail,
  "document-detail": Page.DocumentDetail,
} satisfies Record<
  Exclude<RouteMatch["kind"], "nav" | "project-context">,
  Page
>;

export function pageNameForDesktopRoute(route: RouteMatch | null): Page {
  if (!route) {
    return Page.NotFound;
  }
  if (route.kind === "project-context") {
    if (route.projectId) {
      return Page.ProjectDetail;
    }
    return route.archived ? Page.ArchivedProjects : Page.Projects;
  }
  if (route.kind !== "nav") {
    return DETAIL_PAGES[route.kind];
  }
  if (route.navId === NavId.Packs && route.params.id) {
    return Page.PackDetail;
  }
  return NAV_PAGES[route.navId];
}
