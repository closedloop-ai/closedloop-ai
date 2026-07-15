import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Metadata } from "next";
import { Header } from "@/app/(authenticated)/components/header";
import { AgentDetailWithPromote } from "./agent-detail-with-promote";

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
          { label: slug },
        ]}
      />
      <FeatureFlagged flag={AGENTS_FEATURE_FLAG_KEY}>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <AgentDetailWithPromote slug={slug} />
        </main>
      </FeatureFlagged>
    </>
  );
}
