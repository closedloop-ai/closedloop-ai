"use client";

import { WebInsightsDataSourceProvider } from "@repo/app/insights/components/insights-data-source-provider";
import { InsightsPage } from "@repo/app/insights/components/insights-page";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { getGitHubConnectUrl } from "@/lib/integration-connect-urls";

export function InsightsPageClient() {
  const orgSlug = useOrgSlug();
  const githubAuthorizeHref = getGitHubConnectUrl("authorize", {
    returnTo: `/${orgSlug}/insights`,
  });
  const githubInstallHref = getGitHubConnectUrl("install", {
    returnTo: `/${orgSlug}/insights`,
  });
  return (
    <WebInsightsDataSourceProvider
      githubAuthorizeHref={githubAuthorizeHref}
      githubInstallHref={githubInstallHref}
    >
      <InsightsPage storageNamespace={orgSlug} />
    </WebInsightsDataSourceProvider>
  );
}
