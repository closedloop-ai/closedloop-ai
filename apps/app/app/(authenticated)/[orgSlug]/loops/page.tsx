import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import type { Metadata } from "next";
import { Header } from "../../components/header";
import { LoopsTable } from "./components/loops-table";

export const metadata: Metadata = {
  title: "Loops",
  description: "View all AI agent execution loops",
};

export default async function LoopsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Loops" }]} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-bold text-2xl">Loops</h1>
            <p className="text-muted-foreground">
              Track AI agent executions across your organization
            </p>
          </div>
          <div className="flex items-center gap-2">
            <FeatureFlagged flag={LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY}>
              <Button asChild variant="outline">
                <Link href={`/${orgSlug}/loops/usage`}>Usage</Link>
              </Button>
            </FeatureFlagged>
            <FeatureFlagged flag="desktop-agent-session-sync">
              <Button asChild variant="outline">
                <Link href={`/${orgSlug}/loops/monitoring`}>
                  Agent Monitoring
                </Link>
              </Button>
            </FeatureFlagged>
          </div>
        </div>
        <LoopsTable />
      </div>
    </div>
  );
}
