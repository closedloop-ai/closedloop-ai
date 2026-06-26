import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { Metadata } from "next";
import { Header } from "@/app/(authenticated)/components/header";
import { AgentDetailContainer } from "./agent-detail-container";

type AgentDetailPageProps = {
  params: Promise<{ orgSlug: string; slug: string }>;
};

export const metadata: Metadata = {
  title: "Agent Detail",
  description: "View and edit agent details",
};

export default async function AgentDetailPage({
  params,
}: AgentDetailPageProps) {
  const { orgSlug, slug } = await params;

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Agents", href: `/${orgSlug}/agents` },
          { label: "Agent Detail" },
        ]}
      />
      <FeatureFlagged flag="agents">
        <main className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <AgentDetailContainer slug={slug} />
        </main>
      </FeatureFlagged>
    </>
  );
}
