import type { Metadata } from "next";
import { Header } from "@/app/(authenticated)/components/header";
import { LoopDetailContainer } from "./loop-detail-container";

type LoopDetailPageProps = {
  params: Promise<{ id: string }>;
};

export const metadata: Metadata = {
  title: "Loop Detail",
  description: "Loop execution details",
};

export default async function LoopDetailPage({ params }: LoopDetailPageProps) {
  const { id } = await params;

  return (
    <>
      <Header page="Loop Detail" pages={["Workspace", "Loops"]} />
      <main className="flex flex-1 flex-col p-4 pt-0">
        <LoopDetailContainer id={id} />
      </main>
    </>
  );
}
