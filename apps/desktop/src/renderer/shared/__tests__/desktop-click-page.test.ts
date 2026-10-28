import { OnboardingAnalyticsPageName as Page } from "@repo/api/src/types/onboarding-analytics";
import { describe, expect, it } from "vitest";
import { hrefForNavId, matchRoute, NavId } from "../../navigation/route-table";
import { pageNameForDesktopRoute } from "../desktop-click-page";

describe("desktop click page routing", () => {
  it.each([
    [NavId.Dashboard, Page.Dashboard],
    [NavId.Sessions, Page.Sessions],
    [NavId.Branches, Page.Branches],
    [NavId.Issues, Page.Issues],
    [NavId.Agents, Page.Agents],
    [NavId.Packs, Page.Packs],
    [NavId.Insights, Page.Insights],
    [NavId.Plans, Page.Plans],
    [NavId.Approvals, Page.Approvals],
    [NavId.Requests, Page.Requests],
    [NavId.Diagnostics, Page.Diagnostics],
    [NavId.Settings, Page.Settings],
    [NavId.Help, Page.Help],
  ])("uses the canonical page for %s", (nav, page) => {
    expect(pageNameForDesktopRoute(matchRoute(hrefForNavId(nav)))).toBe(page);
  });

  it.each([
    ["/kanban", Page.Sessions],
    ["/analytics", Page.Insights],
    ["/sessions/customer-session", Page.SessionDetail],
    ["/branches/customer-branch", Page.BranchDetail],
    ["/agents/customer-agent", Page.AgentDetail],
    ["/packs/customer-pack", Page.PackDetail],
    ["/no-such-page", Page.NotFound],
  ])("uses the route table's decision for %s", (path, page) => {
    expect(pageNameForDesktopRoute(matchRoute(path))).toBe(page);
  });
});
