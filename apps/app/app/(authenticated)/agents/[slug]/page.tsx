import type { Metadata } from "next";
import { Header } from "@/app/(authenticated)/components/header";
import { AgentDetailContainer } from "./agent-detail-container";

type AgentDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export const metadata: Metadata = {
  title: "Agent Detail",
  description: "View and edit agent details",
};

export default async function AgentDetailPage({
  params,
}: AgentDetailPageProps) {
  const { slug } = await params;

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Agents", href: "/agents" },
          { label: "Agent Detail" },
        ]}
      />
      <main className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
        <AgentDetailContainer slug={slug} />
      </main>
    </>
  );
}
