import type { Metadata } from "next";
import { Header } from "@/app/(authenticated)/components/header";
import { WorkstreamDetailContainer } from "./workstream-detail-container";

type WorkstreamPageProps = {
  params: Promise<{ id: string }>;
};

export const metadata: Metadata = {
  title: "Workstream | ClosedLoop.ai",
  description: "Workstream details",
};

export default async function WorkstreamPage({ params }: WorkstreamPageProps) {
  const { id } = await params;

  return (
    <>
      <Header page="Workstream" pages={["Workstreams", "Details"]} />
      <main className="flex flex-1 flex-col p-4 pt-0">
        <WorkstreamDetailContainer id={id} />
      </main>
    </>
  );
}
