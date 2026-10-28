import { OnboardingAnalyticsPageName as Page } from "@repo/api/src/types/onboarding-analytics";
import { describe, expect, it } from "vitest";
import {
  pageNameForMarketingPath,
  pageNameForProductPath,
  pageNameForWebPath,
} from "../click-page-context";

const LOCALES = ["en", "de"];

describe("click page attribution", () => {
  it.each([
    ["/dashboard", Page.Dashboard],
    ["/sessions", Page.Sessions],
    ["/sessions/private-session", Page.SessionDetail],
    ["/branches/private-branch", Page.BranchDetail],
    ["/issues/ISS-123", Page.IssueDetail],
    ["/teams/private-team/projects/private-project", Page.ProjectDetail],
    ["/teams/private-team/projects/archived", Page.ArchivedProjects],
    ["/loops/monitoring/sessions/private-session", Page.SessionDetail],
    ["/settings?panel=account", Page.Settings],
    ["/insights/lost-work", Page.LostWork],
  ])("maps %s consistently without including identifiers", (path, expected) => {
    expect(pageNameForProductPath(path)).toBe(expected);
    expect(pageNameForWebPath(`/private-org${path}`)).toBe(expected);
  });
  it.each([
    ["/", Page.Landing],
    ["/onboarding", Page.Onboarding],
    ["/sign-in/callback", Page.SignIn],
    ["/sign-up", Page.SignUp],
    ["/private-org/not-a-real-page", Page.NotFound],
  ])("covers the web route %s", (path, expected) => {
    expect(pageNameForWebPath(path)).toBe(expected);
  });
  it.each([
    ["/", Page.Landing],
    ["/de", Page.Landing],
    ["/pricing?plan=team#faq", Page.Pricing],
    ["/blog", Page.Blog],
    ["/de/blog/private-post", Page.BlogPost],
    ["/community", Page.Community],
    ["/resources", Page.Resources],
    ["/legal/privacy", Page.PrivacyPolicy],
    ["/en/legal/terms", Page.Terms],
    ["/docs", Page.Docs],
    ["/de/docs/mechanisms/sessions", Page.Docs],
    ["/fr/pricing", Page.NotFound],
    ["/blog/private-post/extra", Page.NotFound],
  ])("maps the marketing route %s without the slug", (path, expected) => {
    expect(pageNameForMarketingPath(path, LOCALES)).toBe(expected);
  });
});
