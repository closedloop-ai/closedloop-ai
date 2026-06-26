"use client";

import { WebInsightsDataSourceProvider } from "@repo/app/insights/components/insights-data-source-provider";
import { InsightsPage } from "@repo/app/insights/components/insights-page";
import { useOrgSlug } from "@/hooks/use-org-slug";

export function InsightsPageClient() {
  const orgSlug = useOrgSlug();
  return (
    <WebInsightsDataSourceProvider>
      <InsightsPage storageNamespace={orgSlug} />
    </WebInsightsDataSourceProvider>
  );
}
