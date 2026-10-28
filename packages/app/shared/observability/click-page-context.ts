import { OnboardingAnalyticsPageName as Page } from "@repo/api/src/types/onboarding-analytics";

const ROUTES: readonly (readonly [string, Page])[] = [
  ["/", Page.Dashboard],
  ["/sessions", Page.Sessions],
  ["/sessions/:id", Page.SessionDetail],
  ["/branches", Page.Branches],
  ["/branches/:id", Page.BranchDetail],
  ["/agents", Page.Agents],
  ["/agents/:id", Page.AgentDetail],
  ["/packs", Page.Packs],
  ["/packs/:id", Page.PackDetail],
  ["/issues", Page.Issues],
  ["/issues/:id", Page.IssueDetail],
  ["/documents", Page.Documents],
  ["/documents/:id", Page.DocumentDetail],
  ["/prds/:id", Page.PrdDetail],
  ["/implementation-plans/:id", Page.ImplementationPlanDetail],
  ["/teams/:team/projects", Page.Projects],
  ["/teams/:team/projects/archived", Page.ArchivedProjects],
  ["/teams/:team/projects/:id", Page.ProjectDetail],
  ["/users/:id", Page.UserDetail],
  ["/loops/monitoring/sessions/:id", Page.SessionDetail],
  ["/build/:id", Page.Build],
  ["/insights", Page.Insights],
  ["/insights/lost-work", Page.LostWork],
  ["/insights/tokenops-waste", Page.TokenOpsWaste],
  ["/judges-analytics", Page.JudgesAnalytics],
  ["/judges-analytics/:metric", Page.JudgeMetric],
  ["/admin/catalog", Page.Catalog],
  ["/settings/integrations/desktop/connect", Page.DesktopConnect],
  ["/settings/integrations/desktop/authorize", Page.DesktopAuthorize],
  ["/dashboard", Page.Dashboard],
  ["/inbox", Page.Inbox],
  ["/my-issues", Page.Issues],
  ["/my-tasks", Page.MyTasks],
  ["/approvals", Page.Approvals],
  ["/requests", Page.Requests],
  ["/plans", Page.Plans],
  ["/diagnostics", Page.Diagnostics],
  ["/help", Page.Help],
  ["/search", Page.Search],
];

const ROUTE_PARTS = routeParts(ROUTES);

/** Returns only canonical names; org slugs, ids and query strings never leave the client. */
export function pageNameForProductPath(path: string): Page {
  const parts = pathParts(path);
  const route = matchRoute(ROUTE_PARTS, parts);
  if (route) {
    return route;
  }
  if (parts[0] === "settings") {
    return Page.Settings;
  }
  return Page.NotFound;
}

export function pageNameForWebPath(path: string): Page {
  const parts = path.split("?")[0].split("/").filter(Boolean);
  switch (parts[0]) {
    case undefined:
      return Page.Landing;
    case "sign-in":
      return Page.SignIn;
    case "sign-up":
      return Page.SignUp;
    case "sso-callback":
      return Page.SsoCallback;
    case "onboarding":
      return Page.Onboarding;
    case "connect":
      return Page.GitHubConnect;
    case "sessions":
    case "loops":
    case "settings":
      return pageNameForProductPath(path);
    default:
      return pageNameForProductPath(`/${parts.slice(1).join("/")}`);
  }
}

const MARKETING_ROUTE_PARTS = routeParts([
  ["/", Page.Landing],
  ["/pricing", Page.Pricing],
  ["/blog", Page.Blog],
  ["/blog/:slug", Page.BlogPost],
  ["/community", Page.Community],
  ["/resources", Page.Resources],
  ["/legal/privacy", Page.PrivacyPolicy],
  ["/legal/terms", Page.Terms],
]);

/** Marketing and `/docs` paths, with or without a leading locale segment. */
export function pageNameForMarketingPath(
  path: string,
  locales: readonly string[]
): Page {
  const parts = pathParts(path);
  const unlocalized = locales.includes(parts[0] ?? "") ? parts.slice(1) : parts;
  if (unlocalized[0] === "docs") {
    return Page.Docs;
  }
  return matchRoute(MARKETING_ROUTE_PARTS, unlocalized) ?? Page.NotFound;
}

type RouteParts = { parts: string[]; page: Page };

function routeParts(
  routes: readonly (readonly [string, Page])[]
): RouteParts[] {
  return routes.map(([path, page]) => ({ parts: pathParts(path), page }));
}

function pathParts(path: string): string[] {
  return path.split("?")[0].split("#")[0].split("/").filter(Boolean);
}

function matchRoute(
  routes: readonly RouteParts[],
  parts: readonly string[]
): Page | undefined {
  return routes.find(
    (candidate) =>
      candidate.parts.length === parts.length &&
      candidate.parts.every(
        (part, index) => part.startsWith(":") || part === parts[index]
      )
  )?.page;
}
