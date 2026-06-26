import type { Metadata } from "next";
import { Header } from "@/app/(authenticated)/components/header";
import { LoopDetailContainer } from "./loop-detail-container";

type LoopDetailPageProps = {
  params: Promise<{ orgSlug: string; id: string }>;
};

export const metadata: Metadata = {
  title: "Loop Detail",
  description: "Loop execution details",
};

export default async function LoopDetailPage({ params }: LoopDetailPageProps) {
  const { orgSlug, id } = await params;

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Loops", href: `/${orgSlug}/loops` },
          { label: "Loop Detail" },
        ]}
      />
      <main className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
        <LoopDetailContainer id={id} />
      </main>
    </>
  );
}
