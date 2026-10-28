"use client";

import { WebInsightsDataSourceProvider } from "@repo/app/insights/components/insights-data-source-provider";
import { InsightsPage } from "@repo/app/insights/components/insights-page";
import { useGitHubAuthorizeHref } from "@/hooks/use-github-authorize-href";
import { useOrgSlug } from "@/hooks/use-org-slug";

// `teamScopes` because THIS surface renders the scope selector — the only
// control that can reach the `team` aggregation scope, and therefore the only
// reason to read the org's Teams (ISS-7514). The dashboard passes no such prop.
export function InsightsPageClient() {
  const orgSlug = useOrgSlug();
  const githubAuthorizeHref = useGitHubAuthorizeHref({
    returnTo: `/${orgSlug}/insights`,
  });
  return (
    <WebInsightsDataSourceProvider
      githubAuthorizeHref={githubAuthorizeHref}
      teamScopes
    >
      <InsightsPage storageNamespace={orgSlug} />
    </WebInsightsDataSourceProvider>
  );
}
